import { expect, it } from 'vitest';
import { validateRuntimeScope } from '../src/server/runtime-scope.js';
import { memoryWorkspace } from './helpers/workspace.js';
import { setupStatus } from '../src/server/platform-config.js';
import {
  EnvironmentCredentials,
  intelligenceStatus,
} from '../src/server/intelligence.js';
it('blocks unbound cross-Dot run and inspector routes before contacting Intelligence', async () => {
  const store = await memoryWorkspace();
  const dot = (await store.store.dots())[0]!;
  await store.store.bindThread('thread-a', dot.id, 'A');
  await expect(
    validateRuntimeScope(
      new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
        method: 'POST',
      }),
      store.store,
      { threadId: 'other-owner' },
    ),
  ).rejects.toThrow();
  await expect(
    validateRuntimeScope(
      new Request('http://localhost/api/copilotkit/inspect/threads/foreign'),
      store.store,
      null,
    ),
  ).rejects.toThrow();
  await expect(
    validateRuntimeScope(
      new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
        method: 'POST',
      }),
      store.store,
      { threadId: 'thread-a' },
    ),
  ).resolves.toBeUndefined();
  store.state.close();
});
it('reports setup honestly and never asks for the CopilotKit hosted-service key', () => {
  const status = setupStatus(
    { voiceName: 'marin', runtimeUrl: '' },
    intelligenceStatus({}, new EnvironmentCredentials({})),
  );
  expect(status.intelligence).toBe(false);
  expect(status.voice).toBe(false);
  expect(status.missing).toContain('Intelligence provider');
  expect(status.missing).not.toContain('INTELLIGENCE_API_KEY');
});
it('rejects stop scope bypasses and misleading prefixes while allowing canonical owned routes', async () => {
  const store = await memoryWorkspace();
  const dot = (await store.store.dots())[0]!;
  await store.store.bindThread('bound', dot.id, 'Bound');
  for (const path of [
    `/agent/${dot.id}/stop/foreign`,
    '/threads/bound/threads/foreign/messages',
    `/agent/${dot.id}/agent/foreign/run`,
    '/prefix/info',
    '/threads//bound/messages',
    '/threads/bound%2Fthreads%2Fforeign/messages',
  ]) {
    await expect(
      validateRuntimeScope(
        new Request(`http://localhost/api/copilotkit${path}`, {
          method: 'POST',
        }),
        store.store,
        { threadId: 'bound' },
      ),
    ).rejects.toThrow();
  }
  await expect(
    validateRuntimeScope(
      new Request(
        `http://localhost/api/copilotkit/agent/${dot.id}/stop/bound`,
        { method: 'POST' },
      ),
      store.store,
      {},
    ),
  ).resolves.toBeUndefined();
  await expect(
    validateRuntimeScope(
      new Request('http://localhost/api/copilotkit/threads/bound/messages'),
      store.store,
      null,
    ),
  ).resolves.toBeUndefined();
  store.state.close();
});
