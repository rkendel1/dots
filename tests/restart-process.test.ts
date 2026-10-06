import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * The restart proof, against real processes: start OpenDots, configure
 * Intelligence through its API, chat, stop the process, start a new one on the
 * same state directory, and recover the conversation. Only the model provider
 * is stubbed, as a local OpenAI-compatible HTTP server.
 */

const KEY = 'sk-restart-test-key';
let provider: Server;
let providerUrl: string;
const providerRequests: { auth?: string; model: string }[] = [];
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opendots-restart-'));
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      providerRequests.push({
        auth: req.headers.authorization,
        model: JSON.parse(body).model,
      });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'restart-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        chunk({ role: 'assistant', content: 'Durable reply.' }, null) +
          chunk({}, 'stop') +
          'data: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, '127.0.0.1', resolve),
  );
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  provider.close();
  rmSync(dir, { recursive: true, force: true });
});

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startOpenDots() {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/server/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        HOST: '127.0.0.1',
        PORT: String(port),
        FELTDB_PATH: join(dir, 'state'),
        OPENAI_API_KEY: KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`OpenDots did not start:\n${output}`)),
      30_000,
    );
    const check = () => {
      if (output.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`OpenDots exited (${code}):\n${output}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    return { status: response.status, text: await response.text() };
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.removeAllListeners('exit');
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  };
  return { call, stop, output: () => output };
}

const runBody = (threadId: string, messages: unknown[]) =>
  JSON.stringify({
    threadId,
    runId: crypto.randomUUID(),
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });

it('recovers configuration and conversation history after a process restart', async () => {
  const first = await startOpenDots();
  let conversationId: string;
  let dotId: string;
  try {
    const saved = await first.call('/api/configuration', {
      method: 'PUT',
      body: JSON.stringify({
        intelligence: {
          provider: 'openai',
          model: 'restart-model',
          baseUrl: providerUrl,
        },
      }),
    });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(KEY);
    expect(JSON.parse(saved.text).setupComplete).toBe(true);

    const workspace = JSON.parse((await first.call('/api/workspace')).text);
    expect(workspace.setup).toMatchObject({ intelligence: true, missing: [] });
    dotId = workspace.dots[0].id;
    const created = await first.call('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ dotId, title: 'Restart proof' }),
    });
    expect(created.status).toBe(201);
    conversationId = JSON.parse(created.text).id;

    const run = await first.call(`/api/copilotkit/agent/${dotId}/run`, {
      method: 'POST',
      body: runBody(conversationId, [
        { id: 'restart-user', role: 'user', content: 'Remember this message' },
      ]),
    });
    expect(run.status).toBe(200);
    expect(run.text).toContain('Durable reply.');
    expect(providerRequests).toEqual([
      { auth: `Bearer ${KEY}`, model: 'restart-model' },
    ]);
  } finally {
    await first.stop();
  }
  expect(first.output()).not.toContain(KEY);

  const second = await startOpenDots();
  try {
    const configuration = JSON.parse(
      (await second.call('/api/configuration')).text,
    );
    expect(configuration.sections.intelligence).toMatchObject({
      provider: 'openai',
      model: 'restart-model',
    });
    const workspace = JSON.parse((await second.call('/api/workspace')).text);
    expect(workspace.conversations.map((c: { id: string }) => c.id)).toContain(
      conversationId!,
    );

    const replay = await second.call(
      `/api/copilotkit/agent/${dotId!}/connect`,
      {
        method: 'POST',
        body: runBody(conversationId!, []),
      },
    );
    expect(replay.status).toBe(200);
    expect(replay.text).toContain('Remember this message');
    expect(replay.text).toContain('Durable reply.');
    // Recovery read FeltDB; it did not ask the provider again.
    expect(providerRequests).toHaveLength(1);
  } finally {
    await second.stop();
  }
  expect(second.output()).not.toContain(KEY);
}, 120_000);
