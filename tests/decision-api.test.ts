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

async function callApi<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const init: RequestInit = {
    method,
  };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new Request(`http://localhost${path}`, init);

  const res = await app.fetch(req);
  const data = (await res.json()) as T;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = data as any;
      expect(response.decisions).toHaveLength(1);
      expect(response.decisions[0].decision).toBe('approve');
      expect(response.legalDecisions).toContain('approve');
      expect(response.legalDecisions).toContain('retry');
      expect(response.legalDecisions).toContain('dismiss');
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = data as any;
      expect(response.decision.attentionId).toBe(item.id);
      expect(response.decision.decision).toBe('approve');
      expect(response.decision.actorType).toBe('human');
      expect(response.decision.actorId).toBe('test-owner');
      expect(response.decision.createdAt).toBeGreaterThan(0);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((data as any).error).toBeDefined();
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((data as any).error).toBeDefined();
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((data as any).error).toContain('not found');
    });

    it('validates decision legality for attention kind', async () => {
      const item = await raiseAttention('execution_evidence_pending');

      // retry is not legal for evidence_pending
      const { status, data } = await callApi(
        'POST',
        `/attention/${item.id}/decisions`,
        { decision: 'retry' },
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = data as any;
      expect(status).toBe(400);
      expect(response.error).toContain('not legal');
      expect(response.legalDecisions).toEqual(['dismiss']);
    });

    it('is idempotent: identical POSTs return the same decision', async () => {
      const item = await raiseAttention('execution_failed');

      const first = await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      const second = await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const firstData = first.data as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const secondData = second.data as any;
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(firstData.decision.id).toBe(secondData.decision.id);
    });

    it('allows different decisions by the same actor', async () => {
      const item = await raiseAttention('execution_failed');

      const approve = await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      const retry = await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'retry',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const approveData = approve.data as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryData = retry.data as any;
      expect(approve.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(approveData.decision.id).not.toBe(retryData.decision.id);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((data as any).error).toBeDefined();
    });
  });

  describe('decision persistence and concurrency', () => {
    it('persists decisions across API calls', async () => {
      const item = await raiseAttention('execution_failed');

      await callApi('POST', `/attention/${item.id}/decisions`, {
        decision: 'approve',
      });

      const { data } = await callApi('GET', `/attention/${item.id}/decisions`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = data as any;
      expect(response.decisions).toHaveLength(1);
      expect(response.decisions[0].decision).toBe('approve');
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = data as any;
      expect(response.decisions).toHaveLength(3);
      expect(response.decisions[0].decision).toBe('approve');
      expect(response.decisions[1].decision).toBe('retry');
      expect(response.decisions[2].decision).toBe('dismiss');
    });
  });
});
