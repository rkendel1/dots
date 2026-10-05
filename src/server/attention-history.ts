/**
 * Control-plane audit trail for Attention items.
 *
 * History reconstructs the causal chain from immutable durable records:
 * - Attention creation and resolution
 * - Agent proposals
 * - Decision recording
 * - Decision application status and outcomes
 *
 * History is a computed read model: pure function of existing facts.
 * No new persistence layer is required; all events derive from existing
 * collections (attention, decision_proposals, decisions, decision_applications).
 */

import type { Decision } from '../shared/types.js';
import type { Attention } from '../shared/types.js';
import type { DecisionApplicationRecord } from './decision-application-collections.js';
import type { DecisionProposalRecord } from './decision-proposal-collections.js';

export type HistoryEventType =
  | 'attention.created'
  | 'decision.proposed'
  | 'decision.recorded'
  | 'decision.application_started'
  | 'decision.application_applied'
  | 'decision.application_failed'
  | 'attention.resolved';

export interface HistoryEvent {
  type: HistoryEventType;
  timestamp: number;
  decision?: string;
  actor?: string;
  agent?: string;
  agentVersion?: string;
  rationale?: string;
  proposalId?: string;
  status?: string;
  error?: string;
  errorCode?: string;
}

export interface AttentionHistory {
  events: HistoryEvent[];
}

/**
 * Build the complete history for an Attention item from durable records.
 *
 * Returns chronologically ordered events derived from Attention, DecisionProposal,
 * Decision, and DecisionApplication records. Every event must correspond to actual
 * durable facts; no events are invented.
 *
 * History remains valid across restarts because all facts are durable.
 */
export function buildAttentionHistory(
  attention: Attention,
  decisions: Decision[],
  applications: Map<string, DecisionApplicationRecord | undefined>,
  proposals?: DecisionProposalRecord[],
): AttentionHistory {
  const events: HistoryEvent[] = [];

  // 1. Attention created
  events.push({
    type: 'attention.created',
    timestamp: attention.createdAt,
  });

  // 2. Agent proposals, in order
  if (proposals) {
    for (const proposal of proposals) {
      events.push({
        type: 'decision.proposed',
        timestamp: proposal.createdAt,
        proposalId: proposal.id,
        agent: proposal.agentId,
        agentVersion: proposal.agentVersion || undefined,
        decision: proposal.decision,
        rationale: proposal.rationale,
      });
    }
  }

  // 3. Decisions and their applications, in order
  for (const decision of decisions) {
    // Record the decision itself
    events.push({
      type: 'decision.recorded',
      timestamp: decision.createdAt,
      decision: decision.decision,
      actor: decision.actorId,
    });

    // Look up the application for this decision
    const application = applications.get(decision.id);

    if (application) {
      // Application exists: record its lifecycle
      events.push({
        type: 'decision.application_started',
        timestamp: application.createdAt,
      });

      if (application.status === 'applied') {
        events.push({
          type: 'decision.application_applied',
          timestamp: application.completedAt || application.createdAt,
        });
      } else if (application.status === 'failed') {
        events.push({
          type: 'decision.application_failed',
          timestamp: application.completedAt || application.createdAt,
          error: application.error || undefined,
          errorCode: application.errorCode || undefined,
        });
      }
      // 'pending' applications do not generate a terminal event
    }
    // If no application exists, the decision remains declarative (no event)
  }

  // 4. Attention resolved (if ever)
  if (attention.resolvedAt) {
    events.push({
      type: 'attention.resolved',
      timestamp: attention.resolvedAt,
    });
  }

  // Sort by timestamp to ensure chronological order
  events.sort((a, b) => a.timestamp - b.timestamp);

  return { events };
}
