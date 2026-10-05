/**
 * FeltDB collections and types for decision applications.
 *
 * Immutable application records track whether and how a decision was applied to a
 * real control-plane operation. One decision creates at most one application record,
 * keyed by the decision's deterministic identity.
 */
import type { Collection, StateFirstDB } from '@feltdb/core';

export interface DecisionApplicationRecord {
  id: string;
  decisionId: string;
  operation: 'resolve';
  status: 'pending' | 'applied' | 'failed';
  createdAt: number;
  completedAt: number | null;
  errorCode: string | null;
  error: string | null;
}

export interface DecisionApplicationCollections {
  decision_applications: Collection<DecisionApplicationRecord>;
}

export function decisionApplicationCollections(
  state: StateFirstDB,
): DecisionApplicationCollections {
  return {
    decision_applications: state.collection<DecisionApplicationRecord>(
      'decision_applications',
    ),
  };
}

export function applicationIdFor(decisionId: string): string {
  return `dapp_${decisionId}`;
}
