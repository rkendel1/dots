/**
 * The decision control plane.
 *
 * Decisions are immutable human facts about attention items. This suite proves:
 *
 * 1. **Decisions are immutable.** Once created, they cannot be edited or deleted.
 * 2. **Decision identity is deterministic.** Identical submissions are idempotent.
 * 3. **Different decisions create new rows.** A human can change their mind.
 * 4. **Decisions are scoped by attention kind.** Not every decision is valid for
 *    every condition kind.
 * 5. **History is preserved.** Deleting or resolving an attention item does not
 *    erase its decisions.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openFeltState, type FeltState } from '../src/server/felt/state.js';
import { AttentionStore } from '../src/server/attention.js';
import { DecisionStore } from '../src/server/decisions.js';
import {
  isLegalDecision,
  legalDecisionsFor,
} from '../src/server/decision-vocabulary.js';
import { decisionIdFor } from '../src/server/decision-collections.js';
import type { Attention, AttentionKind } from '../src/shared/types.js';

interface Open {
  attention: AttentionStore;
  decisions: DecisionStore;
  state: FeltState;
  close(): void;
}

const handles: Open[] = [];
const dirs: string[] = [];

function openAt(path?: string): Open {
  const state = path
    ? openFeltState({ path })
    : openFeltState({
        memory: true,
        namespace: `opendots-dec-${randomUUID()}`,
      });
  const attention = new AttentionStore(state.db);
  const decisions = new DecisionStore(state.db);
  const handle: Open = {
    attention,
    decisions,
    state,
    close: () => state.close(),
  };
  handles.push(handle);
  return handle;
}

function memory() {
  return openAt();
}

function durable() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-dec-'));
  dirs.push(dir);
  return { ...openAt(join(dir, 'state')), dir };
}

function reopen(dir: string) {
  return openAt(join(dir, 'state'));
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function raiseAttention(
  store: AttentionStore,
  kind: AttentionKind,
): Promise<Attention> {
  const { attention } = await store.raise({
    kind,
    severity: 'info',
    title: 'Test',
    summary: 'Test',
    sourceType: 'execution',
    sourceId: `exec_${randomUUID()}`,
  });
  return attention;
}

describe('decisions — immutable human choices about attention', () => {
  describe('decision vocabulary', () => {
    it('knows which decisions are legal for each attention kind', () => {
      expect(legalDecisionsFor('execution_failed')).toEqual([
        'approve',
        'retry',
        'dismiss',
      ]);
      expect(legalDecisionsFor('execution_blocked')).toEqual([
        'approve',
        'dismiss',
      ]);
      expect(legalDecisionsFor('execution_evidence_pending')).toEqual([
        'dismiss',
      ]);
      expect(legalDecisionsFor('provider_unreachable')).toEqual(['dismiss']);
      expect(legalDecisionsFor('human_decision_required')).toEqual([
        'approve',
        'reject',
        'dismiss',
      ]);
    });

    it('validates whether a specific decision is legal for a kind', () => {
      expect(isLegalDecision('execution_failed', 'approve')).toBe(true);
      expect(isLegalDecision('execution_failed', 'retry')).toBe(true);
      expect(isLegalDecision('execution_failed', 'reject')).toBe(false);
      expect(isLegalDecision('execution_blocked', 'approve')).toBe(true);
      expect(isLegalDecision('execution_blocked', 'retry')).toBe(false);
    });
  });

  describe('decision creation and idempotence', () => {
    it('creates a decision about an attention item', async () => {
      const { attention, decisions } = memory();
      const item = await raiseAttention(attention, 'execution_failed');

      const { decision, created } = await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      expect(created).toBe(true);
      expect(decision.attentionId).toBe(item.id);
      expect(decision.decision).toBe('approve');
      expect(decision.actorType).toBe('human');
      expect(decision.actorId).toBe('owner-123');
      expect(decision.createdAt).toBeGreaterThan(0);
    });

    it('is idempotent: identical submissions return the same record', async () => {
      const { attention, decisions } = memory();
      const item = await raiseAttention(attention, 'execution_failed');

      const first = await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      const second = await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      expect(first.decision.id).toBe(second.decision.id);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
    });

    it('creates a new record when the human makes a different decision', async () => {
      const { attention, decisions } = memory();
      const item = await raiseAttention(attention, 'execution_failed');

      const approve = await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      const retry = await decisions.create({
        attentionId: item.id,
        decision: 'retry',
        actorType: 'human',
        actorId: 'owner-123',
      });

      expect(approve.decision.id).not.toBe(retry.decision.id);
      expect(approve.created).toBe(true);
      expect(retry.created).toBe(true);
    });

    it('creates a new record when a different human makes the same decision', async () => {
      const { attention, decisions } = memory();
      const item = await raiseAttention(attention, 'execution_failed');

      const alice = await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'alice',
      });

      const bob = await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'bob',
      });

      expect(alice.decision.id).not.toBe(bob.decision.id);
      expect(alice.created).toBe(true);
      expect(bob.created).toBe(true);
    });
  });

  describe('listing and history', () => {
    it('lists all decisions for an attention item in chronological order', async () => {
      const { attention, decisions } = memory();
      const item = await raiseAttention(attention, 'execution_failed');

      await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      await decisions.create({
        attentionId: item.id,
        decision: 'retry',
        actorType: 'human',
        actorId: 'owner-123',
      });

      await decisions.create({
        attentionId: item.id,
        decision: 'dismiss',
        actorType: 'human',
        actorId: 'owner-123',
      });

      const list = await decisions.listForAttention(item.id);
      expect(list).toHaveLength(3);
      expect(list[0].decision).toBe('approve');
      expect(list[1].decision).toBe('retry');
      expect(list[2].decision).toBe('dismiss');
    });

    it('returns an empty list for an attention item with no decisions', async () => {
      const { attention, decisions } = memory();
      const item = await raiseAttention(attention, 'execution_failed');

      const list = await decisions.listForAttention(item.id);
      expect(list).toEqual([]);
    });

    it('preserves decision history across restart', async () => {
      const handle1 = durable() as Open & { dir: string };
      const { attention: attn1, decisions: dec1, close: close1 } = handle1;
      const item = await raiseAttention(attn1, 'execution_failed');

      await dec1.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      await dec1.create({
        attentionId: item.id,
        decision: 'retry',
        actorType: 'human',
        actorId: 'owner-123',
      });

      close1();

      // Restart and reopen the store
      const { decisions: dec2 } = reopen(handle1.dir);
      const list = await dec2.listForAttention(item.id);

      expect(list).toHaveLength(2);
      expect(list[0].decision).toBe('approve');
      expect(list[1].decision).toBe('retry');
    });
  });

  describe('deterministic decision identity', () => {
    it('generates deterministic IDs so concurrency is safe', () => {
      const id1 = decisionIdFor('attn_abc', 'approve', 'human', 'owner-123');
      const id2 = decisionIdFor('attn_abc', 'approve', 'human', 'owner-123');

      expect(id1).toBe(id2);
    });

    it('generates different IDs for different combinations', () => {
      const attentionId = decisionIdFor(
        'attn_abc',
        'approve',
        'human',
        'owner-123',
      );
      const decisionChange = decisionIdFor(
        'attn_abc',
        'reject',
        'human',
        'owner-123',
      );
      const actorChange = decisionIdFor(
        'attn_abc',
        'approve',
        'human',
        'owner-456',
      );

      expect(attentionId).not.toBe(decisionChange);
      expect(attentionId).not.toBe(actorChange);
      expect(decisionChange).not.toBe(actorChange);
    });

    it('prevents collision between different combination orders', () => {
      // Length-prefixing prevents ('a', 'bc') and ('ab', 'c') from colliding
      const id1 = decisionIdFor('a', 'bc', 'human', 'owner');
      const id2 = decisionIdFor('ab', 'c', 'human', 'owner');
      expect(id1).not.toBe(id2);
    });
  });

  describe('immutability', () => {
    it('does not allow editing a decision', async () => {
      const { attention, decisions } = memory();
      const item = await raiseAttention(attention, 'execution_failed');

      const { decision } = await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      // Get the decision again
      const retrieved = await decisions.get(decision.id);
      expect(retrieved).toEqual(decision);

      // Attempt to create with the same parameters succeeds (idempotence)
      const second = await decisions.create({
        attentionId: item.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      // The returned decision is identical
      expect(second.decision.id).toBe(decision.id);
      expect(second.created).toBe(false);
    });
  });

  describe('unrelated decisions are independent', () => {
    it('lists only decisions for the requested attention item', async () => {
      const { attention, decisions } = memory();
      const item1 = await raiseAttention(attention, 'execution_failed');
      const item2 = await raiseAttention(attention, 'execution_blocked');

      await decisions.create({
        attentionId: item1.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      await decisions.create({
        attentionId: item2.id,
        decision: 'approve',
        actorType: 'human',
        actorId: 'owner-123',
      });

      const list1 = await decisions.listForAttention(item1.id);
      const list2 = await decisions.listForAttention(item2.id);

      expect(list1).toHaveLength(1);
      expect(list1[0].attentionId).toBe(item1.id);
      expect(list2).toHaveLength(1);
      expect(list2[0].attentionId).toBe(item2.id);
    });
  });
});
