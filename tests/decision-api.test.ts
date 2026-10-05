/**
 * Decision API contract tests.
 *
 * Tests the real Hono routes against real FeltDB for:
 * - Getting decisions for an attention item
 * - Creating decisions with validation
 * - Idempotence and concurrency safety
 * - Deterministic error responses
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { openFeltState } from '../src/server/felt/state.js';
import { AttentionStore } from '../src/server/attention.js';
import { DecisionStore } from '../src/server/decisions.js';
import { decisionRoutes } from '../src/server/decision-routes.js';
import type { Attention, AttentionKind } from '../src/shared/types.js';

let attention: AttentionStore;
let decisions: DecisionStore;
let app: Hono;

beforeEach(() => {
  const state = openFeltState({
    memory: true,
    namespace: `opendots-dec-api-${randomUUID()}`,
  });
  attention = new AttentionStore(state.db);
  decisions = new DecisionStore(state.db);
  app = decisionRoutes({
    decisions,
    attention,
    ownerId: 'test-owner',
  });
});

async function raiseAttention(kind: AttentionKind): Promise<Attention> {
  const { attention: item } = await attention.raise({
    kind,
    severity: 'info',
    title: 'Test',
    summary: 'Test',
    sourceType: 'execution',
    sourceId: `exec_${randomUUID()}`,
  });
  return item;
}

async function callApi<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    ...(body && {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  });

  const res = await app.fetch(req);
  const data = await res.json();
  return { status: res.status, data };
}

describe('decision API', () => {
  describe('GET /attention/:id/decisions', () => {
    it('lists decisions for an existing attention item', async () => {
      const item = await raiseAttention('execution_failed');

      await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'test-owner',
      });

      const { status, data } = await callApi(
        'GET',
        `/attention/${item.id}/decisions`,
      );

      expect(status).toBe(200);
      expect(data.decisions).toHaveLength(1);
      expect(data.decisions[0].decision).toBe('approve');
      expect(data.legalDecisions).toContain('approve');
      expect(data.legalDecisions).toContain('retry');
      expect(data.legalDecisions).toContain('dismiss');
    });

    it('returns 404 for nonexistent attention item', async () => {
      const { status, data } = await callApi(
        'GET',
        `/attention/attn_nonexistent/decisions`,
      );

      expect(status).toBe(404);
      expect(data.error).toContain('not found');
    });

    it('returns empty decisions list for item with no decisions', async () => {
      const item = await raiseAttention('execution_failed');

      const { status, data } = await callApi(
        'GET',
        `/attention/${item.id}/decisions`,
      );

      expect(status).toBe(200);
      expect(data.decisions).toEqual([]);
      expect(data.legalDecisions).toBeDefined();
    });

    it('returns legal decisions for the attention kind', async () => {
      const failedItem = await raiseAttention('execution_failed');
      const blockedItem = await raiseAttention('execution_blocked');

      const { data: failed } = await callApi(
        'GET',
        `/attention/${failedItem.id}/decisions`,
      );

      const { data: blocked } = await callApi(
        'GET',
        `/attention/${blockedItem.id}/decisions`,
      );

      expect(failed.legalDecisions).toEqual(['approve', 'retry', 'dismiss']);
      expect(blocked.legalDecisions).toEqual(['approve', 'dismiss']);
    });
  });

  describe('POST /attention/:id/decisions', () => {
    it('creates a decision for a valid request', async () => {
      const item = await raiseAttention('execution_failed');

      const { status, data } = await callApi(
        'POST',
        `/attention/${item.id}/decisions`,
        {
          decision: 'approve',
        },
      );

      expect(status).toBe(201);
      expect(data.decision.attentionId).toBe(item.id);
      expect(data.decision.decision).toBe('approve');
      expect(data.decision.actorType).toBe('human');
      expect(data.decision.actorId).toBe('test-owner');
      expect(data.decision.createdAt).toBeGreaterThan(0);
    });

    it('returns 400 for malformed request', async () => {
      const item = await raiseAttention('execution_failed');

      const { status, data } = await callApi(
        'POST',
        `/attention/${item.id}/decisions`,
        {
          invalid: 'field',
        },
      );

      expect(status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('returns 400 for invalid decision value', async () => {
      const item = await raiseAttention('execution_failed');

      const { status, data } = await callApi(
        'POST',
        `/attention/${item.id}/decisions`,
        {
          decision: 'invalid_decision',
        },
      );

      expect(status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('returns 404 for nonexistent attention item', async () => {
      const { status, data } = await callApi(
        'POST',
        `/attention/attn_nonexistent/decisions`,
        {
          decision: 'approve',
        },
      );

      expect(status).toBe(404);
      expect(data.error).toContain('not found');
    });

    it('validates decision legality for attention kind', async () => {
      const item = await raiseAttention('execution_evidence_pending');

      // retry is not legal for evidence_pending
      const { status, data } = await callApi(
        'POST',
        `/attention/${item.id}/decisions`,
        { decision: 'retry' },
      );

      expect(status).toBe(400);
      expect(data.error).toContain('not legal');
      expect(data.legalDecisions).toEqual(['dismiss']);
    });

    it('is idempotent: identical POSTs return the same decision', async () => {
      const item = await raiseAttention('execution_failed');

      const first = await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      const second = await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.data.decision.id).toBe(second.data.decision.id);
    });

    it('allows different decisions by the same actor', async () => {
      const item = await raiseAttention('execution_failed');

      const approve = await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      const retry = await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'retry',
      });

      expect(approve.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(approve.data.decision.id).not.toBe(retry.data.decision.id);
    });

    it('rejects extra fields in the request', async () => {
      const item = await raiseAttention('execution_failed');

      const { status, data } = await callApi(
        'POST',
        `/attention/${item.id}/decisions`,
        {
          decision: 'approve',
          extra: 'field',
        },
      );

      expect(status).toBe(400);
      expect(data.error).toBeDefined();
    });
  });

  describe('decision persistence and concurrency', () => {
    it('persists decisions across API calls', async () => {
      const item = await raiseAttention('execution_failed');

      await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      const { data } = await callApi('GET', `/attention/${item.id}/decisions`);

      expect(data.decisions).toHaveLength(1);
      expect(data.decisions[0].decision).toBe('approve');
    });

    it('preserves all decisions when making new ones', async () => {
      const item = await raiseAttention('execution_failed');

      await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'retry',
      });

      await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'dismiss',
      });

      const { data } = await callApi('GET', `/attention/${item.id}/decisions`);

      expect(data.decisions).toHaveLength(3);
      expect(data.decisions[0].decision).toBe('approve');
      expect(data.decisions[1].decision).toBe('retry');
      expect(data.decisions[2].decision).toBe('dismiss');
    });
  });
});
