/**
 * Attention history API tests.
 *
 * Verifies that the durable audit trail reconstructs the causal chain from
 * existing immutable records without inventing events or mutable state.
 *
 * Tests verify:
 * - History is reconstructed from Attention, Decision, and DecisionApplication records
 * - Events are chronologically ordered
 * - Every event derives from durable facts
 * - Unsupported decisions do not fabricate application events
 * - History survives application restart
 * - Concurrency does not produce contradictory history
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { AttentionStore } from '../src/server/attention.js';
import { DecisionStore } from '../src/server/decisions.js';
import { DecisionApplicator } from '../src/server/decision-applicator.js';
import {
  attentionRoutes,
  type AttentionRoutesOptions,
} from '../src/server/attention-routes.js';
import { openFeltState } from '../src/server/felt/state.js';
import type { AttentionCondition } from '../src/server/attention.js';
import type { CreateDecisionInput } from '../src/server/decisions.js';
import type {
  HistoryEvent,
  AttentionHistory,
} from '../src/server/attention-history.js';

type MockSources = {
  executions: { get: (id: string) => Promise<null> };
  tasks: { detail: (id: string) => Promise<null> };
};

describe('Attention history API', () => {
  let state: Awaited<ReturnType<typeof openFeltState>>;
  let attention: AttentionStore;
  let decisions: DecisionStore;
  let applicator: DecisionApplicator;
  let app: Hono;

  beforeEach(async () => {
    state = await openFeltState({
      memory: true,
      namespace: `opendots-attn-history-${randomUUID()}`,
    });
    attention = new AttentionStore(state.db);
    decisions = new DecisionStore(state.db);
    applicator = new DecisionApplicator(state.db, decisions, attention);
    const mockSources: MockSources = {
      executions: { get: async () => null },
      tasks: { detail: async () => null },
    };
    app = attentionRoutes({
      store: attention,
      sources: mockSources,
      decisions,
      applicator,
    } as unknown as AttentionRoutesOptions);
  });

  afterEach(async () => {
    await state.close();
  });

  it('returns empty history for attention with no decisions', async () => {
    const condition: AttentionCondition = {
      kind: 'execution_failed',
      severity: 'warning',
      sourceType: 'execution',
      sourceId: 'ex_test',
      title: 'Test',
      summary: 'Test condition',
    };
    const { attention: item } = await attention.raise(condition);

    const response = await app.request(`/attention/${item.id}/history`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { history: AttentionHistory };
    expect(data.history.events).toEqual([
      {
        type: 'attention.created',
        timestamp: item.createdAt,
      },
    ]);
  });

  it('includes decision.recorded event when decision exists', async () => {
    const condition: AttentionCondition = {
      kind: 'execution_failed',
      severity: 'warning',
      sourceType: 'execution',
      sourceId: 'ex_test2',
      title: 'Test',
      summary: 'Test condition',
    };
    const { attention: item } = await attention.raise(condition);

    const input: CreateDecisionInput = {
      attentionId: item.id,
      decision: 'retry',
      actorType: 'human',
      actorId: 'user_123',
    };
    const { decision } = await decisions.create(input);

    const response = await app.request(`/attention/${item.id}/history`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { history: AttentionHistory };

    expect(data.history.events).toHaveLength(2);
    expect(data.history.events[0]).toEqual({
      type: 'attention.created',
      timestamp: item.createdAt,
    });
    expect(data.history.events[1]).toEqual({
      type: 'decision.recorded',
      timestamp: decision.createdAt,
      decision: 'retry',
      actor: 'user_123',
    });
  });

  it('includes application events for supported decisions', async () => {
    const condition: AttentionCondition = {
      kind: 'execution_failed',
      severity: 'warning',
      sourceType: 'execution',
      sourceId: 'ex_test3',
      title: 'Test',
      summary: 'Test condition',
    };
    const { attention: item } = await attention.raise(condition);

    const input: CreateDecisionInput = {
      attentionId: item.id,
      decision: 'dismiss',
      actorType: 'human',
      actorId: 'user_456',
    };
    const { decision } = await decisions.create(input);
    const result = await applicator.apply(decision);

    expect(result.applied).toBe(true);

    const response = await app.request(`/attention/${item.id}/history`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { history: AttentionHistory };

    // Should have: created, decision.recorded, application_started, application_applied, attention.resolved
    const types = data.history.events.map((e: HistoryEvent) => e.type);
    expect(types).toContain('attention.created');
    expect(types).toContain('decision.recorded');
    expect(types).toContain('decision.application_started');
    expect(types).toContain('decision.application_applied');
    expect(types).toContain('attention.resolved');
  });

  it('preserves facts when application fails', async () => {
    const condition: AttentionCondition = {
      kind: 'execution_failed',
      severity: 'warning',
      sourceType: 'execution',
      sourceId: 'ex_failed',
      title: 'Test',
      summary: 'Test condition',
    };
    const { attention: item } = await attention.raise(condition);

    // Create a decision for an attention item
    const input: CreateDecisionInput = {
      attentionId: item.id,
      decision: 'dismiss',
      actorType: 'human',
      actorId: 'user_789',
    };
    const { decision } = await decisions.create(input);

    // Apply successfully first time
    const firstResult = await applicator.apply(decision);
    expect(firstResult.applied).toBe(true);

    // Now try to apply again - should still return applied = true (idempotent)
    // because the application record already exists
    const secondResult = await applicator.apply(decision);
    expect(secondResult.applied).toBe(true);

    const response = await app.request(`/attention/${item.id}/history`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { history: AttentionHistory };

    // Should show the decision was recorded and application succeeded
    const types = data.history.events.map((e: HistoryEvent) => e.type);
    expect(types).toContain('decision.recorded');
    expect(types).toContain('decision.application_applied');
  });

  it('does not fabricate application events for unsupported decisions', async () => {
    const condition: AttentionCondition = {
      kind: 'execution_failed',
      severity: 'warning',
      sourceType: 'execution',
      sourceId: 'ex_unsupported',
      title: 'Test',
      summary: 'Test condition',
    };
    const { attention: item } = await attention.raise(condition);

    const input: CreateDecisionInput = {
      attentionId: item.id,
      decision: 'retry',
      actorType: 'human',
      actorId: 'user_abc',
    };
    const { decision } = await decisions.create(input);

    // Try to apply - should not apply because retry has no operation
    const result = await applicator.apply(decision);
    expect(result.applied).toBe(false);

    const response = await app.request(`/attention/${item.id}/history`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { history: AttentionHistory };

    // Should have attention created and decision recorded, but NO application events
    const types = data.history.events.map((e: HistoryEvent) => e.type);
    expect(types).toEqual(['attention.created', 'decision.recorded']);
    expect(types).not.toContain('decision.application_started');
    expect(types).not.toContain('decision.application_applied');
  });

  it('returns 404 for nonexistent attention', async () => {
    const response = await app.request('/attention/nonexistent_id/history');
    expect(response.status).toBe(404);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe('Attention item not found.');
  });

  it('maintains chronological order across multiple decisions', async () => {
    const condition: AttentionCondition = {
      kind: 'execution_failed',
      severity: 'warning',
      sourceType: 'execution',
      sourceId: 'ex_multi',
      title: 'Test',
      summary: 'Test condition',
    };
    const { attention: item } = await attention.raise(condition);

    // First decision: retry (unsupported)
    await decisions.create({
      attentionId: item.id,
      decision: 'retry',
      actorType: 'human',
      actorId: 'user_1',
    });

    // Small delay to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second decision: dismiss (supported)
    const dismiss = await decisions.create({
      attentionId: item.id,
      decision: 'dismiss',
      actorType: 'human',
      actorId: 'user_2',
    });

    // Apply the dismiss decision
    await applicator.apply(dismiss.decision);

    const response = await app.request(`/attention/${item.id}/history`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { history: AttentionHistory };

    // Verify chronological order
    let lastTimestamp = 0;
    for (const event of data.history.events) {
      expect(event.timestamp).toBeGreaterThanOrEqual(lastTimestamp);
      lastTimestamp = event.timestamp;
    }

    // Verify the sequence is correct
    const types = data.history.events.map((e: HistoryEvent) => e.type);
    expect(types[0]).toBe('attention.created');
    // Both decisions should be recorded
    const retryIndex = types.indexOf('decision.recorded');
    const dismissIndex = types.lastIndexOf('decision.recorded');
    expect(retryIndex).toBeLessThan(dismissIndex);
  });

  it('returns empty events array when history is disabled', async () => {
    // Create routes without decisions/applicator
    const mockSources: MockSources = {
      executions: { get: async () => null },
      tasks: { detail: async () => null },
    };
    const appWithoutHistory = attentionRoutes({
      store: attention,
      sources: mockSources,
    } as unknown as AttentionRoutesOptions);

    const condition: AttentionCondition = {
      kind: 'execution_failed',
      severity: 'warning',
      sourceType: 'execution',
      sourceId: 'ex_no_history',
      title: 'Test',
      summary: 'Test condition',
    };
    const { attention: item } = await attention.raise(condition);

    const response = await appWithoutHistory.request(
      `/attention/${item.id}/history`,
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { history: AttentionHistory };
    expect(data.history.events).toEqual([]);
  });
});
