/**
 * Execution API tests.
 *
 * These drive the real router over the real durable store, so what is proven is
 * `API → domain → FeltDB`, not a mocked call chain. The provider is the scripted
 * one from `tests/helpers`, because this suite is about OpenDots' own behaviour;
 * the Compute adapter is proved separately in `compute-provider-contract.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { openFeltState } from '../src/server/felt/state.js';
import { ExecutionStore } from '../src/server/executions.js';
import { ExecutionService } from '../src/server/execution-service.js';
import { ExecutionReconciler } from '../src/server/execution-reconciler.js';
import { executionRoutes } from '../src/server/execution-routes.js';
import { ScriptedExecutionProvider } from './helpers/scripted-execution-provider.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture(provider?: ScriptedExecutionProvider) {
  const state = openFeltState({
    memory: true,
    namespace: `opendots-exec-api-${randomUUID()}`,
  });
  cleanup.push(() => state.close());
  const executions = new ExecutionStore(state.db);
  const service = new ExecutionService(executions, provider);
  // The reconciler is what a read consults, so the API is tested with one
  // attached — the same shape the server builds.
  const reconciler = new ExecutionReconciler(executions, provider);
  const app = new Hono().route('/api', executionRoutes(service, reconciler));
  return { executions, service, reconciler, app, provider };
}

function post(body: unknown, method = 'POST') {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const key = () => randomUUID();

const create = (app: Hono, body: Record<string, unknown>) =>
  app.request('/api/executions', post(body));

describe('execution API', () => {
  it('creates an execution and returns it', async () => {
    const { app, executions } = fixture(new ScriptedExecutionProvider());
    const response = await create(app, {
      prompt: 'do the thing',
      idempotencyKey: key(),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      execution: { id: string; status: string; prompt: string };
      created: boolean;
    };
    expect(body.created).toBe(true);
    expect(body.execution.prompt).toBe('do the thing');
    // And it really reached FeltDB, not just the response.
    expect((await executions.get(body.execution.id))?.id).toBe(
      body.execution.id,
    );
  });

  it('answers a repeated key with the same execution and created:false', async () => {
    const { app, executions } = fixture(new ScriptedExecutionProvider());
    const idempotencyKey = key();
    const first = (await (
      await create(app, { prompt: 'once', idempotencyKey })
    ).json()) as { execution: { id: string } };
    const response = await create(app, { prompt: 'once', idempotencyKey });
    expect(response.status).toBe(200);
    const second = (await response.json()) as {
      execution: { id: string };
      created: boolean;
    };
    expect(second.created).toBe(false);
    expect(second.execution.id).toBe(first.execution.id);
    expect(await executions.list()).toHaveLength(1);
  });

  it('reports that no provider is configured, rather than pretending', async () => {
    const { app } = fixture();
    const response = await create(app, {
      prompt: 'go',
      idempotencyKey: key(),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /No execution provider is configured/,
    );
  });

  it('lists executions and names the provider', async () => {
    const { app } = fixture(new ScriptedExecutionProvider());
    await create(app, { prompt: 'go', idempotencyKey: key() });
    const body = (await (await app.request('/api/executions')).json()) as {
      executions: unknown[];
      provider: string | null;
    };
    expect(body.executions).toHaveLength(1);
    expect(body.provider).toBe('scripted-test');
  });

  it('reports a null provider when none is configured', async () => {
    const { app } = fixture();
    const body = (await (await app.request('/api/executions')).json()) as {
      executions: unknown[];
      provider: string | null;
    };
    expect(body.provider).toBeNull();
  });

  it('filters a list by task', async () => {
    const { app } = fixture(new ScriptedExecutionProvider());
    await create(app, { prompt: 'a', taskId: 'task-1', idempotencyKey: key() });
    await create(app, { prompt: 'b', taskId: 'task-2', idempotencyKey: key() });
    const body = (await (
      await app.request('/api/executions?taskId=task-1')
    ).json()) as { executions: { prompt: string }[] };
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0]?.prompt).toBe('a');
  });

  it('reads one execution back, reconciled', async () => {
    const { app } = fixture(
      new ScriptedExecutionProvider({ script: ['succeeded'] }),
    );
    const created = (await (
      await create(app, { prompt: 'go', idempotencyKey: key() })
    ).json()) as { execution: { id: string } };
    const body = (await (
      await app.request(`/api/executions/${created.execution.id}`)
    ).json()) as { execution: { status: string } };
    expect(body.execution.status).toBe('completed');
  });

  it('cancels through the API', async () => {
    const provider = new ScriptedExecutionProvider();
    const { app } = fixture(provider);
    const created = (await (
      await create(app, { prompt: 'go', idempotencyKey: key() })
    ).json()) as { execution: { id: string } };
    const response = await app.request(
      `/api/executions/${created.execution.id}/cancel`,
      post({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { execution: { status: string } };
    expect(body.execution.status).toBe('cancelled');
    expect(provider.cancelled).toHaveLength(1);
  });

  it('404s an unknown execution rather than inventing one', async () => {
    const { app } = fixture(new ScriptedExecutionProvider());
    expect((await app.request('/api/executions/nope')).status).toBe(404);
    expect(
      (await app.request('/api/executions/nope/cancel', post({}))).status,
    ).toBe(404);
  });

  it('rejects malformed requests', async () => {
    const { app } = fixture(new ScriptedExecutionProvider());
    // No idempotency key at all.
    expect((await create(app, { prompt: 'go' })).status).toBe(400);
    // A key Compute would refuse.
    expect(
      (await create(app, { prompt: 'go', idempotencyKey: 'bad\nkey' })).status,
    ).toBe(400);
    // An empty prompt.
    expect(
      (await create(app, { prompt: '   ', idempotencyKey: key() })).status,
    ).toBe(400);
  });

  it('exposes reconciliation state so the UI need not infer it', async () => {
    // §11: a user must be able to tell "running" from "running — provider
    // temporarily unreachable", and "completed" from "completed — result pending".
    // Every field here is read from the durable record; none is computed here.
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const { app } = fixture(provider);
    const created = (await (
      await create(app, { prompt: 'go', idempotencyKey: key() })
    ).json()) as { execution: { id: string } };

    const healthy = (await (
      await app.request(`/api/executions/${created.execution.id}`)
    ).json()) as { execution: Record<string, unknown> };
    expect(healthy.execution.status).toBe('running');
    expect(healthy.execution.lastReconciledAt).toBeGreaterThan(0);
    expect(healthy.execution.reconciliationError).toBeNull();
    expect(healthy.execution.resultRetrieved).toBe(false);
    expect(healthy.execution.receipt).toBeNull();

    // Now take the provider away and read again.
    const offline = fixture(new ScriptedExecutionProvider({ offline: true }));
    const createdOffline = (await (
      await create(offline.app, { prompt: 'go', idempotencyKey: key() })
    ).json()) as { execution: { id: string } };
    const degraded = (await (
      await offline.app.request(
        `/api/executions/${createdOffline.execution.id}`,
      )
    ).json()) as { execution: Record<string, unknown> };
    expect(degraded.execution.status).toBe('running');
    expect(degraded.execution.reconciliationError).toMatch(/unreachable/);
    expect(degraded.execution.reconciliationErrorCode).toBe(
      'transport_failure',
    );
    // The UI can now say "provider temporarily unreachable" from the response.
    expect(provider.started).toHaveLength(1);
  });

  it('reconciles on demand and reports what the cycle did', async () => {
    const provider = new ScriptedExecutionProvider({ script: ['running'] });
    const { app } = fixture(provider);
    await create(app, { prompt: 'go', idempotencyKey: key() });
    const response = await app.request('/api/executions/reconcile', post({}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      summary: { considered: number };
      lastRunAt: number;
    };
    expect(body.summary.considered).toBe(1);
    expect(body.lastRunAt).toBeGreaterThan(0);
  });

  it('refuses a manual reconcile with no provider, rather than pretending', async () => {
    const { app } = fixture();
    const response = await app.request('/api/executions/reconcile', post({}));
    expect(response.status).toBe(503);
  });

  it('offers no way to set an execution status directly', async () => {
    const { app } = fixture(new ScriptedExecutionProvider());
    for (const method of ['PATCH', 'PUT']) {
      const response = await app.request(
        '/api/executions/anything',
        post({ status: 'completed' }, method),
      );
      // The router has no such route, so this can never succeed.
      expect(response.status).toBe(404);
    }
  });
});
