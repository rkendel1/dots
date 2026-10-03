import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { memoryWorkspace, fileWorkspace } from './helpers/workspace.js';
import { learningSelector } from '../src/server/learning.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
async function fixture() {
  const ws = await memoryWorkspace();
  cleanup.push(() => ws.state.close());
  const dot = (await ws.store.dots())[0]!;
  return { ws, dot };
}
const input = (threadId: string): RunAgentInput => ({
  threadId,
  runId: 'run',
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
});

it('freezes container assignments, including disabled conversations, when a Dot changes', async () => {
  const { ws, dot } = await fixture();
  await ws.store.bindThread('disabled', dot.id, 'Before learning');
  await ws.store.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  await ws.store.bindThread('research', dot.id, 'Research');
  await ws.store.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'writing',
    skillDeliveryEnabled: true,
  });
  await ws.store.bindThread('writing', dot.id, 'Writing');
  expect(
    (await ws.store.requireThread('disabled')).learningContainerId,
  ).toBeNull();
  expect((await ws.store.requireThread('research')).learningContainerId).toBe(
    'research',
  );
  expect((await ws.store.requireThread('writing')).learningContainerId).toBe(
    'writing',
  );
  await ws.store.updateDot(dot.id, {
    ...dot,
    learningContainerId: null,
    skillDeliveryEnabled: false,
  });
  expect((await ws.store.requireThread('research')).learningContainerId).toBe(
    'research',
  );
});

it('persists thread bindings and Dot Learning configuration across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-learning-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state');
  const first = fileWorkspace(path);
  await first.store.bootstrap();
  const dot = (await first.store.dots())[0]!;
  await first.store.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  await first.store.bindThread('new', dot.id, 'New');
  first.close();
  const reopened = fileWorkspace(path);
  cleanup.push(() => {
    reopened.close();
  });
  expect((await reopened.store.requireThread('new')).learningContainerId).toBe(
    'research',
  );
  expect(await reopened.store.dot(dot.id)).toMatchObject({
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
});

it('selects only owned web threads and binds the configured channel Dot before its first run', async () => {
  const { ws, dot } = await fixture();
  await ws.store.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  await ws.store.bindThread('web', dot.id, 'Web');
  const select = learningSelector(ws.store, dot.id);
  const user = { id: 'owner', name: 'Owner' };
  await expect(
    select({ surface: 'web', user, agentId: dot.id, input: input('web') }),
  ).resolves.toBe('research');
  await expect(
    select({ surface: 'web', user, agentId: dot.id, input: input('unknown') }),
  ).rejects.toThrow();
  await expect(
    select({
      surface: 'channel',
      user,
      agentId: dot.id,
      input: input('slack'),
    }),
  ).resolves.toBe('research');
  expect(
    (await ws.store.requireThread('slack', dot.id)).learningContainerId,
  ).toBe('research');
  await expect(
    select({
      surface: 'channel',
      user: null,
      agentId: dot.id,
      input: input('unauthorized'),
    }),
  ).rejects.toThrow();
  await expect(
    select({
      surface: 'web',
      user: { id: 'other', name: 'Other' },
      agentId: dot.id,
      input: input('web'),
    }),
  ).rejects.toThrow();
  const other = await ws.store.createDot(
    dot.spaceId,
    'Other',
    'Other role',
    true,
    true,
  );
  await expect(
    select({
      surface: 'channel',
      user,
      agentId: other.id,
      input: input('wrong-dot'),
    }),
  ).rejects.toThrow();
  await expect(
    select({ surface: 'web', user, agentId: other.id, input: input('web') }),
  ).rejects.toThrow();
  expect(await ws.store.conversations()).toHaveLength(2);
});

it('rejects invalid container IDs and delivery without a container', async () => {
  const { ws, dot } = await fixture();
  for (const learningContainerId of [
    '',
    'Upper',
    'two--hyphens',
    '-leading',
    'trailing-',
    'a'.repeat(65),
  ]) {
    await expect(
      ws.store.updateDot(dot.id, { ...dot, learningContainerId }),
    ).rejects.toThrow();
  }
  await expect(
    ws.store.updateDot(dot.id, {
      ...dot,
      learningContainerId: null,
      skillDeliveryEnabled: true,
    }),
  ).rejects.toThrow();
  expect((await ws.store.dot(dot.id))?.learningContainerId).toBeNull();
});
