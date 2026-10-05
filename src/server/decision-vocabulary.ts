/**
 * Legal decisions per attention kind.
 *
 * Not every decision is valid for every condition. This module defines what a
 * human can decide about each kind of attention item, so the UI doesn't show
 * meaningless actions and the API rejects invalid choices.
 */
import type { AttentionKind, DecisionValue } from '../shared/types.js';

/**
 * The decisions a human can make about a given attention condition.
 *
 * Deliberate and minimal: a condition that doesn't warrant a decision type is
 * not listed here, and the UI uses this to show only legal actions.
 */
const LEGAL_DECISIONS: Record<AttentionKind, DecisionValue[]> = {
  execution_failed: ['approve', 'retry', 'dismiss'],
  execution_blocked: ['approve', 'dismiss'],
  execution_evidence_pending: ['dismiss'],
  provider_unreachable: ['dismiss'],
  human_decision_required: ['approve', 'reject', 'dismiss'],
};

/**
 * Whether a decision is legal for a given attention kind.
 *
 * Returns true if the decision can be made; false if it is not in the legal
 * vocabulary for this condition.
 */
export function isLegalDecision(
  kind: AttentionKind,
  decision: DecisionValue,
): boolean {
  return LEGAL_DECISIONS[kind]?.includes(decision) ?? false;
}

/**
 * The decisions available for a given attention kind.
 *
 * Used by the UI to render only the legal actions for each condition.
 */
export function legalDecisionsFor(kind: AttentionKind): DecisionValue[] {
  return LEGAL_DECISIONS[kind] ?? [];
}
