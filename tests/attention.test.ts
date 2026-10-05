/**
 * The attention control plane.
 *
 * These tests protect two properties the rest of the system cannot check for us:
 *
 *   1. **Idempotence is structural.** A condition that holds across many
 *      evaluation passes is one item, because the record key *is* the condition's
 *      identity. The outage and dedup suites exist to prove that, since an outage
 *      re-evaluating every few seconds is exactly where a check-then-write
 *      implementation would multiply rows.
 *   2. **Condition clearing is not human resolution.** A provider that comes back
 *      stops being a problem; it has not decided anything. Conflating those two
 *      would let the system silently close items a person never looked at.
 *
 * The provider is `ScriptedExecutionProvider`, which is test-only, never packaged
 * and unreachable from any environment variable. The real `compute.remote@1`
 * shapes are proved separately in `compute-provider-contract.test.ts` and driven
 * end-to-end against the real adapter in `attention-integration.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openFeltState, type FeltState } from '../src/server/felt/state.js';
import { ExecutionStore } from '../src/server/executions.js';
import { ExecutionService } from '../src/server/execution-service.js';
import { ExecutionReconciler } from '../src/server/execution-reconciler.js';
import { AttentionStore, needsAttention } from '../src/server/attention.js';
import {
  AttentionEvaluator,
  conditionsFor,
} from '../src/server/attention-evaluator.js';
import { attentionIdFor } from '../src/server/attention-collections.js';
import type { Execution, Task } from '../src/shared/types.js';
import { ScriptedExecutionProvider } from './helpers/scripted-execution-provider.js';

interface Open {
  executions: ExecutionStore;
  attention: AttentionStore;
  evaluator: AttentionEvaluator;
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
        namespace: `opendots-attn-${randomUUID()}`,
      });
  const executions = new ExecutionStore(state.db);
  const attention = new AttentionStore(state.db);
  const handle: Open = {
    executions,
    attention,
    evaluator: new AttentionEvaluator(attention),
    state,
    close: () => state.close(),
  };
  handles.push(handle);
  return handle;
}

function memory() {
  return openAt();
}

/** A file-backed store plus its directory, for restart tests. */
function durable() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-attn-'));
  dirs.push(dir);
  return { ...openAt(join(dir, 'state')), dir };
}

function reopen(dir: string) {
  return openAt(join(dir, 'state'));
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const key = () => randomUUID();

/**
 * A complete `Execution`, so a test changes one field and means it.
 *
 * Written out rather than spread from a base object so a new field cannot
 * silently default into a test that was asserting about something else.
 */
function execution(patch: Partial<Execution> = {}): Execution {
  return {
    id: `exec_${randomUUID()}`,
    taskId: null,
    dotId: null,
    status: 'running',
    provider: 'compute',
    providerExecutionId: 'job_abc',
    providerSessionId: null,
    providerStatus: 'running',
    idempotencyKey: randomUUID(),
    prompt: 'do the thing',
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    result: null,
    errorCode: null,
    error: null,
    lastReconciledAt: Date.now(),
    resultRetrieved: false,
    receipt: null,
    reconciliationErrorCode: null,
    reconciliationError: null,
    ...patch,
  };
}

function task(patch: Partial<Task> = {}): Task {
  return {
    id: `task_${randomUUID()}`,
    prompt: 'a scheduled task',
    status: 'paused',
    intervalSeconds: null,
    nextRunAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
    lease: null,
    leaseUntil: null,
    ...patch,
  };
}

/** Submit an execution and leave it `running`, as a real submission would. */
async function running(
  store: ExecutionStore,
  provider: ScriptedExecutionProvider,
  patch: Partial<Execution> = {},
) {
  const { execution: submitted } = await new ExecutionService(
    store,
    provider,
  ).request({ prompt: 'go', idempotencyKey: key(), ...patch });
  return submitted;
}

describe('the mapping from durable state to conditions', () => {
  const kinds = (input: Parameters<typeof conditionsFor>[0]) =>
    conditionsFor(input).map((c) => c.kind);

  it('raises execution_failed for a failed execution', () => {
    const failed = execution({ status: 'failed', error: 'exited 1' });
    expect(kinds({ executions: [failed] })).toContain('execution_failed');
  });

  it('raises nothing for a healthy running execution', () => {
    // The most important negative case. A control plane that raises an item for
    // ordinary progress is a control plane people learn to ignore.
    expect(kinds({ executions: [execution()] })).toEqual([]);
  });

  it('raises execution_evidence_pending for a completion with no result', () => {
    const done = execution({
      status: 'completed',
      resultRetrieved: false,
      completedAt: Date.now(),
    });
    expect(kinds({ executions: [done] })).toContain(
      'execution_evidence_pending',
    );
  });

  it('raises nothing once the result has been retrieved', () => {
    const done = execution({
      status: 'completed',
      resultRetrieved: true,
      result: { stdout: 'ok' },
      completedAt: Date.now(),
    });
    expect(kinds({ executions: [done] })).toEqual([]);
  });

  it('raises provider_unreachable from a transport failure', () => {
    const stuck = execution({
      reconciliationErrorCode: 'transport_failure',
      reconciliationError: 'connection refused',
    });
    const outage = conditionsFor({ executions: [stuck] }).find(
      (c) => c.kind === 'provider_unreachable',
    );
    expect(outage).toBeDefined();
    // Scoped to the provider, not to one execution.
    expect(outage?.sourceType).toBe('provider');
    expect(outage?.sourceId).toBe('compute');
  });

  it('raises one provider item however many executions are affected', () => {
    // Twenty identical rows would bury the other four kinds. An outage is one
    // thing a human needs to know about.
    const many = Array.from({ length: 20 }, () =>
      execution({
        reconciliationErrorCode: 'transport_failure',
        reconciliationError: 'connection refused',
      }),
    );
    const outages = conditionsFor({ executions: many }).filter(
      (c) => c.kind === 'provider_unreachable',
    );
    expect(outages).toHaveLength(1);
  });

  it('raises execution_blocked only when an execution cannot get an identity', () => {
    const blocked = execution({
      status: 'starting',
      providerExecutionId: null,
      reconciliationError: 'could not reach provider',
    });
    expect(kinds({ executions: [blocked] })).toContain('execution_blocked');
  });

  it('raises nothing for an execution that simply has not started', () => {
    // A freshly queued execution is normal. Raising attention for one on every
    // cycle is how a list stops being read.
    const queued = execution({
      status: 'queued',
      providerExecutionId: null,
      reconciliationError: null,
    });
    expect(kinds({ executions: [queued] })).toEqual([]);
  });

  it('raises human_decision_required for a paused or failed task', () => {
    expect(
      kinds({ executions: [], tasks: [task({ status: 'paused' })] }),
    ).toContain('human_decision_required');
    expect(
      kinds({ executions: [], tasks: [task({ status: 'failed' })] }),
    ).toContain('human_decision_required');
  });

  it('raises nothing for a task that is simply running', () => {
    expect(
      kinds({ executions: [], tasks: [task({ status: 'running' })] }),
    ).toEqual([]);
  });
});

describe('creation and deduplication', () => {
  it('creates one attention item for a failed execution', async () => {
    const { evaluator, attention } = memory();
    const failed = execution({ status: 'failed', error: 'exited 1' });
    const summary = await evaluator.evaluate({ executions: [failed] });
    expect(summary.raised).toBe(1);
    const items = await attention.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('execution_failed');
    expect(items[0]?.status).toBe('open');
    expect(items[0]?.sourceId).toBe(failed.id);
  });

  it('derives the same id for the same condition every time', () => {
    // The whole of §6 in one assertion: identity is a function of the condition,
    // not of when it happened to be noticed.
    const first = attentionIdFor('execution_failed', 'execution', 'exec_1');
    expect(attentionIdFor('execution_failed', 'execution', 'exec_1')).toBe(
      first,
    );
    // And genuinely different conditions get different ids.
    expect(attentionIdFor('execution_failed', 'execution', 'exec_2')).not.toBe(
      first,
    );
    expect(
      attentionIdFor('provider_unreachable', 'execution', 'exec_1'),
    ).not.toBe(first);
  });

  it('cannot be made to collide by choosing a different source split', () => {
    // The parts are length-prefixed before hashing, so no two different splits of
    // the same characters produce the same pre-image.
    expect(attentionIdFor('execution_failed', 'execution', 'ab')).not.toBe(
      attentionIdFor('execution_failed', 'execution', 'b'),
    );
  });

  it('repeated evaluation of one condition creates exactly one item', async () => {
    // The deduplication requirement, stated directly.
    const { evaluator, attention } = memory();
    const failed = execution({ status: 'failed' });
    for (let i = 0; i < 6; i++)
      await evaluator.evaluate({ executions: [failed] });
    expect(await attention.list()).toHaveLength(1);
  });

  it('never rewrites createdAt when the condition persists', async () => {
    // A cycle running every few seconds must not make the item look new, or "3
    // hours ago" would be a lie in the UI.
    const { evaluator, attention } = memory();
    const failed = execution({ status: 'failed' });
    await evaluator.evaluate({ executions: [failed] });
    const first = (await attention.list())[0]!;
    await evaluator.evaluate({ executions: [failed] });
    expect((await attention.get(first.id))?.createdAt).toBe(first.createdAt);
  });

  it('concurrent evaluation of one condition creates exactly one item', async () => {
    // Two evaluators, no process-global lock: the deterministic key plus
    // FeltDB's create-only guard make the loser read back the winner.
    const { attention, evaluator } = memory();
    const other = new AttentionEvaluator(attention);
    const failed = execution({ status: 'failed' });
    await Promise.all([
      evaluator.evaluate({ executions: [failed] }),
      other.evaluate({ executions: [failed] }),
      evaluator.evaluate({ executions: [failed] }),
    ]);
    expect(await attention.list()).toHaveLength(1);
  });

  it('does not resurrect or duplicate an item a human resolved', async () => {
    const { evaluator, attention } = memory();
    const failed = execution({ status: 'failed' });
    await evaluator.evaluate({ executions: [failed] });
    const item = (await attention.list())[0]!;
    await attention.resolve(item.id);
    // The condition is still true and must still produce exactly one item.
    for (let i = 0; i < 3; i++)
      await evaluator.evaluate({ executions: [failed] });
    const after = await attention.list();
    expect(after).toHaveLength(1);
    // Still resolved: the evaluator cannot reopen what a person closed.
    expect(after[0]?.status).toBe('resolved');
  });
});

/**
 * A reconciler wired to the evaluator, the way `index.ts` wires them.
 *
 * Used instead of hand-writing observations onto records, so the transport
 * failure under test is recorded by the same code path production uses.
 */
function wired(
  executions: ExecutionStore,
  evaluator: AttentionEvaluator,
  provider: ScriptedExecutionProvider,
) {
  return new ExecutionReconciler(executions, provider, {
    onCycleComplete: async ({ executions: settled }) => {
      await evaluator.evaluate({ executions: settled });
    },
  });
}

describe('provider outage', () => {
  it('raises one attention item when the provider becomes unreachable', async () => {
    const { executions, evaluator, attention } = memory();
    const node = new Map();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: node,
    });
    await running(executions, provider);
    await wired(
      executions,
      evaluator,
      new ScriptedExecutionProvider({
        script: ['running'],
        offline: true,
        sharedTable: node,
      }),
    ).reconcileAll();

    const items = await attention.list({ kind: 'provider_unreachable' });
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('open');
    expect(items[0]?.sourceId).toBe('scripted-test');
  });

  it('does not multiply the item across repeated outage reconciliation', async () => {
    // The §6 requirement, end to end: reconcile, reconcile, reconcile.
    const { executions, evaluator, attention } = memory();
    const node = new Map();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: node,
    });
    await running(executions, provider);
    const offline = wired(
      executions,
      evaluator,
      new ScriptedExecutionProvider({
        script: ['running'],
        offline: true,
        sharedTable: node,
      }),
    );
    for (let i = 0; i < 5; i++) await offline.reconcileAll();
    expect(await attention.list({ kind: 'provider_unreachable' })).toHaveLength(
      1,
    );
  });

  it('never turns an outage into a failed execution', async () => {
    // The invariant the reconciliation layer established, checked from the control
    // plane's side: the outage produced attention, not a bogus execution failure.
    const { executions, evaluator, attention } = memory();
    const node = new Map();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: node,
    });
    const submitted = await running(executions, provider);
    await wired(
      executions,
      evaluator,
      new ScriptedExecutionProvider({
        script: ['running'],
        offline: true,
        sharedTable: node,
      }),
    ).reconcileAll();
    expect((await executions.get(submitted.id))?.status).toBe('running');
    expect(await attention.list({ kind: 'execution_failed' })).toHaveLength(0);
  });
});

describe('recovery — condition cleared is not human resolved', () => {
  it('clears the outage condition when the provider comes back', async () => {
    const { executions, evaluator, attention } = memory();
    const node = new Map();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: node,
    });
    const submitted = await running(executions, provider);
    await wired(
      executions,
      evaluator,
      new ScriptedExecutionProvider({
        script: ['running'],
        offline: true,
        sharedTable: node,
      }),
    ).reconcileAll();
    const item = (await attention.list({ kind: 'provider_unreachable' }))[0]!;
    expect(item.conditionClearedAt).toBeNull();

    // Compute comes back.
    await wired(
      executions,
      evaluator,
      new ScriptedExecutionProvider({ script: ['running'], sharedTable: node }),
    ).reconcileAll();
    const recovered = await attention.get(item.id);
    // The condition is recorded as cleared…
    expect(recovered?.conditionClearedAt).not.toBeNull();
    // …and the item stops asking for attention…
    expect(needsAttention(recovered!)).toBe(false);
    // …but no human resolved anything, so it is still open. This distinction is
    // the point of the whole design: a system observation must not masquerade as
    // a human decision.
    expect(recovered?.status).toBe('open');
    expect(recovered?.resolvedAt).toBeNull();
    expect(await executions.get(submitted.id)).toBeTruthy();
  });

  it('clears evidence-pending once the result is retrieved', async () => {
    const { executions, evaluator, attention } = memory();
    const node = new Map();
    const provider = new ScriptedExecutionProvider({
      script: ['running'],
      sharedTable: node,
    });
    const submitted = await running(executions, provider);
    await wired(
      executions,
      evaluator,
      new ScriptedExecutionProvider({
        script: ['succeeded'],
        sharedTable: node,
      }),
    ).reconcileAll();
    const item = (
      await attention.list({ kind: 'execution_evidence_pending' })
    )[0];
    expect(item).toBeDefined();

    // The provider now serves the result, so the next cycle back-fills it.
    await wired(
      executions,
      evaluator,
      new ScriptedExecutionProvider({
        script: ['succeeded'],
        result: { stdout: 'the answer' },
        sharedTable: node,
      }),
    ).reconcileAll();
    expect((await executions.get(submitted.id))?.resultRetrieved).toBe(true);
    const after = await attention.get(item!.id);
    expect(after?.conditionClearedAt).not.toBeNull();
    expect(after?.status).toBe('open');
    expect(needsAttention(after!)).toBe(false);
  });

  it('never auto-resolves a failed execution', async () => {
    // Explicitly the §8 exception: reaching a terminal state is not being dealt
    // with. The human may still need to read it and decide.
    const { evaluator, attention } = memory();
    const failed = execution({ status: 'failed', error: 'exited 1' });
    for (let i = 0; i < 4; i++)
      await evaluator.evaluate({ executions: [failed] });
    const item = (await attention.list())[0]!;
    expect(item.status).toBe('open');
    expect(item.conditionClearedAt).toBeNull();
    expect(needsAttention(item)).toBe(true);
  });

  it('does not mark an acknowledged item resolved when its condition clears', async () => {
    const { evaluator, attention } = memory();
    await evaluator.evaluate({
      executions: [
        execution({
          reconciliationErrorCode: 'transport_failure',
          reconciliationError: 'connection refused',
        }),
      ],
    });
    const item = (await attention.list())[0]!;
    await attention.acknowledge(item.id);
    await evaluator.evaluate({
      executions: [
        execution({ reconciliationErrorCode: null, reconciliationError: null }),
      ],
    });
    const after = await attention.get(item.id);
    expect(after?.status).toBe('acknowledged');
    expect(after?.conditionClearedAt).not.toBeNull();
    expect(after?.resolvedAt).toBeNull();
  });
});

describe('acknowledgement and resolution', () => {
  it('acknowledging does not resolve the item', async () => {
    // The central distinction of §4, stated as a test.
    const { evaluator, attention } = memory();
    await evaluator.evaluate({ executions: [execution({ status: 'failed' })] });
    const item = (await attention.list())[0]!;
    const seen = await attention.acknowledge(item.id);
    expect(seen?.status).toBe('acknowledged');
    expect(seen?.acknowledgedAt).not.toBeNull();
    // Explicitly not resolved.
    expect(seen?.resolvedAt).toBeNull();
    // And it still needs a human, because the condition is still true.
    expect(needsAttention(seen!)).toBe(true);
  });

  it('acknowledging twice is stable rather than an error', async () => {
    const { evaluator, attention } = memory();
    await evaluator.evaluate({ executions: [execution({ status: 'failed' })] });
    const item = (await attention.list())[0]!;
    await attention.acknowledge(item.id);
    const twice = await attention.acknowledge(item.id);
    expect(twice?.status).toBe('acknowledged');
    expect(await attention.list()).toHaveLength(1);
  });

  it('resolving closes the item for good', async () => {
    const { evaluator, attention } = memory();
    await evaluator.evaluate({ executions: [execution({ status: 'failed' })] });
    const item = (await attention.list())[0]!;
    await attention.acknowledge(item.id);
    const done = await attention.resolve(item.id);
    expect(done?.status).toBe('resolved');
    expect(done?.resolvedAt).not.toBeNull();
    // Acknowledgement is preserved: what a person did stays in the record.
    expect(done?.acknowledgedAt).not.toBeNull();
    expect(needsAttention(done!)).toBe(false);
  });

  it('a resolved item is not silently reopened by a later acknowledgement', async () => {
    const { evaluator, attention } = memory();
    await evaluator.evaluate({ executions: [execution({ status: 'failed' })] });
    const item = (await attention.list())[0]!;
    await attention.resolve(item.id);
    await attention.acknowledge(item.id);
    expect((await attention.get(item.id))?.status).toBe('resolved');
  });

  it('reports nothing for an unknown item rather than inventing one', async () => {
    const { attention } = memory();
    expect(await attention.resolve('attn_missing')).toBeUndefined();
    expect(await attention.acknowledge('attn_missing')).toBeUndefined();
    expect(await attention.get('attn_missing')).toBeUndefined();
  });

  it('filters by status, kind and activity', async () => {
    const { evaluator, attention } = memory();
    await evaluator.evaluate({
      executions: [
        execution({ status: 'failed' }),
        execution({
          reconciliationErrorCode: 'transport_failure',
          reconciliationError: 'down',
        }),
      ],
    });
    expect(await attention.list()).toHaveLength(2);
    expect(await attention.list({ kind: 'execution_failed' })).toHaveLength(1);
    expect(await attention.list({ status: 'open' })).toHaveLength(2);
    expect(await attention.list({ active: true })).toHaveLength(2);

    const item = (await attention.list({ kind: 'provider_unreachable' }))[0]!;
    await attention.resolve(item.id);
    expect(await attention.list({ active: true })).toHaveLength(1);
    expect(await attention.list({ status: 'resolved' })).toHaveLength(1);
  });
});

describe('restart', () => {
  it('outstanding attention survives a restart', async () => {
    const first = durable();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const submitted = await running(first.executions, provider);
    await first.evaluator.evaluate({
      executions: [{ ...submitted, status: 'failed' }],
    });
    const before = await first.attention.list();
    expect(before).toHaveLength(1);
    first.close();

    // A new process. Same durable path, no memory of the item.
    const second = reopen(first.dir);
    const after = await second.attention.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.kind).toBe('execution_failed');
    expect(after[0]?.status).toBe('open');
    expect(needsAttention(after[0]!)).toBe(true);
  });

  it('honours a human decision made before the restart', async () => {
    const first = durable();
    // One execution, one identity, evaluated on both sides of the restart — so
    // this is genuinely the same condition and not two lookalikes.
    const failed = execution({ status: 'failed' });
    await first.evaluator.evaluate({ executions: [failed] });
    const item = (await first.attention.list())[0]!;
    await first.attention.resolve(item.id);
    first.close();

    const second = reopen(first.dir);
    // Re-evaluating the same still-true condition must not undo the decision.
    await second.evaluator.evaluate({ executions: [failed] });
    const after = await second.attention.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('resolved');
  });

  it('rebuilds the attention view from durable execution state alone', async () => {
    // What §5 asks for: the attention view reconstructable entirely from FeltDB.
    // A process starting with an empty registry must derive the same items from
    // the executions it finds, with no handover file and no memory.
    const first = durable();
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const submitted = await running(first.executions, provider);
    await first.executions.transition(submitted.id, 'failed', {
      errorCode: 'remote_execution_failure',
      error: 'the workload exited non-zero',
    });
    first.close();

    const second = reopen(first.dir);
    await second.evaluator.evaluate({
      executions: await second.executions.list(),
    });
    const items = await second.attention.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('execution_failed');
    expect(items[0]?.summary).toContain('exited non-zero');
  });
});
