/**
 * The attention HTTP surface.
 *
 * These prove three things about the API specifically:
 *
 *   1. **It is a read of a decision, not a command channel.** There is no route
 *      that lets a client create an item, change its kind or severity, or set an
 *      execution's status. A client can only read what the evaluator derived and
 *      record what a human decided.
 *   2. **Acknowledging is not resolving**, over the wire, where a UI would
 *      actually rely on the difference.
 *   3. **Context is resolved live**, so changing the underlying execution changes
 *      what the context endpoint reports — proving nothing was cached on the item.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { openFeltState, type FeltState } from '../src/server/felt/state.js';
import { ExecutionStore } from '../src/server/executions.js';
import { ExecutionService } from '../src/server/execution-service.js';
import { ExecutionReconciler } from '../src/server/execution-reconciler.js';
import { AttentionStore } from '../src/server/attention.js';
import { AttentionEvaluator } from '../src/server/attention-evaluator.js';
import { attentionRoutes } from '../src/server/attention-routes.js';
import { attentionIdFor } from '../src/server/attention-collections.js';
import { Store } from '../src/server/store.js';
import { ScriptedExecutionProvider } from './helpers/scripted-execution-provider.js';

const open: FeltState[] = [];
afterEach(() => open.splice(0).forEach((state) => state.close()));

const post = (body: unknown = {}) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

/**
 * The API wired to a real store, a real evaluator and a real reconciler.
 *
 * Nothing is stubbed except the provider, which is unavoidable here: the contract
 * that matters is OpenDots', and the provider's own is proved separately.
 */
function fixture(options: { script?: string[] } = {}) {
  const state = openFeltState({
    memory: true,
    namespace: `opendots-attn-api-${randomUUID()}`,
  });
  open.push(state);
  const store = new Store(state.db);
  const executions = new ExecutionStore(state.db);
  const attention = new AttentionStore(state.db);
  const evaluator = new AttentionEvaluator(attention);
  const provider = new ScriptedExecutionProvider(
    options.script ? { script: options.script } : {},
  );
  const service = new ExecutionService(executions, provider);
  const reconciler = new ExecutionReconciler(executions, provider, {
    onCycleComplete: async ({ executions: settled }) => {
      await evaluator.evaluate({
        executions: settled,
        tasks: await store.tasks(),
      });
    },
  });
  const app = new Hono().route(
    '/api',
    attentionRoutes(attention, { executions, tasks: store }),
  );
  return {
    app,
    store,
    executions,
    attention,
    evaluator,
    provider,
    service,
    reconciler,
  };
}

const post_ = async (app: Hono, path: string) =>
  app.request(`/api${path}`, post());

async function failedExecution(f: ReturnType<typeof fixture>) {
  const { execution } = await f.service.request({
    prompt: 'go',
    idempotencyKey: randomUUID(),
  });
  await f.executions.transition(execution.id, 'failed', {
    errorCode: 'remote_execution_failure',
    error: 'the workload exited non-zero',
  });
  await f.evaluator.evaluate({ executions: await f.executions.list() });
  return execution;
}

describe('listing', () => {
  it('reports nothing to attend to before anything has happened', async () => {
    const { app } = fixture();
    const response = await app.request('/api/attention');
    const body = (await response.json()) as {
      attention: unknown[];
      needsAttention: number;
    };
    expect(body.attention).toEqual([]);
    expect(body.needsAttention).toBe(0);
  });

  it('lists the items the evaluator derived, with the outstanding count', async () => {
    const f = fixture();
    await failedExecution(f);
    const body = (await (await app(f)).json()) as {
      attention: { kind: string; status: string }[];
      needsAttention: number;
    };
    expect(body.attention).toHaveLength(1);
    expect(body.attention[0]?.kind).toBe('execution_failed');
    expect(body.attention[0]?.status).toBe('open');
    expect(body.needsAttention).toBe(1);
  });

  it('filters by kind, status and active', async () => {
    const f = fixture();
    await failedExecution(f);
    expect(
      (
        (await (await app(f, '?kind=execution_failed')).json()) as {
          attention: unknown[];
        }
      ).attention,
    ).toHaveLength(1);
    expect(
      (
        (await (await app(f, '?kind=provider_unreachable')).json()) as {
          attention: unknown[];
        }
      ).attention,
    ).toHaveLength(0);
    expect(
      (
        (await (await app(f, '?status=resolved')).json()) as {
          attention: unknown[];
        }
      ).attention,
    ).toHaveLength(0);
    expect(
      (
        (await (await app(f, '?active=true')).json()) as {
          attention: unknown[];
        }
      ).attention,
    ).toHaveLength(1);
  });

  it('rejects an unknown filter rather than reporting an empty list', async () => {
    // A UI that mistypes a kind must not be shown "nothing needs attention" — the
    // most dangerous possible answer to give a person who needs something.
    const { app } = fixture();
    expect((await app.request('/api/attention?kind=nonsense')).status).toBe(
      400,
    );
    expect((await app.request('/api/attention?status=nonsense')).status).toBe(
      400,
    );
  });

  it('reads one item, and 404s an unknown one', async () => {
    const f = fixture();
    const execution = await failedExecution(f);
    const id = attentionIdFor('execution_failed', 'execution', execution.id);
    const body = (await (await app(f, `/${id}`)).json()) as {
      attention: { id: string };
    };
    expect(body.attention.id).toBe(id);
    expect((await f.app.request('/api/attention/attn_nope')).status).toBe(404);
  });
});

/** Request helper: the fixture's app under `/api`. */
function app(f: ReturnType<typeof fixture>, query = '') {
  return f.app.request(`/api/attention${query}`);
}

describe('human actions over the API', () => {
  it('acknowledges without resolving', async () => {
    // The §4 distinction, where a UI depends on it.
    const f = fixture();
    const execution = await failedExecution(f);
    const id = attentionIdFor('execution_failed', 'execution', execution.id);
    const response = await post_(f.app, `/attention/${id}/acknowledge`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attention: { status: string; resolvedAt: number | null };
      needsAttention: boolean;
    };
    expect(body.attention.status).toBe('acknowledged');
    expect(body.attention.resolvedAt).toBeNull();
    // Still outstanding: the condition is still true.
    expect(body.needsAttention).toBe(true);
  });

  it('resolves through the API, and the item leaves the active set', async () => {
    const f = fixture();
    const execution = await failedExecution(f);
    const id = attentionIdFor('execution_failed', 'execution', execution.id);
    const body = (await (
      await post_(f.app, `/attention/${id}/resolve`)
    ).json()) as {
      attention: { status: string; resolvedAt: number | null };
      needsAttention: boolean;
    };
    expect(body.attention.status).toBe('resolved');
    expect(body.attention.resolvedAt).not.toBeNull();
    expect(body.needsAttention).toBe(false);
    const listed = (await (await app(f, '?active=true')).json()) as {
      attention: unknown[];
    };
    expect(listed.attention).toHaveLength(0);
  });

  it('404s an action on an unknown item', async () => {
    const f = fixture();
    expect(
      (await post_(f.app, '/attention/attn_nope/acknowledge')).status,
    ).toBe(404);
    expect((await post_(f.app, '/attention/attn_nope/resolve')).status).toBe(
      404,
    );
  });

  it('offers no way to create, edit or invent an attention item', async () => {
    // §14: this PR is about attention, not command expansion. A client that could
    // POST an item could fabricate a "critical" problem out of nothing.
    const f = fixture();
    expect(
      (
        await f.app.request(
          '/api/attention',
          post({ kind: 'execution_failed' }),
        )
      ).status,
    ).toBe(404);
    const id = attentionIdFor('execution_failed', 'execution', 'exec_x');
    for (const verb of ['PUT', 'PATCH', 'DELETE']) {
      const response = await f.app.request(`/api/attention/${id}`, {
        method: verb,
        body: JSON.stringify({ status: 'resolved', severity: 'info' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(response.status).toBe(404);
    }
  });
});

describe('context', () => {
  it('resolves the live execution behind an item', async () => {
    const f = fixture();
    const execution = await failedExecution(f);
    const id = attentionIdFor('execution_failed', 'execution', execution.id);
    const body = (await (
      await f.app.request(`/api/attention/${id}/context`)
    ).json()) as {
      context: {
        execution: { id: string; status: string; error: string } | null;
        sourceMissing: boolean;
      };
    };
    expect(body.context.execution?.id).toBe(execution.id);
    expect(body.context.execution?.status).toBe('failed');
    expect(body.context.execution?.error).toContain('exited non-zero');
    expect(body.context.sourceMissing).toBe(false);
  });

  it('walks through to the task and its runs', async () => {
    // Work → Task → Execution → Compute job, resolved server-side rather than by
    // the browser stitching three responses together.
    const f = fixture();
    const task = await f.store.createTask('watch the sky', null);
    const { execution } = await f.service.request({
      prompt: 'go',
      taskId: task.id,
      idempotencyKey: randomUUID(),
    });
    await f.executions.transition(execution.id, 'failed', {
      error: 'the workload exited non-zero',
    });
    await f.evaluator.evaluate({
      executions: await f.executions.list(),
      tasks: await f.store.tasks(),
    });
    const id = attentionIdFor('execution_failed', 'execution', execution.id);
    const body = (await (
      await f.app.request(`/api/attention/${id}/context`)
    ).json()) as {
      context: {
        task: { id: string; prompt: string } | null;
        execution: { taskId: string } | null;
      };
    };
    expect(body.context.task?.id).toBe(task.id);
    expect(body.context.task?.prompt).toBe('watch the sky');
    expect(body.context.execution?.taskId).toBe(task.id);
  });

  it('reflects the execution state now, not the state when the item was raised', async () => {
    // The §10 requirement, and the reason context is not stored on the item. An
    // execution that has moved on must not be reported as it was.
    const f = fixture();
    const submitted = await f.service.request({
      prompt: 'go',
      idempotencyKey: randomUUID(),
    });
    // An evidence-pending item raised while the execution is unfinished.
    await f.executions.transition(submitted.execution.id, 'completed', {
      resultRetrieved: false,
    });
    await f.evaluator.evaluate({ executions: await f.executions.list() });
    const id = attentionIdFor(
      'execution_evidence_pending',
      'execution',
      submitted.execution.id,
    );

    const before = (await (
      await f.app.request(`/api/attention/${id}/context`)
    ).json()) as { context: { execution: { resultRetrieved: boolean } } };
    expect(before.context.execution.resultRetrieved).toBe(false);

    // The result arrives. The attention item is untouched…
    await f.executions.recordEvidence(submitted.execution.id, {
      result: { stdout: 'the answer' },
      resultRetrieved: true,
    });
    const stored = (await f.attention.get(id)) as unknown as Record<
      string,
      unknown
    >;
    // …which is the point: the item holds no execution state at all to go stale.
    expect(stored.resultRetrieved).toBeUndefined();
    expect(stored.result).toBeUndefined();

    // …and context, read again, reports the current truth.
    const after = (await (
      await f.app.request(`/api/attention/${id}/context`)
    ).json()) as { context: { execution: { resultRetrieved: boolean } } };
    expect(after.context.execution.resultRetrieved).toBe(true);
  });

  it('reports a deleted source as missing rather than rendering nothing', async () => {
    const f = fixture();
    await f.service.request({ prompt: 'go', idempotencyKey: randomUUID() });
    // An item pointing at an execution that is not there.
    await f.attention.raise({
      kind: 'execution_failed',
      severity: 'critical',
      title: 'An execution failed',
      summary: 'gone',
      sourceType: 'execution',
      sourceId: 'exec_deleted',
    });
    const id = attentionIdFor('execution_failed', 'execution', 'exec_deleted');
    const body = (await (
      await f.app.request(`/api/attention/${id}/context`)
    ).json()) as {
      context: { execution: unknown; sourceMissing: boolean };
    };
    expect(body.context.execution).toBeNull();
    expect(body.context.sourceMissing).toBe(true);
  });

  it('carries no execution state of its own on the item', async () => {
    // Guards against a future change quietly copying execution fields onto the
    // attention record, which would reintroduce exactly the staleness this design
    // exists to avoid. `status` is deliberately exempt: that is the *attention*
    // status, the item's own business, and has nothing to do with the execution's.
    const f = fixture();
    const execution = await failedExecution(f);
    const item = (await f.attention.list())[0]!;
    const forbidden = [
      'result',
      'receipt',
      'providerStatus',
      'providerExecutionId',
      'resultRetrieved',
      'completedAt',
      'error',
      'errorCode',
    ];
    for (const field of forbidden)
      expect(Object.keys(item)).not.toContain(field);
    // A reference, not a copy.
    expect(item.sourceId).toBe(execution.id);
    expect(item.status).toBe('open');
  });

  it('404s context for an unknown item', async () => {
    const f = fixture();
    expect(
      (await f.app.request('/api/attention/attn_nope/context')).status,
    ).toBe(404);
  });
});
