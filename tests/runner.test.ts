import { afterEach, expect, it, vi } from 'vitest';
import { Runner } from '../src/server/runner.js';
import { research, type Config } from '../src/server/research.js';
import { memoryStore, type OpenStore } from './helpers/store.js';
const handles: OpenStore[] = [];
function fixtureStore() {
  const handle = memoryStore();
  handles.push(handle);
  return handle.store;
}
const config: Config = {
  mode: 'live',
  apiKey: 'test',
  model: 'test',
  browserUrl: 'http://browser:4311',
  browserSecret: 'test',
  baseUrl: 'https://model.example/v1',
};
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  vi.unstubAllGlobals();
});
it('aborts research when permissions are revoked outside the runner instance', async () => {
  const store = fixtureStore();
  const runner = new Runner(store, config);
  let requestSignal: AbortSignal | undefined;
  const request = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        requestSignal = options.signal ?? undefined;
        requestSignal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', request);
  await store.createTask('Read https://example.com');
  const tick = runner.tick();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  await store.updateSettings({ memoryAllowed: false });
  await tick;
  expect(requestSignal?.aborted).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  expect((await store.tasks())[0]!.status).toBe('queued');
  await runner.stop();
});
it('checks abort again before sending source evidence or memories to the model', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      title: 'Source',
      text: 'Page text',
      url: 'https://example.com',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await expect(
    research(
      'Read https://example.com',
      [],
      config,
      controller.signal,
      (text) => {
        if (text.startsWith('Source captured')) controller.abort();
      },
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it('omits stored memories from research when memory permission is disabled', async () => {
  const store = fixtureStore();
  await store.saveMemory('Sensitive preference');
  await store.updateSettings({ memoryAllowed: false });
  const task = await store.createTask('Read this sample');
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  await runner.tick();
  expect((await store.detail(task.id))?.runs[0]?.result?.text).not.toContain(
    'Sensitive preference',
  );
});
it('requeues active work on graceful shutdown instead of losing it', async () => {
  const store = fixtureStore();
  const runner = new Runner(store, config);
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) =>
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  await store.createTask('Read https://example.com');
  const pending = runner.tick();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await runner.stop();
  await pending;
  expect((await store.tasks())[0]!.status).toBe('queued');
  expect(await store.claim()).toBeTruthy();
});
