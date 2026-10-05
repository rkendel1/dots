/**
 * Attention routes, following this repository's existing router convention.
 *
 * Mounted by `app.ts` as `app.route('/api', attentionRoutes(...))`, the same way
 * `executionRoutes` and `workspaceRoutes` are. Every handler goes through
 * `AttentionStore`; none of them touches FeltDB directly.
 *
 *   GET  /attention                    list, filtered by status / kind / active
 *   GET  /attention/:id                read one
 *   GET  /attention/:id/context        read the live Work/Task/Execution chain
 *   GET  /attention/:id/history        durable causal chain (requires decisions/applicator)
 *   POST /attention/:id/acknowledge    "I have seen this"
 *   POST /attention/:id/resolve        "this no longer needs anyone"
 *
 * The surface is deliberately two actions. This is a control plane for deciding
 * what matters, not a command channel: there is no retry, no edit, no
 * "change provider", and no way to set an attention item's kind, severity or
 * source. A client cannot manufacture attention — it can only read what the
 * evaluator derived from durable state, and say what a human decided about it.
 *
 * Context is a separate endpoint rather than a field on the item because it is
 * *not* a property of the item. It is resolved live from the records the item
 * references, so it must not be able to be cached alongside a list.
 *
 * History is a separate endpoint and read model: it reconstructs the durable
 * causal chain (Attention → Decision → Application) from existing records.
 */
import { Hono } from 'hono';
import type { AttentionKind, AttentionStatus } from '../shared/types.js';
import type { AttentionStore } from './attention.js';
import { needsAttention } from './attention.js';
import { resolveContext } from './attention-context.js';
import type { ExecutionStore } from './executions.js';
import type { Store } from './store.js';
import { attentionIdFor } from './attention-collections.js';
import type { DecisionStore } from './decisions.js';
import type { DecisionApplicator } from './decision-applicator.js';
import { buildAttentionHistory } from './attention-history.js';

const KINDS: AttentionKind[] = [
  'execution_failed',
  'execution_blocked',
  'execution_evidence_pending',
  'provider_unreachable',
  'human_decision_required',
];
const STATUSES: AttentionStatus[] = ['open', 'acknowledged', 'resolved'];

export interface AttentionRoutesOptions {
  store: AttentionStore;
  sources: { executions: ExecutionStore; tasks: Store };
  decisions?: DecisionStore;
  applicator?: DecisionApplicator;
}

export function attentionRoutes(
  storeOrOptions: AttentionStore | AttentionRoutesOptions,
  sourcesOrUndefined?: { executions: ExecutionStore; tasks: Store },
): Hono {
  // Support both old and new calling conventions for backward compatibility
  const store =
    storeOrOptions instanceof Object && 'store' in storeOrOptions
      ? storeOrOptions.store
      : (storeOrOptions as AttentionStore);
  const sources =
    sourcesOrUndefined ?? (storeOrOptions as AttentionRoutesOptions).sources;
  const decisions = (storeOrOptions as AttentionRoutesOptions).decisions;
  const applicator = (storeOrOptions as AttentionRoutesOptions).applicator;
  const app = new Hono();

  app.get('/attention', async (c) => {
    const status = c.req.query('status');
    const kind = c.req.query('kind');
    // An unknown filter is a client error rather than a silently empty list: a UI
    // that mistypes a kind must not be shown "nothing needs attention".
    if (status !== undefined && !STATUSES.includes(status as AttentionStatus))
      return c.json({ error: `Unknown status "${status}".` }, 400);
    if (kind !== undefined && !KINDS.includes(kind as AttentionKind))
      return c.json({ error: `Unknown kind "${kind}".` }, 400);

    const items = await store.list({
      ...(status ? { status: status as AttentionStatus } : {}),
      ...(kind ? { kind: kind as AttentionKind } : {}),
      ...(c.req.query('active') === 'true' ? { active: true } : {}),
    });
    return c.json({
      attention: items,
      // Counted here so the UI does not have to reimplement the rule and get it
      // subtly wrong. `needsAttention` is the single definition of "still true".
      needsAttention: items.filter(needsAttention).length,
    });
  });

  app.get('/attention/:id', async (c) => {
    const item = await store.get(c.req.param('id'));
    if (!item) return c.json({ error: 'Attention item not found.' }, 404);
    return c.json({ attention: item, needsAttention: needsAttention(item) });
  });

  app.get('/attention/:id/context', async (c) => {
    const item = await store.get(c.req.param('id'));
    if (!item) return c.json({ error: 'Attention item not found.' }, 404);
    // Read live, every time. The execution may have moved on since the item was
    // raised, and reporting the state it had then would be a stale answer to a
    // question about the present.
    const execution =
      item.sourceType === 'execution'
        ? ((await sources.executions.get(item.sourceId)) ?? null)
        : null;
    const taskId =
      item.sourceType === 'task' ? item.sourceId : (execution?.taskId ?? null);
    // `detail` is the existing task read, reused rather than reimplemented — it
    // already resolves the task with its runs and events.
    const detail = taskId ? await sources.tasks.detail(taskId) : null;
    return c.json({
      context: resolveContext(item, {
        execution,
        task: detail?.task ?? null,
        runs: (detail?.runs ?? []).slice(0, 5),
      }),
    });
  });

  app.get('/attention/:id/history', async (c) => {
    const attentionId = c.req.param('id');
    const item = await store.get(attentionId);
    if (!item) return c.json({ error: 'Attention item not found.' }, 404);

    // History requires decisions and applicator. If not provided, history is empty.
    if (!decisions || !applicator) {
      return c.json({ history: { events: [] } });
    }

    const decisionList = await decisions.listForAttention(attentionId);
    const applicationMap = await applicator.getApplications(
      decisionList.map((d) => d.id),
    );

    const history = buildAttentionHistory(item, decisionList, applicationMap);
    return c.json({ history });
  });

  app.post('/attention/:id/acknowledge', async (c) => {
    const item = await store.acknowledge(c.req.param('id'));
    if (!item) return c.json({ error: 'Attention item not found.' }, 404);
    // Acknowledged, not resolved: the response says so, because the whole point
    // of the distinction is that a client must not present this as "done".
    return c.json({ attention: item, needsAttention: needsAttention(item) });
  });

  app.post('/attention/:id/resolve', async (c) => {
    const item = await store.resolve(c.req.param('id'));
    if (!item) return c.json({ error: 'Attention item not found.' }, 404);
    return c.json({ attention: item, needsAttention: needsAttention(item) });
  });

  return app;
}

/**
 * The id a given condition would have.
 *
 * Exported for tests and for tooling that needs to address an item it knows the
 * condition of without listing first. The same function the store uses, so a
 * caller cannot compute a different answer than the one that was written.
 */
export { attentionIdFor };
