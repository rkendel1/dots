import { expect, it, vi } from 'vitest';
import { memoryWorkspace } from './helpers/workspace.js';
import { PageService } from '../src/server/page-service.js';
import { pageAccess } from '../src/server/page-tools.js';
it('reuses one actual Intelligence thread per page and Dot under concurrent requests', async () => {
  const ws = await memoryWorkspace();
  const dot = (await ws.store.dots())[0]!;
  const page = await ws.store.pages.create(dot.spaceId, { title: 'Design' });
  const getOrCreateThread = vi.fn(async () => {});
  const sdk = {
    getOrCreateThread,
    getThreadMessages: async () => ({ messages: [] }),
  };
  const service = new PageService(ws.store, () => sdk);
  const [a, b] = await Promise.all([
    service.conversation(dot.spaceId, page.id, dot.id),
    service.conversation(dot.spaceId, page.id, dot.id),
  ]);
  expect(a.id).toBe(b.id);
  expect(getOrCreateThread).toHaveBeenCalledTimes(1);
  expect((await service.conversation(dot.spaceId, page.id, dot.id)).id).toBe(
    a.id,
  );
  expect((await ws.store.pages.forThread(a.id, dot.spaceId))?.id).toBe(page.id);
  ws.state.close();
});
it('exports canonical user/assistant text and rejects failed or oversized history without creating a page', async () => {
  const ws = await memoryWorkspace();
  const dot = (await ws.store.dots())[0]!;
  await ws.store.bindThread('thread', dot.id, 'Thread');
  const getThreadMessages = vi.fn(async () => ({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Question' }] },
      { role: 'assistant', content: 'Answer' },
      { role: 'tool', content: 'Secret tool response' },
    ],
  }));
  const service = new PageService(ws.store, () => ({
    getOrCreateThread: async () => {},
    getThreadMessages,
  }));
  const page = await service.saveConversation('thread', 'Saved', null);
  expect(page.content).toBe('## You\n\nQuestion\n\n## Dot\n\nAnswer');
  expect(page.sourceThreadId).toBe('thread');
  getThreadMessages.mockRejectedValueOnce(new Error('Offline'));
  await expect(
    service.saveConversation('thread', 'Failure', null),
  ).rejects.toThrow();
  getThreadMessages.mockResolvedValueOnce({
    messages: [{ role: 'assistant', content: 'x'.repeat(100001) }],
  });
  await expect(
    service.saveConversation('thread', 'Too long', null),
  ).rejects.toThrow(/exceeds/);
  expect(await ws.store.pages.list(dot.spaceId)).toHaveLength(1);
  ws.state.close();
});

it('scopes agent tools to the Dot Space and re-reads current context with CAS and pause enforcement', async () => {
  const ws = await memoryWorkspace();
  const dot = (await ws.store.dots())[0]!;
  const other = await ws.store.createSpace('Other', '');
  const foreign = await ws.store.pages.create(other.id, { title: 'Private' });
  const page = await ws.store.pages.create(dot.spaceId, { title: 'Here' });
  await ws.store.bindThread('thread', dot.id, 'Page');
  await ws.store.pages.reserveThread(page.id, dot.id, 'thread');
  await ws.store.pages.finishThread(page.id, dot.id);
  let paused = false;
  const access = await pageAccess(ws.store, dot.spaceId, 'thread', () => {
    if (paused) throw new Error('Paused');
  });
  await expect(access.read(foreign.id)).rejects.toThrow();
  await access.edit(page.id, { expectedRevision: 1, content: 'Fresh' });
  expect((await access.context())?.content).toBe('Fresh');
  await expect(
    access.edit(page.id, { expectedRevision: 1, content: 'Stale' }),
  ).rejects.toThrow();
  paused = true;
  await expect(access.create({ title: 'No write' })).rejects.toThrow('Paused');
  expect(await ws.store.pages.list(dot.spaceId)).toHaveLength(1);
  ws.state.close();
});
it('recovers the same reserved thread after a restart lease and a remote-success retry', async () => {
  const ws = await memoryWorkspace();
  const dot = (await ws.store.dots())[0]!;
  const page = await ws.store.pages.create(dot.spaceId, { title: 'Recover' });
  ws.store.pages.reserveThread(page.id, dot.id, 'stable-thread');
  const sdk = {
    getOrCreateThread: vi.fn(async () => {}),
    getThreadMessages: async () => ({ messages: [] }),
  };
  const service = new PageService(ws.store, () => sdk);
  await expect(
    service.conversation(dot.spaceId, page.id, dot.id),
  ).rejects.toThrow(/being created/);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
  const result = await service.conversation(dot.spaceId, page.id, dot.id);
  expect(result.id).toBe('stable-thread');
  expect(sdk.getOrCreateThread).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: 'stable-thread',
      userId: 'owner',
      agentId: dot.id,
    }),
  );
  vi.restoreAllMocks();
  ws.state.close();
});
it('rejects a specialist in another Space before Intelligence is accessed', async () => {
  const ws = await memoryWorkspace();
  const dot = (await ws.store.dots())[0]!;
  const space = await ws.store.createSpace('Other', '');
  const page = await ws.store.pages.create(space.id, { title: 'Other' });
  const getSdk = vi.fn(() => {
    throw new Error('Should not contact provider');
  });
  const service = new PageService(ws.store, getSdk);
  await expect(service.conversation(space.id, page.id, dot.id)).rejects.toThrow(
    /specialist in this Space/,
  );
  expect(getSdk).not.toHaveBeenCalled();
  ws.state.close();
});
it('retries a failed provider creation with the same canonical reserved ID', async () => {
  const ws = await memoryWorkspace();
  const dot = (await ws.store.dots())[0]!;
  const page = await ws.store.pages.create(dot.spaceId, { title: 'Retry' });
  const getOrCreateThread = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new Error('Remote response lost'));
  const service = new PageService(ws.store, () => ({
    getOrCreateThread,
    getThreadMessages: async () => ({ messages: [] }),
  }));
  await expect(
    service.conversation(dot.spaceId, page.id, dot.id),
  ).rejects.toThrow('Remote response lost');
  const reserved = (await ws.store.pages.thread(page.id, dot.id))!.threadId;
  const thread = await service.conversation(dot.spaceId, page.id, dot.id);
  expect(thread.id).toBe(reserved);
  expect(getOrCreateThread).toHaveBeenCalledTimes(2);
  ws.state.close();
});

it('grants multiple Spaces without changing thread identity and enforces revocation on existing tools', async () => {
  const ws = await memoryWorkspace();
  const dot = (await ws.store.dots())[0]!;
  const other = await ws.store.createSpace('Launch', '');
  const page = await ws.store.pages.create(other.id, { title: 'Brief' });
  await ws.store.updateDot(dot.id, {
    ...dot,
    spaceIds: [dot.spaceId, other.id],
  });
  const service = new PageService(ws.store, () => ({
    getOrCreateThread: async () => {},
    getThreadMessages: async () => ({
      messages: [{ role: 'assistant', content: 'Saved text' }],
    }),
  }));
  const thread = await service.conversation(other.id, page.id, dot.id);
  const access = await pageAccess(ws.store, dot.spaceId, thread.id, () => {});
  expect((await access.context())?.id).toBe(page.id);
  expect((await access.read(page.id)).title).toBe('Brief');
  expect(await access.spaces()).toHaveLength(2);
  expect(
    (await service.saveConversation(thread.id, 'Copy', null)).spaceId,
  ).toBe(other.id);
  await ws.store.updateDot(dot.id, { ...dot, spaceIds: [dot.spaceId] });
  await expect(access.read(page.id, other.id)).rejects.toThrow(/access/);
  await expect(
    access.edit(page.id, { expectedRevision: 1, content: 'No' }, other.id),
  ).rejects.toThrow(/access/);
  await expect(
    service.conversation(other.id, page.id, dot.id),
  ).rejects.toThrow();
  await expect(service.saveConversation(thread.id, 'No', null)).rejects.toThrow(
    /revoked/,
  );
  await ws.store.updateDot(dot.id, {
    ...dot,
    spaceIds: [dot.spaceId, other.id],
  });
  expect((await service.conversation(other.id, page.id, dot.id)).id).toBe(
    thread.id,
  );
  ws.state.close();
});
