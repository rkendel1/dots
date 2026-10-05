import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openFeltState, type FeltState } from '../src/server/felt/state.js';
import {
  ExecutionStore,
  InvalidExecutionTransition,
  isTerminal,
} from '../src/server/executions.js';
import {
  ExecutionService,
  NoExecutionProvider,
} from '../src/server/execution-service.js';
import { ExecutionReconciler } from '../src/server/execution-reconciler.js';
import { ScriptedExecutionProvider } from './helpers/scripted-execution-provider.js';

interface Open {
  executions: ExecutionStore;
  state: FeltState;
  close(): void;
}

const handles: Open[] = [];
const dirs: string[] = [];

function openAt(path?: string): Open {
  const state = path
    ? openFeltState({ path })
    : openFeltState({
        memory: true,
        namespace: `opendots-exec-${randomUUID()}`,
      });
  const handle: Open = {
    executions: new ExecutionStore(state.db),
    state,
    close: () => state.close(),
  };
  handles.push(handle);
  return handle;
}

function memory() {
  return openAt().executions;
}

/** A file-backed store plus its directory, for restart tests. */
function durable() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-exec-'));
  dirs.push(dir);
  const handle = openAt(join(dir, 'state'));
  return { ...handle, dir };
}

function reopen(dir: string) {
  return openAt(join(dir, 'state')).executions;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const queued = async (store: ExecutionStore) => {
  const { execution } = await store.create({
    provider: 'scripted-test',
    prompt: 'summarize the repo',
  });
  return execution;
};

describe('execution lifecycle', () => {
  it('creates an execution queued, with no provider identity yet', async () => {
    const execution = await queued(memory());
    expect(execution.status).toBe('queued');
    expect(execution.providerExecutionId).toBeNull();
    expect(execution.startedAt).toBeNull();
    expect(execution.completedAt).toBeNull();
    expect(execution.idempotencyKey).toBeTruthy();
  });

  it('walks queued → starting → running → completed', async () => {
    const store = memory();
    const execution = await queued(store);
    const starting = await store.transition(execution.id, 'starting', {
      providerExecutionId: 'job_a',
    });
    expect(starting?.status).toBe('starting');
    expect(starting?.startedAt).toBeGreaterThan(0);
    const running = await store.transition(execution.id, 'running');
    expect(running?.status).toBe('running');
    const completed = await store.transition(execution.id, 'completed', {
      result: { text: 'done' },
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toEqual({ text: 'done' });
    expect(completed?.completedAt).toBeGreaterThan(0);
  });

  it('walks starting → failed, keeping the provider code', async () => {
    const store = memory();
    const execution = await queued(store);
    await store.transition(execution.id, 'starting');
    const failed = await store.transition(execution.id, 'failed', {
      errorCode: 'remote_execution_failure',
      error: 'the workload exited non-zero',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.errorCode).toBe('remote_execution_failure');
    expect(failed?.error).toBe('the workload exited non-zero');
    expect(failed?.completedAt).toBeGreaterThan(0);
  });

  it('walks running → failed', async () => {
    const store = memory();
    const execution = await queued(store);
    await store.transition(execution.id, 'starting');
    await store.transition(execution.id, 'running');
    expect((await store.transition(execution.id, 'failed'))?.status).toBe(
      'failed',
    );
  });

  it('cancels from queued and from running', async () => {
    const store = memory();
    const early = await queued(store);
    expect((await store.transition(early.id, 'cancelled'))?.status).toBe(
      'cancelled',
    );
    const late = await queued(store);
    await store.transition(late.id, 'starting');
    await store.transition(late.id, 'running');
    expect((await store.transition(late.id, 'cancelled'))?.status).toBe(
      'cancelled',
    );
  });

  it('rejects an invalid transition instead of writing it', async () => {
    const store = memory();
    const execution = await queued(store);
    // `queued` may not jump straight to `running`.
    await expect(store.transition(execution.id, 'running')).rejects.toThrow(
      InvalidExecutionTransition,
    );
    expect((await store.get(execution.id))?.status).toBe('queued');
  });

  it('refuses even a self-transition, so the table stays strict', async () => {
    const store = memory();
    const execution = await queued(store);
    await store.transition(execution.id, 'starting');
    await expect(store.transition(execution.id, 'starting')).rejects.toThrow(
      InvalidExecutionTransition,
    );
  });

  it('records a provider observation without changing the lifecycle', async () => {
    const store = memory();
    const execution = await queued(store);
    await store.transition(execution.id, 'starting');
    const running = await store.transition(execution.id, 'running', {
      providerExecutionId: 'job_x',
    });
    // Polling a still-running execution must be a no-op, not an error.
    const annotated = await store.annotate(execution.id, {
      providerStatus: 'running',
      providerSessionId: 'session_x',
    });
    expect(annotated?.status).toBe('running');
    expect(annotated?.providerStatus).toBe('running');
    expect(annotated?.providerSessionId).toBe('session_x');
    expect(annotated?.providerExecutionId).toBe('job_x');
    // And it really was the same execution, not a second one.
    expect(await store.list()).toHaveLength(1);
    expect(annotated?.id).toBe(running?.id);
  });

  it('refuses to move a terminal execution anywhere', async () => {
    const store = memory();
    const execution = await queued(store);
    await store.transition(execution.id, 'starting');
    await store.transition(execution.id, 'running');
    await store.transition(execution.id, 'completed');
    for (const to of [
      'queued',
      'starting',
      'running',
      'failed',
      'cancelled',
    ] as const)
      expect(await store.transition(execution.id, to)).toBeUndefined();
    expect((await store.get(execution.id))?.status).toBe('completed');
  });

  it('treats every terminal status as final', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('starting')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});

describe('execution persistence', () => {
  it('survives a restart with its provider identity intact', async () => {
    const first = durable();
    const { execution } = await first.executions.create({
      provider: 'compute',
      prompt: 'run the audit',
      idempotencyKey: 'audit-1',
    });
    await first.executions.transition(execution.id, 'starting');
    await first.executions.transition(execution.id, 'running', {
      providerExecutionId: 'job_b',
      providerSessionId: 'session_b',
      providerStatus: 'running',
    });
    first.close();

    const recovered = await reopen(first.dir).get(execution.id);
    expect(recovered?.status).toBe('running');
    expect(recovered?.provider).toBe('compute');
    expect(recovered?.providerExecutionId).toBe('job_b');
    expect(recovered?.providerSessionId).toBe('session_b');
    expect(recovered?.providerStatus).toBe('running');
    expect(recovered?.idempotencyKey).toBe('audit-1');
  });

  it('keeps a finished execution finished across a restart', async () => {
    const first = durable();
    const { execution } = await first.executions.create({
      provider: 'scripted-test',
      prompt: 'finish me',
    });
    await first.executions.transition(execution.id, 'starting');
    await first.executions.transition(execution.id, 'running');
    await first.executions.transition(execution.id, 'completed', {
      result: { stdout: 'ok' },
    });
    first.close();
    const recovered = await reopen(first.dir).get(execution.id);
    expect(recovered?.status).toBe('completed');
    expect(recovered?.result).toEqual({ stdout: 'ok' });
  });
});

describe('execution idempotency', () => {
  it('returns the same execution for a repeated key', async () => {
    const store = memory();
    const first = await store.create({
      provider: 'compute',
      prompt: 'once',
      idempotencyKey: 'stable-key',
    });
    const second = await store.create({
      provider: 'compute',
      prompt: 'once',
      idempotencyKey: 'stable-key',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.execution.id).toBe(first.execution.id);
    expect(await store.list()).toHaveLength(1);
  });

  it('creates distinct executions for distinct keys', async () => {
    const store = memory();
    await store.create({
      provider: 'compute',
      prompt: 'a',
      idempotencyKey: 'key-a',
    });
    await store.create({
      provider: 'compute',
      prompt: 'b',
      idempotencyKey: 'key-b',
    });
    expect(await store.list()).toHaveLength(2);
  });

  it('converges on one execution when two requests race', async () => {
    const store = memory();
    const [a, b] = await Promise.all([
      store.create({
        provider: 'compute',
        prompt: 'race',
        idempotencyKey: 'race-key',
      }),
      store.create({
        provider: 'compute',
        prompt: 'race',
        idempotencyKey: 'race-key',
      }),
    ]);
    expect(a.execution.id).toBe(b.execution.id);
    expect(await store.list()).toHaveLength(1);
  });

  it('forwards the idempotency key to the provider', async () => {
    const provider = new ScriptedExecutionProvider();
    const service = new ExecutionService(memory(), provider);
    await service.request({ prompt: 'go', idempotencyKey: 'opendots-key-1' });
    expect(provider.idempotencyKeys).toEqual(['opendots-key-1']);
  });

  it('does not submit twice when the same request is retried', async () => {
    const provider = new ScriptedExecutionProvider();
    const service = new ExecutionService(memory(), provider);
    const first = await service.request({
      prompt: 'go',
      idempotencyKey: 'retry-key',
    });
    const second = await service.request({
      prompt: 'go',
      idempotencyKey: 'retry-key',
    });
    expect(second.created).toBe(false);
    expect(second.execution.id).toBe(first.execution.id);
    expect(provider.started).toHaveLength(1);
  });
});

describe('execution service', () => {
  it('refuses to run with no provider configured', async () => {
    const service = new ExecutionService(memory());
    expect(service.configured).toBe(false);
    await expect(
      service.request({ prompt: 'go', idempotencyKey: 'k' }),
    ).rejects.toThrow(NoExecutionProvider);
  });

  it('records the failure when the provider rejects the submission', async () => {
    const provider = new ScriptedExecutionProvider({
      failStart: { code: 'policy_rejected', message: 'not allowed' },
    });
    const store = memory();
    const service = new ExecutionService(store, provider);
    const { execution } = await service.request({
      prompt: 'go',
      idempotencyKey: 'k',
    });
    expect(execution.status).toBe('failed');
    expect(execution.errorCode).toBe('policy_rejected');
    expect(execution.error).toBe('not allowed');
  });

  it('never assumes completion just because the process restarted', async () => {
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const first = durable();
    const service = new ExecutionService(first.executions, provider);
    await service.request({ prompt: 'go', idempotencyKey: 'k' });
    first.close();

    // A new process, the same durable state, the same provider. The reconciler
    // discovers the execution from FeltDB — there is nothing handed to it.
    const second = reopen(first.dir);
    const reconciler = new ExecutionReconciler(second, provider);
    await reconciler.reconcileAll();
    const recovered = await second.list();
    expect(recovered).toHaveLength(1);
    // Still running: the provider said so, and nothing else may claim otherwise.
    expect(recovered[0]?.status).toBe('running');
  });

  it('fails an execution the provider has never heard of', async () => {
    const provider = new ScriptedExecutionProvider({ forget: true });
    const first = durable();
    const service = new ExecutionService(first.executions, provider);
    await service.request({ prompt: 'go', idempotencyKey: 'k' });
    first.close();
    const second = reopen(first.dir);
    await new ExecutionReconciler(second, provider).reconcileAll();
    const recovered = await second.list();
    expect(recovered[0]?.status).toBe('failed');
    expect(recovered[0]?.errorCode).toBe('unknown_job');
  });

  it('cancels through the provider, then records it', async () => {
    const provider = new ScriptedExecutionProvider();
    const service = new ExecutionService(memory(), provider);
    const { execution } = await service.request({
      prompt: 'go',
      idempotencyKey: 'k',
    });
    const cancelled = await service.cancel(execution);
    expect(cancelled.status).toBe('cancelled');
    expect(provider.cancelled).toHaveLength(1);
  });

  it('refuses to cancel when the provider cannot stop work', async () => {
    const provider = new ScriptedExecutionProvider({ cannotCancel: true });
    const service = new ExecutionService(memory(), provider);
    const { execution } = await service.request({
      prompt: 'go',
      idempotencyKey: 'k',
    });
    await expect(service.cancel(execution)).rejects.toThrow(
      /cannot cancel an execution/,
    );
  });
});
