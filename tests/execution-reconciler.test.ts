/**
 * Execution reconciliation and recovery.
 *
 * These tests exist to protect one asymmetry that the rest of the suite cannot
 * see: **an execution's fate belongs to the provider, but OpenDots' belief about
 * it is durable.** Everything here is written so that the only way to pass is for
 * reconciliation to have actually consulted the provider and recorded what it
 * said.
 *
 * The provider is `ScriptedExecutionProvider` — a clearly-labelled test double
 * that is never packaged and cannot be selected by any environment variable. The
 * real `ComputeExecutionProvider` is proved separately, against the actual
 * `compute.remote@1` shapes, in `compute-provider-contract.test.ts` and
 * `compute-reconciliation-integration.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openFeltState, type FeltState } from '../src/server/felt/state.js';
import { ExecutionStore } from '../src/server/executions.js';
import { ExecutionService } from '../src/server/execution-service.js';
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  ExecutionReconciler,
  reconcileIntervalFromEnv,
} from '../src/server/execution-reconciler.js';
import {
  ScriptedExecutionProvider,
  type ScriptedJobTable,
} from './helpers/scripted-execution-provider.js';

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
        namespace: `opendots-recon-${randomUUID()}`,
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
  const dir = mkdtempSync(join(tmpdir(), 'opendots-recon-'));
  dirs.push(dir);
  return { ...openAt(join(dir, 'state')), dir };
}

function reopen(dir: string) {
  return openAt(join(dir, 'state')).executions;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Submit an execution and leave it `running`, as a real submission would. */
async function running(
  store: ExecutionStore,
  provider: ScriptedExecutionProvider,
  idempotencyKey = randomUUID(),
) {
  const { execution } = await new ExecutionService(store, provider).request({
    prompt: 'reconcile me',
    idempotencyKey,
  });
  expect(execution.status).toBe('running');
  return execution;
}

const key = () => randomUUID();

/**
 * One scripted Compute node, seen by several provider instances.
 *
 * A restart or a brief outage does not make a node forget its jobs — OpenDots is
 * the side that loses its memory. Sharing the table models that faithfully, so a
 * "new" provider correctly still knows about work an earlier one accepted.
 */
function node(): ScriptedJobTable {
  return new Map();
}

describe('basic reconciliation', () => {
  it('annotates running → running without a lifecycle transition', async () => {
    // The provider is still running, so nothing about the lifecycle changed. The
    // observation is still recorded, and the transition table stays strict: there
    // is no `running → running` edge anywhere.
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const store = memory();
    const execution = await running(store, provider);
    const observed = await new ExecutionReconciler(
      store,
      provider,
    ).reconcileOne(execution);
    expect(observed.status).toBe('running');
    expect(observed.providerStatus).toBe('running');
    expect(observed.lastReconciledAt).toBeGreaterThan(0);
    expect(observed.reconciliationError).toBeNull();
    // One execution, still one execution: an observation is not a new record.
    expect(await store.list()).toHaveLength(1);
  });

  it('advances running → completed and records when it was observed', async () => {
    const provider = new ScriptedExecutionProvider({ script: ['succeeded'] });
    const store = memory();
    const execution = await running(store, provider);
    const settled = await new ExecutionReconciler(store, provider).reconcileOne(
      execution,
    );
    expect(settled.status).toBe('completed');
    expect(settled.providerStatus).toBe('succeeded');
    expect(settled.completedAt).toBeGreaterThan(0);
    expect(settled.lastReconciledAt).toBeGreaterThan(0);
  });

  it('advances running → failed with the provider’s own explanation', async () => {
    const provider = new ScriptedExecutionProvider({
      script: ['failed'],
      error: { code: 'remote_execution_failure', message: 'exited 1' },
    });
    const store = memory();
    const execution = await running(store, provider);
    const settled = await new ExecutionReconciler(store, provider).reconcileOne(
      execution,
    );
    expect(settled.status).toBe('failed');
    expect(settled.providerStatus).toBe('failed');
    expect(settled.errorCode).toBe('remote_execution_failure');
    expect(settled.error).toBe('exited 1');
  });

  it('maps a provider timeout to failed, never to completed', async () => {
    const provider = new ScriptedExecutionProvider({ script: ['timed_out'] });
    const store = memory();
    const execution = await running(store, provider);
    const settled = await new ExecutionReconciler(store, provider).reconcileOne(
      execution,
    );
    expect(settled.status).toBe('failed');
    expect(settled.providerStatus).toBe('timed_out');
  });
});

describe('result and receipt reconciliation', () => {
  it('retrieves and persists the real provider result on success', async () => {
    const provider = new ScriptedExecutionProvider({
      script: ['succeeded'],
      result: { exit_code: 0, stdout: { text: 'the answer' } },
    });
    const store = memory();
    const execution = await running(store, provider);
    const settled = await new ExecutionReconciler(store, provider).reconcileOne(
      execution,
    );
    expect(settled.status).toBe('completed');
    expect(settled.resultRetrieved).toBe(true);
    // The provider's payload, verbatim, not a re-typed copy.
    expect(settled.result).toEqual({
      exit_code: 0,
      stdout: { text: 'the answer' },
    });
  });

  it('marks a completion with no payload as retrieved=false', async () => {
    // "Completed" must not imply "the result is here". This is the distinction
    // the UI has to be able to show.
    const provider = new ScriptedExecutionProvider({
      script: ['succeeded'],
      resultNotPublished: true,
    });
    const store = memory();
    const execution = await running(store, provider);
    const settled = await new ExecutionReconciler(store, provider).reconcileOne(
      execution,
    );
    expect(settled.status).toBe('completed');
    expect(settled.resultRetrieved).toBe(false);
    expect(settled.result).toBeNull();
  });

  it('back-fills a withheld result on a later cycle', async () => {
    // The first cycle sees a completion with nothing attached; the second finds
    // the result waiting. This is what `pendingRetrievals()` exists for.
    const table = node();
    const withheld = new ScriptedExecutionProvider({
      script: ['succeeded'],
      resultNotPublished: true,
      sharedTable: table,
    });
    const store = memory();
    const submission = await running(store, withheld);
    const first = await new ExecutionReconciler(store, withheld).reconcileOne(
      submission,
    );
    expect(first.status).toBe('completed');
    expect(first.resultRetrieved).toBe(false);

    // A provider that now has the payload, discovered by the next full cycle.
    const online = new ScriptedExecutionProvider({
      result: { stdout: 'late' },
      sharedTable: table,
    });
    const second = await new ExecutionReconciler(store, online).reconcileAll();
    expect(second.retrieved).toBe(1);
    const settled = await store.get(submission.id);
    expect(settled?.resultRetrieved).toBe(true);
    expect(settled?.result).toEqual({ stdout: 'late' });
    // And the lifecycle was never re-decided by the back-fill.
    expect(settled?.status).toBe('completed');
  });

  it('retrieves and persists the real provider receipt', async () => {
    const provider = new ScriptedExecutionProvider({
      script: ['succeeded'],
      result: { stdout: 'ok' },
      receiptPayload: {
        job_id: 'scripted-1',
        receipt: { receipt_version: '1', execution_id: 'exec-1' },
      },
    });
    const store = memory();
    const execution = await running(store, provider);
    const settled = await new ExecutionReconciler(store, provider).reconcileOne(
      execution,
    );
    expect(settled.receipt).toEqual({
      job_id: 'scripted-1',
      receipt: { receipt_version: '1', execution_id: 'exec-1' },
    });
  });

  it('treats an unpublished receipt as pending, not as a failure', async () => {
    // Compute reports a not-yet-sealed receipt as a failure kind with a
    // recognisable message; the adapter re-labels it `receipt_unavailable`. A
    // reconciliation pass must not turn that into an execution failure.
    const provider = new ScriptedExecutionProvider({
      script: ['succeeded'],
      result: { stdout: 'ok' },
      receiptNotPublished: true,
    });
    const store = memory();
    const execution = await running(store, provider);
    const settled = await new ExecutionReconciler(store, provider).reconcileOne(
      execution,
    );
    expect(settled.status).toBe('completed');
    expect(settled.receipt).toBeNull();
    // A pending receipt is not an error condition at all.
    expect(settled.reconciliationError).toBeNull();
  });

  it('stops chasing a receipt once the grace window closes', async () => {
    // Otherwise every historical execution would cost one HTTP call per cycle,
    // forever, waiting for evidence that will never exist.
    const provider = new ScriptedExecutionProvider({
      script: ['succeeded'],
      result: { stdout: 'ok' },
    });
    const store = memory();
    const execution = await running(store, provider);
    await new ExecutionReconciler(store, provider).reconcileOne(execution);
    // An execution that settled long ago is no longer pending.
    expect(
      await store.pendingRetrievals(Date.now() + 60 * 60_000),
    ).toHaveLength(0);
    // But one that settled just now still is.
    expect(await store.pendingRetrievals()).toHaveLength(1);
  });
});

describe('provider outage', () => {
  it('never turns an unreachable provider into a failed execution', async () => {
    // The single most important behaviour in this file. If this regressed,
    // every Compute restart would mark every running execution failed.
    const store = memory();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const execution = await running(store, provider);

    const offline = new ScriptedExecutionProvider({ offline: true });
    const degraded = await new ExecutionReconciler(store, offline).reconcileOne(
      execution,
    );
    expect(degraded.status).toBe('running');
    // The failure is recorded so it is visible, and the provider's own code is
    // kept rather than a made-up one.
    expect(degraded.reconciliationError).toMatch(/unreachable/);
    expect(degraded.reconciliationErrorCode).toBe('transport_failure');
    // And crucially: no execution error was invented.
    expect(degraded.error).toBeNull();
    expect(degraded.errorCode).toBeNull();
  });

  it('recovers on the next cycle once the provider returns', async () => {
    const store = memory();
    const table = node();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: table,
    });
    const execution = await running(store, provider);

    await new ExecutionReconciler(
      store,
      new ScriptedExecutionProvider({
        script: ['running'],
        offline: true,
        sharedTable: table,
      }),
    ).reconcileOne(execution);
    expect((await store.get(execution.id))?.status).toBe('running');

    // The provider comes back and reports the truth.
    const back = new ScriptedExecutionProvider({
      script: ['succeeded'],
      sharedTable: table,
    });
    const settled = await new ExecutionReconciler(store, back).reconcileOne(
      execution,
    );
    expect(settled.status).toBe('completed');
    // A successful observation clears the outage marker, so the UI stops
    // reporting a problem that no longer exists.
    expect(settled.reconciliationError).toBeNull();
    expect(settled.reconciliationErrorCode).toBeNull();
  });

  it('keeps the last known state across a whole failed cycle', async () => {
    const store = memory();
    const table = node();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: table,
    });
    const execution = await running(store, provider);
    const before = await store.get(execution.id);
    const summary = await new ExecutionReconciler(
      store,
      new ScriptedExecutionProvider({
        script: ['running'],
        offline: true,
        sharedTable: table,
      }),
    ).reconcileAll();
    expect(summary.considered).toBe(1);
    const after = await store.get(execution.id);
    expect(after?.status).toBe(before?.status);
    expect(after?.providerExecutionId).toBe(before?.providerExecutionId);
  });

  it('fails an execution the provider has explicitly forgotten', async () => {
    // `unknown_job` is an *answer*, not an outage: Compute says it has no such
    // job, so the execution OpenDots believes in cannot exist.
    const store = memory();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const execution = await running(store, provider);
    const forgotten = await new ExecutionReconciler(
      store,
      new ScriptedExecutionProvider({ forget: true }),
    ).reconcileOne(execution);
    expect(forgotten.status).toBe('failed');
    expect(forgotten.errorCode).toBe('unknown_job');
  });
});

describe('unknown provider status', () => {
  it('fails closed: records the observation, moves nothing', async () => {
    // A Compute release that adds a JobStatus must not be able to make an
    // execution look finished. The raw word is kept so an operator can see it,
    // and the lifecycle is left exactly as it was.
    const store = memory();
    const table = node();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: table,
    });
    const execution = await running(store, provider);
    const alien = new ScriptedExecutionProvider({
      script: ['teleported'],
      sharedTable: table,
    });
    const observed = await new ExecutionReconciler(store, alien).reconcileOne(
      execution,
    );
    expect(observed.status).toBe('running');
    expect(observed.providerStatus).toBe('teleported');
    expect(observed.reconciliationErrorCode).toBe('unknown_status');
    expect(observed.reconciliationError).toMatch(/teleported/);
    // Never completed, never failed: OpenDots does not know what this means.
    expect(observed.completedAt).toBeNull();
  });

  it('does not let an unknown status overwrite a settled outcome', async () => {
    const store = memory();
    const table = node();
    const provider = new ScriptedExecutionProvider({
      script: ['succeeded'],
      result: { stdout: 'ok' },
      sharedTable: table,
    });
    const execution = await running(store, provider);
    await new ExecutionReconciler(store, provider).reconcileOne(execution);
    expect((await store.get(execution.id))?.status).toBe('completed');

    // A stale pass reporting nonsense cannot rewrite a finished execution.
    const alien = new ScriptedExecutionProvider({
      script: ['teleported'],
      sharedTable: table,
    });
    await new ExecutionReconciler(store, alien).reconcileOne(execution);
    const after = await store.get(execution.id);
    expect(after?.status).toBe('completed');
    expect(after?.providerStatus).toBe('succeeded');
  });
});

describe('restart recovery', () => {
  it('discovers and reconciles an execution left by a dead process', async () => {
    // The acceptance criterion. Nothing is handed to the new reconciler except a
    // store: it must find the work itself, from FeltDB.
    const first = durable();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const execution = await running(first.executions, provider);
    expect(execution.status).toBe('running');
    first.close();

    // A new process. Same durable path, same provider, no in-memory state.
    const second = reopen(first.dir);
    const summary = await new ExecutionReconciler(
      second,
      provider,
    ).reconcileAll();
    expect(summary.considered).toBe(1);
    const recovered = await second.get(execution.id);
    expect(recovered?.status).toBe('running');
    expect(recovered?.providerExecutionId).toBe(execution.providerExecutionId);
    expect(recovered?.lastReconciledAt).toBeGreaterThan(0);
  });

  it('recovers an outcome that happened while OpenDots was down', async () => {
    const first = durable();
    const table = node();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: table,
    });
    const execution = await running(first.executions, provider);
    first.close();

    // While OpenDots is down the job finishes.
    const later = new ScriptedExecutionProvider({
      script: ['succeeded'],
      result: { stdout: { text: 'finished while you were away' } },
      sharedTable: table,
    });
    const second = reopen(first.dir);
    await new ExecutionReconciler(second, later).reconcileAll();
    const recovered = await second.get(execution.id);
    expect(recovered?.status).toBe('completed');
    expect(recovered?.resultRetrieved).toBe(true);
    expect(recovered?.result).toMatchObject({
      stdout: { text: 'finished while you were away' },
    });
  });

  it('finishes a submission interrupted between the two writes', async () => {
    // The process died after recording `starting` but before recording the
    // provider handle. Resubmitting is safe only because the request is
    // idempotent — and that is exactly what it is for.
    const store = memory();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const { execution } = await new ExecutionService(store, provider).request({
      prompt: 'go',
      idempotencyKey: key(),
    });
    // Simulate the crash: the handle never landed. The reconciler is handed a
    // freshly read record, as it would be after a real restart — not the snapshot
    // `request` returned, which still carries the handle it thinks it stored.
    await store.annotate(execution.id, {
      providerExecutionId: null,
      providerStatus: null,
    });
    const broken = await store.get(execution.id);
    expect(broken?.providerExecutionId).toBeNull();

    const settled = await new ExecutionReconciler(store, provider).reconcileOne(
      broken!,
    );
    expect(settled.status).toBe('running');
    expect(settled.providerExecutionId).toBeTruthy();
    // One execution throughout — the resubmission did not create a second.
    expect(await store.list()).toHaveLength(1);
  });
});

describe('idempotency and terminal executions', () => {
  it('is a no-op once an execution has finished', async () => {
    const store = memory();
    const provider = new ScriptedExecutionProvider({
      script: ['succeeded'],
      result: { stdout: 'ok' },
    });
    const execution = await running(store, provider);
    const reconciler = new ExecutionReconciler(store, provider);
    const settled = await reconciler.reconcileOne(execution);
    expect(settled.status).toBe('completed');
    const observedAt = settled.lastReconciledAt;

    // Repeated passes over finished work change nothing at all.
    for (let i = 0; i < 5; i++) await reconciler.reconcileAll();
    const after = await store.get(execution.id);
    expect(after?.status).toBe('completed');
    expect(after?.resultRetrieved).toBe(true);
    expect(after?.result).toEqual({ stdout: 'ok' });
    expect(after?.lastReconciledAt).toBe(observedAt);
    expect(await store.list()).toHaveLength(1);
    expect(await store.active()).toHaveLength(0);
  });

  it('creates no duplicates across many cycles of the same execution', async () => {
    const store = memory();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      result: { stdout: 'ok' },
    });
    const execution = await running(store, provider);
    const reconciler = new ExecutionReconciler(store, provider);
    for (let i = 0; i < 5; i++) await reconciler.reconcileAll();
    const after = await store.get(execution.id);
    expect(after?.status).toBe('running');
    expect(await store.list()).toHaveLength(1);
    expect(after?.idempotencyKey).toBe(execution.idempotencyKey);
    expect(after?.providerExecutionId).toBe(execution.providerExecutionId);
  });
});

describe('concurrent reconciliation', () => {
  it('leaves one consistent record when two reconcilers race', async () => {
    // No process-global lock: both passes read the same version, both attempt the
    // next one, and FeltDB's fence makes exactly one of them win.
    const store = memory();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const execution = await running(store, provider);
    const a = new ExecutionReconciler(store, provider);
    const b = new ExecutionReconciler(store, provider);
    await Promise.all([
      a.reconcileOne(execution),
      b.reconcileOne(execution),
      a.reconcileAll(),
    ]);
    const after = await store.get(execution.id);
    expect(after?.status).toBe('running');
    expect(await store.list()).toHaveLength(1);
  });

  it('settles once when both reconcilers see the same completion', async () => {
    const store = memory();
    const table = node();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: table,
    });
    const execution = await running(store, provider);
    const finishing = new ScriptedExecutionProvider({
      script: ['succeeded'],
      result: { stdout: 'ok' },
      sharedTable: table,
    });
    const a = new ExecutionReconciler(store, finishing);
    const b = new ExecutionReconciler(store, finishing);
    const [first, second] = await Promise.all([
      a.reconcileOne(execution),
      b.reconcileOne(execution),
    ]);
    // Both answers are truthful: one moved it, the other found it settled.
    expect(first?.status).toBe('completed');
    expect(second?.status).toBe('completed');
    expect((await store.get(execution.id))?.status).toBe('completed');
    expect(await store.list()).toHaveLength(1);
  });

  it('joins a cycle already in flight rather than starting a second', async () => {
    const store = memory();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    await running(store, provider);
    const reconciler = new ExecutionReconciler(store, provider);
    const [a, b] = await Promise.all([
      reconciler.reconcileAll(),
      reconciler.reconcileAll(),
    ]);
    // The same summary object, because it is literally the same cycle.
    expect(a).toBe(b);
  });
});

describe('scheduling', () => {
  it('reconciles on a timer and stops cleanly', async () => {
    const store = memory();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    await running(store, provider);
    const reconciler = new ExecutionReconciler(store, provider, {
      intervalMs: 1000,
    });
    reconciler.start();
    // `start()` runs a cycle immediately rather than waiting a full interval.
    await vi.waitFor(async () => {
      expect((await store.list())[0]?.lastReconciledAt).toBeGreaterThan(0);
    });
    await reconciler.stop();
    // After `stop()` no further cycle can start, so nothing moves.
    const settledAt = (await store.list())[0]?.lastReconciledAt;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await store.list())[0]?.lastReconciledAt).toBe(settledAt);
  });

  it('is idempotent to start, so it cannot create two loops', async () => {
    const store = memory();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const reconciler = new ExecutionReconciler(store, provider, {
      intervalMs: 1000,
    });
    reconciler.start();
    reconciler.start();
    await reconciler.reconcileAll();
    await reconciler.stop();
    expect(reconciler.lastRunAt).toBeGreaterThan(0);
  });

  it('does nothing at all with no provider configured', async () => {
    const store = memory();
    const reconciler = new ExecutionReconciler(store);
    expect(reconciler.configured).toBe(false);
    reconciler.start();
    const summary = await reconciler.reconcileAll();
    expect(summary.considered).toBe(0);
    await reconciler.stop();
  });

  it('reads its interval from the environment, and ignores nonsense', () => {
    expect(reconcileIntervalFromEnv({})).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(
      reconcileIntervalFromEnv({ OPENDOTS_RECONCILE_INTERVAL_MS: '5000' }),
    ).toBe(5000);
    // A typo must not take the control plane down or spin it pointlessly.
    for (const bad of ['', 'soon', '-1', '0', '10']) {
      expect(
        reconcileIntervalFromEnv({ OPENDOTS_RECONCILE_INTERVAL_MS: bad }),
      ).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    }
  });
});
