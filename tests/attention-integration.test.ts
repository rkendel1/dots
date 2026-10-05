/**
 * The real control-plane path, end to end.
 *
 * ```
 *   Work → Task → Compute execution → ExecutionReconciler → FeltDB execution
 *        → AttentionEvaluator → FeltDB attention → API
 * ```
 *
 * ## Why no scripted provider here
 *
 * §19 asks for the real path, and this file is where that is proved. Everything
 * below the OpenDots boundary is real: `ComputeExecutionProvider` against the
 * `compute.remote@1` routes it actually calls, the real reconciler, the real
 * evaluator, real FeltDB, and the real Hono app. The only substitution is the
 * HTTP transport, because no Compute node is started by the suite.
 *
 * That substitution is narrow and checked rather than assumed: {@link computeNode}
 * answers only the routes Compute declares and 404s everything else, so an
 * invented endpoint fails loudly instead of quietly passing. The routes, status
 * vocabulary and job-identity format are transcribed from Compute's own source
 * and are independently pinned in `compute-provider-contract.test.ts`.
 *
 * `ScriptedExecutionProvider` is used in `attention.test.ts` for the domain rules
 * and in `compute-provider-contract.test.ts` for the wire protocol. Neither is on
 * this path.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openFeltState, type FeltState } from '../src/server/felt/state.js';
import { ExecutionStore } from '../src/server/executions.js';
import { ExecutionService } from '../src/server/execution-service.js';
import { ExecutionReconciler } from '../src/server/execution-reconciler.js';
import { ComputeExecutionProvider } from '../src/server/compute-execution-provider.js';
import { AttentionStore } from '../src/server/attention.js';
import { AttentionEvaluator } from '../src/server/attention-evaluator.js';
import { attentionRoutes } from '../src/server/attention-routes.js';
import { Store } from '../src/server/store.js';

/** A `JobId` exactly as `compute_core::JobId::generate` produces one. */
const JOB = `job_${'a'.repeat(64)}`;

const open: FeltState[] = [];
afterEach(() => {
  open.splice(0).forEach((s) => s.close());
});

/**
 * A Compute node, stubbed at the transport and nowhere else.
 *
 * `state` is mutable so a test can drive the same job from `running` to
 * `succeeded` across two reconciliation cycles, exactly as a real node would.
 */
function computeNode(initial: {
  status?: string;
  result?: unknown;
  receipt?: unknown;
}) {
  const state = {
    status: initial.status ?? 'running',
    result: initial.result,
    receipt: initial.receipt,
  };
  const seen: { method: string; path: string }[] = [];
  const reply = (json: unknown) =>
    new Response(JSON.stringify(json), { status: 200 });
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      seen.push({ method, path });
      // Only the routes Compute declares. Anything else 404s, which turns an
      // invented endpoint into a hard failure rather than a silent pass.
      if (path === '/compute/jobs' && method === 'POST')
        return reply({ job_id: JOB, status: 'accepted', request_id: 'req_1' });
      if (path === `/compute/jobs/${JOB}` && method === 'GET')
        return reply({ job_id: JOB, status: state.status });
      if (path === `/compute/jobs/${JOB}/result` && method === 'GET') {
        if (state.result === undefined)
          // Compute's own error envelope, as it reports evidence that has not been
          // sealed yet.
          return new Response(
            JSON.stringify({
              kind: 'result_not_available',
              message: 'result is not available',
            }),
            { status: 409 },
          );
        // Compute's `JobResult` envelope: the payload is nested under `result`,
        // so an unwrapped body would read as "no result published".
        return reply({ job_id: JOB, result: state.result });
      }
      if (path === `/compute/jobs/${JOB}/receipt` && method === 'GET') {
        if (state.receipt === undefined)
          // Compute's `ProviderError`, exactly as it reports a receipt that has not
          // been sealed yet: a failure kind and a recognisable message. There is no
          // distinct "not ready" kind, which is why the adapter re-labels this one
          // case rather than treating it as a broken node.
          return new Response(
            JSON.stringify({
              kind: 'remote_execution_failure',
              message: 'job receipt is not available',
            }),
            { status: 409 },
          );
        return reply(state.receipt);
      }
      return new Response('not found', { status: 404 });
    },
  ) as unknown as typeof fetch;
  return {
    seen,
    state,
    restore: () => {
      globalThis.fetch = original;
    },
    provider: new ComputeExecutionProvider({
      endpoint: 'http://compute.test:8080',
    }),
  };
}

/** The whole stack, wired as `index.ts` wires it. */
function stack(node: ReturnType<typeof computeNode>) {
  const state = openFeltState({
    memory: true,
    namespace: `opendots-attn-int-${randomUUID()}`,
  });
  open.push(state);
  const store = new Store(state.db);
  const executions = new ExecutionStore(state.db);
  const attention = new AttentionStore(state.db);
  const evaluator = new AttentionEvaluator(attention);
  const service = new ExecutionService(executions, node.provider);
  const reconciler = new ExecutionReconciler(executions, node.provider, {
    onCycleComplete: async ({ executions: settled }) => {
      await evaluator.evaluate({
        executions: settled,
        tasks: await store.tasks(),
      });
    },
  });
  const api = new Hono().route(
    '/api',
    attentionRoutes(attention, { executions, tasks: store }),
  );
  return { store, executions, attention, evaluator, service, reconciler, api };
}

describe('the real control-plane path', () => {
  it('carries a Compute failure all the way to the attention list', async () => {
    // The whole chain in one test: real adapter, real reconciler, real evaluator,
    // real durable state, real API.
    const node = computeNode({ status: 'failed' });
    try {
      const f = stack(node);

      // Work → Task
      const task = await f.store.createTask('audit the logs', null);

      // → Compute execution
      const { execution } = await f.service.request({
        prompt: 'audit the logs',
        taskId: task.id,
        idempotencyKey: randomUUID(),
      });
      expect(execution.status).toBe('running');
      // The submission really went to a route Compute declares.
      expect(node.seen).toContainEqual({
        method: 'POST',
        path: '/compute/jobs',
      });

      // → ExecutionReconciler → FeltDB execution state
      await f.reconciler.reconcileAll();
      const settled = await f.executions.get(execution.id);
      expect(settled?.status).toBe('failed');
      expect(settled?.provider).toBe('compute');
      expect(settled?.providerExecutionId).toBe(JOB);

      // → AttentionEvaluator → FeltDB attention
      const items = await f.attention.list();
      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe('execution_failed');
      expect(items[0]?.severity).toBe('critical');
      expect(items[0]?.sourceId).toBe(execution.id);

      // → API
      const body = (await (await f.api.request('/api/attention')).json()) as {
        attention: { kind: string }[];
        needsAttention: number;
      };
      expect(body.attention[0]?.kind).toBe('execution_failed');
      expect(body.needsAttention).toBe(1);

      // → and context resolves the live chain back to the Compute job.
      const context = (await (
        await f.api.request(`/api/attention/${items[0]?.id}/context`)
      ).json()) as {
        context: {
          task: { prompt: string } | null;
          execution: {
            provider: string;
            providerExecutionId: string;
          } | null;
        };
      };
      expect(context.context.task?.prompt).toBe('audit the logs');
      expect(context.context.execution?.provider).toBe('compute');
      expect(context.context.execution?.providerExecutionId).toBe(JOB);
    } finally {
      node.restore();
    }
  });

  it('keeps one item across many cycles of a real provider', async () => {
    // Idempotence proved against the real adapter, not a double.
    const node = computeNode({ status: 'failed' });
    try {
      const f = stack(node);
      await f.service.request({ prompt: 'go', idempotencyKey: randomUUID() });
      for (let i = 0; i < 5; i++) await f.reconciler.reconcileAll();
      expect(await f.attention.list()).toHaveLength(1);
    } finally {
      node.restore();
    }
  });

  it('retrieves a real result and raises nothing', async () => {
    // The happy path against Compute's actual `/result` and `/receipt` routes.
    const node = computeNode({
      status: 'succeeded',
      result: { exit_code: 0, stdout: { text: 'done' } },
      receipt: { job_id: JOB, receipt: { receipt_version: '1' } },
    });
    try {
      const f = stack(node);
      const { execution } = await f.service.request({
        prompt: 'go',
        idempotencyKey: randomUUID(),
      });
      await f.reconciler.reconcileAll();
      const settled = await f.executions.get(execution.id);
      expect(settled?.status).toBe('completed');
      expect(settled?.resultRetrieved).toBe(true);
      expect(settled?.result).toEqual({
        exit_code: 0,
        stdout: { text: 'done' },
      });
      expect(settled?.receipt).toMatchObject({ job_id: JOB });
      // A completion with its result and receipt in hand is not something to look
      // at. Success that is simply reported as success is the noise this whole
      // control plane exists to avoid.
      expect(await f.attention.list()).toHaveLength(0);
    } finally {
      node.restore();
    }
  });

  it('raises evidence-pending when a real completion withholds its result', async () => {
    // Compute answers a result it has not sealed with a non-2xx. The outcome is
    // terminal and the payload is not, and those are two different facts.
    const node = computeNode({ status: 'succeeded' });
    try {
      const f = stack(node);
      const { execution } = await f.service.request({
        prompt: 'go',
        idempotencyKey: randomUUID(),
      });
      await f.reconciler.reconcileAll();
      const settled = await f.executions.get(execution.id);
      expect(settled?.status).toBe('completed');
      expect(settled?.resultRetrieved).toBe(false);
      // A healthy provider must not be reported unreachable merely because its
      // evidence has not been sealed yet.
      expect(
        await f.attention.list({ kind: 'provider_unreachable' }),
      ).toHaveLength(0);
      const items = await f.attention.list({
        kind: 'execution_evidence_pending',
      });
      expect(items).toHaveLength(1);
      // Informational, not critical: nothing is wrong, something is just missing.
      expect(items[0]?.severity).toBe('info');
    } finally {
      node.restore();
    }
  });

  it('reports a real outage as one item, then clears it when Compute returns', async () => {
    const node = computeNode({ status: 'running' });
    const original = globalThis.fetch;
    try {
      const f = stack(node);
      await f.service.request({ prompt: 'go', idempotencyKey: randomUUID() });
      await f.reconciler.reconcileAll();
      expect(await f.attention.list()).toHaveLength(0);

      // Compute goes away entirely.
      globalThis.fetch = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      await f.reconciler.reconcileAll();
      const outage = await f.attention.list({ kind: 'provider_unreachable' });
      expect(outage).toHaveLength(1);
      expect(outage[0]?.sourceId).toBe('compute');
      // The execution itself is untouched: an outage is not a failure.
      expect(
        (await f.executions.list()).every((e) => e.status === 'running'),
      ).toBe(true);

      // Compute comes back, and the job finished while it was gone.
      node.state.status = 'succeeded';
      node.state.result = { exit_code: 0, stdout: { text: 'done' } };
      globalThis.fetch = original;
      await f.reconciler.reconcileAll();

      const after = await f.attention.get(outage[0]!.id);
      expect(after?.conditionClearedAt).not.toBeNull();
      // Cleared by observation, not resolved by a human. Nobody decided anything;
      // the provider simply stopped being unreachable.
      expect(after?.status).toBe('open');
      expect(after?.resolvedAt).toBeNull();
      // And the work itself completed, which is the real point of surviving an
      // outage rather than failing during one.
      expect(
        (await f.executions.list()).every((e) => e.status === 'completed'),
      ).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
