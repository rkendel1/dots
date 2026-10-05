/**
 * DecisionProposalStore — durable agent suggestions about attention items.
 *
 * Proposals are immutable records of what an agent suggests should happen.
 * They cannot authorize, execute, or modify anything. A human must review
 * and explicitly create a Decision to act on a proposal.
 *
 * Proposals are idempotent: (attention, agent, decision) is the identity key.
 * Multiple different proposals per attention are allowed.
 */

import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import {
  decisionProposalCollections,
  proposalIdFor,
  type DecisionProposalRecord,
  type DecisionProposalCollections,
} from './decision-proposal-collections.js';
import { isLostRace, transactionId } from './felt/records.js';
import { legalDecisionsFor } from './decision-vocabulary.js';
import type { AttentionStore } from './attention.js';

export interface CreateProposalInput {
  attentionId: string;
  agentId: string;
  agentVersion?: string;
  decision: 'approve' | 'reject' | 'retry' | 'dismiss';
  rationale: string;
}

export interface ProposalRecord {
  id: string;
  attentionId: string;
  agentId: string;
  agentVersion?: string;
  decision: string;
  rationale: string;
  createdAt: number;
}

export class DecisionProposalStore {
  private readonly state: StateFirstDB;
  private readonly felt: DecisionProposalCollections;
  private readonly attention: AttentionStore;

  constructor(state: StateFirstDB, attention: AttentionStore) {
    this.state = state;
    this.felt = decisionProposalCollections(state);
    this.attention = attention;
  }

  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }

  /**
   * Create a durable agent proposal.
   *
   * Validates that the proposed decision is legal for the attention kind.
   * Returns the proposal record and whether this call created it (idempotent).
   */
  async create(
    input: CreateProposalInput,
  ): Promise<{ proposal: ProposalRecord; created: boolean }> {
    // Verify attention exists
    const item = await this.attention.get(input.attentionId);
    if (!item) {
      throw new Error(`Attention item not found: ${input.attentionId}`);
    }

    // Verify the decision is legal for this attention kind
    const legal = legalDecisionsFor(item.kind);
    if (!legal.includes(input.decision)) {
      throw new Error(
        `Decision "${input.decision}" is not legal for attention kind "${item.kind}". Legal decisions: ${legal.join(', ')}`,
      );
    }

    const id = proposalIdFor(input.attentionId, input.agentId, input.decision);
    const now = Date.now();
    const record: DecisionProposalRecord = {
      id,
      attentionId: input.attentionId,
      agentId: input.agentId,
      agentVersion: input.agentVersion ?? null,
      decision: input.decision,
      rationale: input.rationale,
      createdAt: now,
    };

    try {
      await this.commit('dprop-create', (tx) =>
        tx
          .collection<DecisionProposalRecord>('decision_proposals')
          .set(id, record, { requireAbsent: true }),
      );
      return { proposal: toProposal(record), created: true };
    } catch (error) {
      // Already created by an earlier pass or concurrent one.
      if (isLostRace(error) || isDuplicate(error)) {
        const existing = await this.felt.decision_proposals.get(id);
        if (existing) return { proposal: toProposal(existing), created: false };
      }
      throw error;
    }
  }

  /**
   * Get all proposals for an attention item.
   */
  async listForAttention(attentionId: string): Promise<ProposalRecord[]> {
    const rows = (await this.felt.decision_proposals.all()).filter(
      (row) => row.attentionId === attentionId,
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt).map(toProposal);
  }

  /**
   * Get a specific proposal.
   */
  async get(proposalId: string): Promise<ProposalRecord | undefined> {
    const record = await this.felt.decision_proposals.get(proposalId);
    return record ? toProposal(record) : undefined;
  }

  /**
   * Get proposals for multiple attention IDs (for history composition).
   */
  async getProposalsForAttention(
    attentionId: string,
  ): Promise<DecisionProposalRecord[]> {
    const rows = (await this.felt.decision_proposals.all()).filter(
      (row) => row.attentionId === attentionId,
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }
}

function toProposal(record: DecisionProposalRecord): ProposalRecord {
  return {
    id: record.id,
    attentionId: record.attentionId,
    agentId: record.agentId,
    agentVersion: record.agentVersion ?? undefined,
    decision: record.decision,
    rationale: record.rationale,
    createdAt: record.createdAt,
  };
}

/**
 * Whether an error means "this row is already there".
 */
function isDuplicate(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: string;
    feltdbCode?: string;
    message?: string;
  };
  const code = candidate.code ?? candidate.feltdbCode ?? '';
  return (
    code === 'DUPLICATE' ||
    code === 'ALREADY_EXISTS' ||
    code === 'UNIQUE_CONSTRAINT' ||
    /duplicate|already exists/i.test(candidate.message ?? '')
  );
}
