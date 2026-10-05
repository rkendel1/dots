/**
 * FeltDB collections and types for agent decision proposals.
 *
 * Proposals are durable suggestions from agents about what should happen.
 * They are immutable, cannot authorize or execute anything, and require
 * explicit human review and Decision creation to take effect.
 *
 * One record per unique proposal: (attention, agent, decision) combination.
 * Multiple proposals for the same attention are allowed.
 */

import { createHash } from 'node:crypto';
import type { Collection, StateFirstDB } from '@feltdb/core';

export interface DecisionProposalRecord {
  id: string;
  attentionId: string;
  agentId: string;
  agentVersion: string | null;
  decision: 'approve' | 'reject' | 'retry' | 'dismiss';
  rationale: string;
  createdAt: number;
}

export interface DecisionProposalCollections {
  decision_proposals: Collection<DecisionProposalRecord>;
}

export function decisionProposalCollections(
  state: StateFirstDB,
): DecisionProposalCollections {
  return {
    decision_proposals:
      state.collection<DecisionProposalRecord>('decision_proposals'),
  };
}

export function proposalIdFor(
  attentionId: string,
  agentId: string,
  decision: string,
): string {
  const digest = createHash('sha256')
    .update(
      [attentionId, agentId, decision]
        .map((part) => `${part.length}:${part}`)
        .join(''),
    )
    .digest('hex');
  return `dprop_${digest.slice(0, 16)}`;
}
