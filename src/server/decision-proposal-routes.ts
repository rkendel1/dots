/**
 * Decision proposal routes.
 *
 * Mounted as part of attention routes, proposals are purely advisory.
 * They provide the durable API for agents to suggest decisions but do not
 * authorize or execute anything.
 *
 *   GET  /attention/:id/proposals          list all proposals
 *   POST /attention/:id/proposals          create a proposal
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AttentionStore } from './attention.js';
import type { DecisionProposalStore } from './decision-proposals.js';

export interface DecisionProposalRouteOptions {
  attention: AttentionStore;
  proposals: DecisionProposalStore;
}

export function decisionProposalRoutes(
  options: DecisionProposalRouteOptions,
): Hono {
  const app = new Hono();
  const { attention, proposals } = options;

  /**
   * List all proposals for an attention item.
   */
  app.get('/attention/:id/proposals', async (c) => {
    const attentionId = c.req.param('id');
    const item = await attention.get(attentionId);
    if (!item) return c.json({ error: 'Attention item not found.' }, 404);

    const proposalList = await proposals.listForAttention(attentionId);
    return c.json({ proposals: proposalList, attention: item });
  });

  /**
   * Create a proposal.
   *
   * The proposal must reference an existing Attention and suggest a decision
   * legal for that Attention's kind. The request identifies the agent,
   * decision, and rationale, but the server derives the attention context.
   */
  app.post('/attention/:id/proposals', async (c) => {
    const attentionId = c.req.param('id');

    const body = await c.req.json();
    const input = z
      .object({
        agentId: z.string().min(1),
        agentVersion: z.string().optional(),
        decision: z
          .enum(['approve', 'reject', 'retry', 'dismiss'])
          .refine((d) => d),
        rationale: z.string().min(1),
      })
      .safeParse(body);

    if (!input.success) {
      return c.json(
        {
          error: 'Invalid request',
          issues: input.error.issues,
        },
        400,
      );
    }

    try {
      const { proposal, created } = await proposals.create({
        attentionId,
        agentId: input.data.agentId,
        agentVersion: input.data.agentVersion,
        decision: input.data.decision,
        rationale: input.data.rationale,
      });

      // Return 201 for a newly created proposal, 200 if idempotent
      return c.json(
        {
          proposal,
          created,
        },
        created ? 201 : 200,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes('not found')) {
        return c.json({ error: errorMsg }, 404);
      }

      if (errorMsg.includes('not legal')) {
        return c.json({ error: errorMsg }, 400);
      }

      return c.json({ error: errorMsg }, 500);
    }
  });

  return app;
}
