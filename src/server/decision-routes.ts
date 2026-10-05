/**
 * Decision routes, following this repository's existing router convention.
 *
 * Mounted by `app.ts` as `app.route('/api', decisionRoutes(...))`. Every handler
 * goes through `DecisionStore` and `AttentionStore`; none of them touches FeltDB
 * directly.
 *
 *   GET  /attention/:id/decisions          list all decisions for an item
 *   POST /attention/:id/decisions          create a decision and apply if possible
 *
 * Decisions are immutable and append-only. A successful POST creates or returns
 * the existing decision record if identical (idempotent by decision identity).
 * Decisions are never edited or deleted — if a human changes their mind, that is
 * a new decision record.
 *
 * Application is synchronous: decisions with corresponding operations (currently
 * only `dismiss` → `resolve`) are applied as part of the POST. The response
 * distinguishes between decision recorded and action applied.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { DecisionValue } from '../shared/types.js';
import type { AttentionStore } from './attention.js';
import type { DecisionStore } from './decisions.js';
import type { DecisionApplicator } from './decision-applicator.js';
import { isLegalDecision, legalDecisionsFor } from './decision-vocabulary.js';

export interface DecisionRouteOptions {
  decisions: DecisionStore;
  attention: AttentionStore;
  applicator: DecisionApplicator;
  ownerId: string;
}

export function decisionRoutes(options: DecisionRouteOptions): Hono {
  const app = new Hono();
  const { decisions, attention, applicator, ownerId } = options;

  /**
   * List all decisions for an attention item.
   *
   * Returns decisions in chronological order (oldest first), showing complete
   * history even if a human changed their mind multiple times.
   */
  app.get('/attention/:id/decisions', async (c) => {
    const attentionId = c.req.param('id');
    const item = await attention.get(attentionId);
    if (!item) return c.json({ error: 'Attention item not found.' }, 404);

    const decisionList = await decisions.listForAttention(attentionId);
    const legalDecisions = legalDecisionsFor(item.kind);

    return c.json({
      decisions: decisionList,
      legalDecisions,
      attention: item,
    });
  });

  /**
   * Create a decision about an attention item.
   *
   * Validates that:
   * 1. The attention item exists
   * 2. The decision is in the legal vocabulary for this kind
   * 3. The request is well-formed
   *
   * The request body should identify the decision:
   *   { "decision": "approve" }
   *
   * The actor is the authenticated/application human identity (ownerId).
   * The decision is idempotent: identical submissions return the same record.
   */
  app.post('/attention/:id/decisions', async (c) => {
    const attentionId = c.req.param('id');
    const parsed = z
      .object({
        decision: z.enum(['approve', 'reject', 'retry', 'dismiss'] as const),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));

    if (!parsed.success)
      return c.json(
        {
          error: 'Send a decision: "approve", "reject", "retry", or "dismiss".',
        },
        400,
      );

    const item = await attention.get(attentionId);
    if (!item) return c.json({ error: 'Attention item not found.' }, 404);

    const decision = parsed.data.decision as DecisionValue;
    if (!isLegalDecision(item.kind, decision))
      return c.json(
        {
          error: `Decision "${decision}" is not legal for attention kind "${item.kind}".`,
          legalDecisions: legalDecisionsFor(item.kind),
        },
        400,
      );

    const { decision: created } = await decisions.create({
      attentionId,
      decision,
      actorType: 'human',
      actorId: ownerId,
    });

    // Apply the decision if a real operation exists for it.
    const applicationResult = await applicator.apply(created);

    return c.json(
      {
        decision: created,
        applied: applicationResult.applied,
        applicationError: applicationResult.error,
      },
      201,
    );
  });

  return app;
}

export { legalDecisionsFor };
