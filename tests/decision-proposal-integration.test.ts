/**
 * Agent decision proposals end-to-end integration tests.
 *
 * These prove the complete control-plane flow:
 *   Proposal → Decision → Application → Attention resolution
 *
 * Proposals are durable, immutable suggestions from agents.
 * Decisions are authoritative human choices that reference proposals.
 * Applications are the boundary between decisions and actual operations.
 * History captures the causal chain.
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
import { DecisionStore } from '../src/server/decisions.js';
import { DecisionApplicator } from '../src/server/decision-applicator.js';
import { DecisionProposalStore } from '../src/server/decision-proposals.js';
import { attentionRoutes } from '../src/server/attention-routes.js';
import { decisionRoutes } from '../src/server/decision-routes.js';
import { Store } from '../src/server/store.js';
import { ScriptedExecutionProvider } from './helpers/scripted-execution-provider.js';

const open: FeltState[] = [];
afterEach(() => open.splice(0).forEach((state) => state.close()));

const post = (body: unknown = {}) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

const get = () => ({ method: 'GET' });

/**
 * Complete fixture with all layers: attention, decisions, proposals, applicator.
 */
function fixture(options: { script?: string[] } = {}) {
  const state = openFeltState({
    memory: true,
    namespace: `opendots-proposal-${randomUUID()}`,
  });
  open.push(state);
  const store = new Store(state.db);
  const executions = new ExecutionStore(state.db);
  const attention = new AttentionStore(state.db);
  const decisions = new DecisionStore(state.db);
  const proposals = new DecisionProposalStore(state.db, attention);
  const applicator = new DecisionApplicator(state.db, decisions, attention);
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
  const app = new Hono()
    .route(
      '/api',
      attentionRoutes({
        store: attention,
        sources: { executions, tasks: store },
        decisions,
        applicator,
        proposals,
      }),
    )
    .route(
      '/api',
      decisionRoutes({
        decisions,
        attention,
        applicator,
        ownerId: 'test-user',
      }),
    );
  return {
    app,
    store,
    executions,
    attention,
    decisions,
    proposals,
    applicator,
    evaluator,
    provider,
    service,
    reconciler,
  };
}

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

describe('decision proposals complete flow', () => {
  it('creates and lists proposals', async () => {
    const f = fixture();
    const exec = await failedExecution(f);
    const items = await f.app.request('/api/attention', get());
    const body = (await items.json()) as { attention: Array<{ id: string }> };
    const attentionId = body.attention[0]!.id;

    // Create proposal
    const createRes = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'test-agent',
        agentVersion: '1.0.0',
        decision: 'retry',
        rationale: 'Provider is responsive again',
      }),
    );
    if (createRes.status !== 201) {
      const err = await createRes.json();
      console.error('Proposal creation error status:', createRes.status);
      console.error('Proposal creation error body:', err);
      console.error('AttentionId:', attentionId);
    }
    expect(createRes.status).toBe(201);
    const proposal = (await createRes.json()) as { proposal: { id: string } };

    // List proposals
    const listRes = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      get(),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { proposals: Array<{ id: string }> };
    expect(list.proposals).toHaveLength(1);
    expect(list.proposals[0]!.id).toBe(proposal.proposal.id);
  });

  it('rejects illegal proposals', async () => {
    const f = fixture();
    await failedExecution(f);
    const items = await f.app.request('/api/attention', get());
    const body = (await items.json()) as { attention: Array<{ id: string }> };
    const attentionId = body.attention[0]!.id;

    // Try to propose an illegal decision ('reject' is not legal for 'execution_failed')
    const res = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'test-agent',
        decision: 'reject',
        rationale: 'Reject this',
      }),
    );
    expect(res.status).toBe(400);
    const error = (await res.json()) as { error: string };
    expect(error.error).toContain('not legal');
  });

  it('accepts proposal and creates decision', async () => {
    const f = fixture();
    await failedExecution(f);
    const items = await f.app.request('/api/attention', get());
    const body = (await items.json()) as { attention: Array<{ id: string }> };
    const attentionId = body.attention[0]!.id;

    // Create proposal
    await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'test-agent',
        decision: 'retry',
        rationale: 'Retry this',
      }),
    );

    // Get legal decisions
    const decisionsRes = await f.app.request(
      `/api/attention/${attentionId}/decisions`,
      get(),
    );
    const { legalDecisions } = (await decisionsRes.json()) as {
      legalDecisions: string[];
    };
    expect(legalDecisions).toContain('retry');

    // Accept by creating decision with the proposed action
    const decideRes = await f.app.request(
      `/api/attention/${attentionId}/decisions`,
      post({ decision: 'retry' }),
    );
    expect(decideRes.status).toBe(201);
    const decision = (await decideRes.json()) as {
      decision: { id: string; decision: string };
    };
    expect(decision.decision.decision).toBe('retry');

    // Proposal remains immutable - verify it still exists
    const proposalsRes = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      get(),
    );
    const proposals = (await proposalsRes.json()) as {
      proposals: Array<{ id: string }>;
    };
    expect(proposals.proposals).toHaveLength(1);
  });

  it('handles dismiss → resolution flow', async () => {
    const f = fixture();
    await failedExecution(f);
    const items = await f.app.request('/api/attention', get());
    const body = (await items.json()) as {
      attention: Array<{ id: string }>;
    };
    const attentionId = body.attention[0]!.id;

    // Create dismiss proposal
    await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'test-agent',
        decision: 'dismiss',
        rationale: 'This is not actionable',
      }),
    );

    // Accept proposal
    const decideRes = await f.app.request(
      `/api/attention/${attentionId}/decisions`,
      post({ decision: 'dismiss' }),
    );
    expect(decideRes.status).toBe(201);

    // Verify application was created
    const itemRes = await f.app.request(`/api/attention/${attentionId}`, get());
    const item = (await itemRes.json()) as {
      attention: { resolvedAt: number };
    };
    expect(item.attention.resolvedAt).not.toBeNull();
  });

  it('includes proposals in history', async () => {
    const f = fixture();
    await failedExecution(f);
    const items = await f.app.request('/api/attention', get());
    const body = (await items.json()) as { attention: Array<{ id: string }> };
    const attentionId = body.attention[0]!.id;

    // Create proposal
    const propRes = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'test-agent',
        agentVersion: '1.0.0',
        decision: 'retry',
        rationale: 'Try again',
      }),
    );
    const proposal = (await propRes.json()) as { proposal: { id: string } };

    // Create decision from proposal
    await f.app.request(
      `/api/attention/${attentionId}/decisions`,
      post({ decision: 'retry' }),
    );

    // Get history
    const histRes = await f.app.request(
      `/api/attention/${attentionId}/history`,
      get(),
    );
    const hist = (await histRes.json()) as {
      history: {
        events: Array<{ type: string; agent?: string; decision?: string }>;
      };
    };

    // Find proposed event
    const proposedEvent = hist.history.events.find(
      (e) => e.type === 'decision.proposed',
    );
    expect(proposedEvent).toBeDefined();
    expect(proposedEvent?.agent).toBe('test-agent');
    expect(proposedEvent?.decision).toBe('retry');
  });

  it('handles idempotent proposal creation', async () => {
    const f = fixture();
    await failedExecution(f);
    const items = await f.app.request('/api/attention', get());
    const body = (await items.json()) as { attention: Array<{ id: string }> };
    const attentionId = body.attention[0]!.id;

    // Create proposal
    const res1 = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'agent-1',
        decision: 'retry',
        rationale: 'First time',
      }),
    );
    expect(res1.status).toBe(201);
    const proposal1 = (await res1.json()) as { proposal: { id: string } };

    // Create same proposal again (same agent, same decision)
    const res2 = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'agent-1',
        decision: 'retry',
        rationale: 'Second time (different rationale)',
      }),
    );
    expect(res2.status).toBe(200); // Idempotent, returns 200
    const proposal2 = (await res2.json()) as { proposal: { id: string } };
    expect(proposal2.proposal.id).toBe(proposal1.proposal.id);

    // Different agent, same decision → creates new proposal
    const res3 = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'agent-2',
        decision: 'retry',
        rationale: 'From different agent',
      }),
    );
    expect(res3.status).toBe(201);
    const proposal3 = (await res3.json()) as { proposal: { id: string } };
    expect(proposal3.proposal.id).not.toBe(proposal1.proposal.id);
  });

  it('preserves proposal immutability', async () => {
    const f = fixture();
    await failedExecution(f);
    const items = await f.app.request('/api/attention', get());
    const body = (await items.json()) as { attention: Array<{ id: string }> };
    const attentionId = body.attention[0]!.id;

    // Create proposal
    const propRes = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'agent',
        decision: 'retry',
        rationale: 'Original rationale',
      }),
    );
    const prop1 = (await propRes.json()) as {
      proposal: { id: string; rationale: string };
    };

    // Create decision from proposal
    await f.app.request(
      `/api/attention/${attentionId}/decisions`,
      post({ decision: 'retry' }),
    );

    // Re-fetch proposal - should be unchanged
    const refetchRes = await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      get(),
    );
    const props = (await refetchRes.json()) as {
      proposals: Array<{ id: string; rationale: string }>;
    };
    expect(props.proposals[0]!.id).toBe(prop1.proposal.id);
    expect(props.proposals[0]!.rationale).toBe('Original rationale');
  });

  it('does not fabricate operations for unsupported decisions', async () => {
    const f = fixture();
    await failedExecution(f);
    const items = await f.app.request('/api/attention', get());
    const body = (await items.json()) as { attention: Array<{ id: string }> };
    const attentionId = body.attention[0]!.id;

    // Create retry proposal (no actual operation exists for retry)
    await f.app.request(
      `/api/attention/${attentionId}/proposals`,
      post({
        agentId: 'agent',
        decision: 'retry',
        rationale: 'Retry this',
      }),
    );

    // Accept proposal
    const decideRes = await f.app.request(
      `/api/attention/${attentionId}/decisions`,
      post({ decision: 'retry' }),
    );
    expect(decideRes.status).toBe(201);
    const decision = (await decideRes.json()) as { decision: { id: string } };

    // Verify no execution was created or restarted
    const execs = await f.executions.list();
    const original = await failedExecution(f);
    expect(execs.length).toBeLessThanOrEqual(1);

    // Verify attention was not resolved (dismiss is the only op that resolves)
    const itemRes = await f.app.request(`/api/attention/${attentionId}`, get());
    const item = (await itemRes.json()) as {
      attention: { resolvedAt: number | null };
    };
    expect(item.attention.resolvedAt).toBeNull();
  });
});
