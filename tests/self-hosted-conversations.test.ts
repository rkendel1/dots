import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { Platform } from '../src/server/platform.js';
import { ConfigurationService } from '../src/server/configuration.js';
import {
  EnvironmentCredentials,
  IntelligenceService,
} from '../src/server/intelligence.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';
import { memoryStore, type OpenStore } from './helpers/store.js';
import {
  fileWorkspace,
  memoryWorkspace,
  type FileWorkspace,
} from './helpers/workspace.js';
import { testPlatformConfig } from './helpers/intelligence.js';

const PROVIDER = 'https://provider.invalid/v1';
const KEY = 'sk-provider-key-0123456789';
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});

/** Start OpenDots' conversation platform over a durable state directory. */
async function start(dir: string) {
  const workspace: FileWorkspace = fileWorkspace(join(dir, 'state'));
  await workspace.store.bootstrap();
  const store: OpenStore = memoryStore();
  const configuration = new ConfigurationService(
    workspace.state.db,
    workspace.store.ownerId,
    new EnvironmentCredentials({ OPENAI_API_KEY: KEY }),
    {},
  );
  const intelligence = new IntelligenceService(
    configuration,
    configuration.credentials,
    {},
  );
  const platform = await Platform.create(
    store.store,
    workspace.store,
    testPlatformConfig,
    intelligence,
  );
  const stop = () => {
    store.close();
    workspace.close();
  };
  cleanup.push(stop);
  return { platform, workspace, configuration, stop };
}

function durableDir() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-conversations-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stub only the model provider; everything on the OpenDots side is real. */
function provider(...replies: Array<Response | (() => Response)>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (!String(input).startsWith(PROVIDER))
      throw new Error(`Unexpected fetch ${input}`);
    const next = replies.shift();
    if (!next) throw new Error('No scripted provider reply left.');
    return typeof next === 'function' ? next() : next;
  });
}

function runInput(threadId: string, messages: unknown[]) {
  return {
    threadId,
    runId: crypto.randomUUID(),
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

async function post(platform: Platform, path: string, body: unknown) {
  const response = await platform.handle(
    new Request(`http://localhost/api/copilotkit${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, text: await response.text() };
}

it('runs a Setup-configured chat end to end and recovers it after a restart', async () => {
  const dir = durableDir();
  const first = await start(dir);
  await first.configuration.saveConfiguration({
    intelligence: {
      provider: 'openai',
      model: 'setup-model',
      baseUrl: PROVIDER,
    },
  });
  const dot = (await first.workspace.store.dots())[0]!;
  const conversation = await first.platform.createConversation(
    dot.id,
    'Hello chat',
  );
  const network = provider(
    completion({ role: 'assistant', content: 'Hi from the provider.' }),
  );

  const run = await post(
    first.platform,
    `/agent/${dot.id}/run`,
    runInput(conversation.id, [
      { id: 'user-1', role: 'user', content: 'Hello there' },
    ]),
  );
  expect(run.status).toBe(200);
  expect(run.text).toContain('Hi from the provider.');
  expect(run.text).toContain('RUN_FINISHED');

  // The provider request used the configuration saved through Setup.
  expect(network).toHaveBeenCalledTimes(1);
  const [url, init] = network.mock.calls[0]!;
  expect(String(url)).toBe(`${PROVIDER}/chat/completions`);
  expect(JSON.parse(String(init?.body)).model).toBe('setup-model');
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);

  // Restart: close the durable state and open it again in a fresh platform.
  first.stop();
  const second = await start(dir);
  expect(
    (await second.workspace.store.conversations()).map((c) => c.id),
  ).toContain(conversation.id);
  const messages = await second.platform.conversations.messages(
    conversation.id,
  );
  expect(messages.map((m) => [m.role, m.content])).toEqual([
    ['user', 'Hello there'],
    ['assistant', 'Hi from the provider.'],
  ]);
  const runs = await second.platform.conversations.runs(conversation.id);
  expect(runs.map((r) => r.status)).toEqual(['completed']);
  expect(await second.configuration.savedIntelligenceSettings()).toMatchObject({
    provider: 'openai',
    model: 'setup-model',
  });

  // The chat UI's history replay after restart comes from FeltDB.
  const replay = await post(
    second.platform,
    `/agent/${dot.id}/connect`,
    runInput(conversation.id, []),
  );
  expect(replay.status).toBe(200);
  expect(replay.text).toContain('Hello there');
  expect(replay.text).toContain('Hi from the provider.');
});

it('continues a recovered conversation with its durable history', async () => {
  const dir = durableDir();
  const first = await start(dir);
  await first.configuration.saveConfiguration({
    intelligence: {
      provider: 'openai',
      model: 'setup-model',
      baseUrl: PROVIDER,
    },
  });
  const dot = (await first.workspace.store.dots())[0]!;
  const conversation = await first.platform.createConversation(dot.id, 'Chat');
  provider(completion({ role: 'assistant', content: 'First answer.' }));
  await post(
    first.platform,
    `/agent/${dot.id}/run`,
    runInput(conversation.id, [
      { id: 'u1', role: 'user', content: 'First question' },
    ]),
  );
  first.stop();
  vi.restoreAllMocks();

  const second = await start(dir);
  const network = provider(
    completion({ role: 'assistant', content: 'Second answer.' }),
  );
  // A server-initiated turn (scheduled task / voice) uses the same runner.
  const text = await second.platform.turn(
    conversation.id,
    'Second question',
    new AbortController().signal,
  );
  expect(text).toBe('Second answer.');
  const sent = JSON.parse(String(network.mock.calls[0]![1]?.body));
  expect(JSON.stringify(sent.messages)).toContain('First question');
  expect(JSON.stringify(sent.messages)).toContain('First answer.');
  expect(
    (await second.platform.conversations.messages(conversation.id)).map(
      (m) => m.content,
    ),
  ).toEqual([
    'First question',
    'First answer.',
    'Second question',
    'Second answer.',
  ]);
});

it('never records a failed provider stream as a completed assistant message', async () => {
  const dir = durableDir();
  const { platform, workspace, configuration } = await start(dir);
  await configuration.saveConfiguration({
    intelligence: {
      provider: 'openai',
      model: 'setup-model',
      baseUrl: PROVIDER,
    },
  });
  const dot = (await workspace.store.dots())[0]!;
  const conversation = await platform.createConversation(dot.id, 'Chat');
  provider(() => new Response('upstream failure', { status: 500 }));
  const run = await post(
    platform,
    `/agent/${dot.id}/run`,
    runInput(conversation.id, [{ id: 'u1', role: 'user', content: 'Hello' }]),
  );
  expect(run.text).toContain('RUN_ERROR');
  expect(await platform.conversations.messages(conversation.id)).toEqual([]);
  expect(
    (await platform.conversations.runs(conversation.id)).map((r) => r.status),
  ).toEqual(['interrupted']);
});

it('isolates conversation history between owners', async () => {
  const opened = await memoryWorkspace('owner-a');
  cleanup.push(() => opened.state.close());
  const ownerA = opened.store;
  const ownerB = new WorkspaceStore('owner-b', opened.state.db);
  const intelligence = new IntelligenceService(
    {
      savedIntelligenceSettings: async () => ({
        provider: 'openai',
        model: 'm',
        baseUrl: PROVIDER,
      }),
    },
    new EnvironmentCredentials({ OPENAI_API_KEY: KEY }),
    {},
  );
  const store = memoryStore();
  cleanup.push(() => store.close());
  const a = await Platform.create(
    store.store,
    ownerA,
    testPlatformConfig,
    intelligence,
  );
  const b = await Platform.create(
    store.store,
    ownerB,
    testPlatformConfig,
    intelligence,
  );
  const dot = (await ownerA.dots())[0]!;
  const conversation = await a.createConversation(dot.id, 'Private');
  provider(completion({ role: 'assistant', content: 'Private answer.' }));
  await post(
    a,
    `/agent/${dot.id}/run`,
    runInput(conversation.id, [
      { id: 'u1', role: 'user', content: 'Private question' },
    ]),
  );

  // Owner B cannot list, read, replay or append to owner A's conversation by id.
  expect((await ownerB.conversations()).map((c) => c.id)).not.toContain(
    conversation.id,
  );
  await expect(b.conversations.messages(conversation.id)).rejects.toThrow();
  await expect(b.conversations.runs(conversation.id)).rejects.toThrow();
  await expect(
    b.conversations.appendRun({
      threadId: conversation.id,
      runId: 'intruder',
      agentId: dot.id,
      status: 'completed',
      events: [],
      messages: [{ id: 'x', role: 'user', content: 'injected' }],
    }),
  ).rejects.toThrow();
  const replayed = await lastValueFrom(
    b.runner.connect({ threadId: conversation.id }).pipe(toArray()),
  );
  expect(replayed).toEqual([]);
  const intrusion = await post(
    b,
    `/agent/${dot.id}/run`,
    runInput(conversation.id, [
      { id: 'u2', role: 'user', content: 'Let me in' },
    ]),
  );
  expect(intrusion.status).toBe(403);

  expect(
    (await a.conversations.messages(conversation.id)).map((m) => m.content),
  ).toEqual(['Private question', 'Private answer.']);
});

it('replays a run to a client that connects while it is still streaming', async () => {
  const dir = durableDir();
  const { platform, workspace, configuration } = await start(dir);
  await configuration.saveConfiguration({
    intelligence: {
      provider: 'openai',
      model: 'setup-model',
      baseUrl: PROVIDER,
    },
  });
  const dot = (await workspace.store.dots())[0]!;
  const conversation = await platform.createConversation(dot.id, 'Chat');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    await gate;
    return completion({ role: 'assistant', content: 'Late answer.' });
  });
  const running = post(
    platform,
    `/agent/${dot.id}/run`,
    runInput(conversation.id, [
      { id: 'u1', role: 'user', content: 'Slow question' },
    ]),
  );
  await vi.waitFor(async () =>
    expect(await platform.runner.isRunning({ threadId: conversation.id })).toBe(
      true,
    ),
  );
  const joined = lastValueFrom(
    platform.runner.connect({ threadId: conversation.id }).pipe(toArray()),
  );
  release();
  await running;
  const events: BaseEvent[] = await joined;
  expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  expect(JSON.stringify(events)).toContain('Late answer.');
});
