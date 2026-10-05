/**
 * `DecisionApplicator` — apply human decisions to existing control-plane operations.
 *
 * Only decisions with corresponding existing operations are applied. Others remain
 * declarative intent. Application is idempotent: one human decision creates at most
 * one application attempt, tracked by an immutable application record keyed on the
 * decision's deterministic identity.
 *
 * Currently supported operations:
 * - dismiss → resolve (via AttentionStore)
 *
 * Unsupported but recorded as intent:
 * - retry (no retry operation exists)
 * - approve/reject (context-dependent, no standard operation defined)
 */
import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import type { Decision } from '../shared/types.js';
import type { AttentionStore } from './attention.js';
import type { DecisionStore } from './decisions.js';
import {
  decisionApplicationCollections,
  applicationIdFor,
  type DecisionApplicationRecord,
  type DecisionApplicationCollections,
} from './decision-application-collections.js';
import { isLostRace, transactionId } from './felt/records.js';

export class DecisionApplicator {
  private readonly state: StateFirstDB;
  private readonly felt: DecisionApplicationCollections;
  private readonly decisions: DecisionStore;
  private readonly attention: AttentionStore;

  constructor(
    state: StateFirstDB,
    decisions: DecisionStore,
    attention: AttentionStore,
  ) {
    this.state = state;
    this.felt = decisionApplicationCollections(state);
    this.decisions = decisions;
    this.attention = attention;
  }

  /**
   * Apply a recorded decision if a real operation exists for it.
   *
   * Returns whether the decision was applied. Returns false if the decision type
   * has no corresponding operation or if application already occurred.
   *
   * Only `dismiss` currently has a real operation (resolve). Other decisions remain
   * declarative.
   */
  async apply(
    decision: Decision,
  ): Promise<{ applied: boolean; error?: string }> {
    // Only dismiss has a real operation: resolve.
    if (decision.decision !== 'dismiss') {
      return { applied: false };
    }

    // Check if application already occurred.
    const applicationId = applicationIdFor(decision.id);
    const existing = await this.felt.decision_applications.get(applicationId);
    if (
      existing &&
      (existing.status === 'applied' || existing.status === 'pending')
    ) {
      return { applied: existing.status === 'applied' };
    }

    // Record the application attempt as pending.
    const record: DecisionApplicationRecord = {
      id: applicationId,
      decisionId: decision.id,
      operation: 'resolve',
      status: 'pending',
      createdAt: Date.now(),
      completedAt: null,
      errorCode: null,
      error: null,
    };

    try {
      await this.commit('dapp-create', (tx) =>
        tx
          .collection<DecisionApplicationRecord>('decision_applications')
          .set(applicationId, record, { requireAbsent: true }),
      );
    } catch (error) {
      // Already created by an earlier pass or concurrent one.
      if (isLostRace(error) || isDuplicate(error)) {
        const retry = await this.felt.decision_applications.get(applicationId);
        if (retry?.status === 'applied') return { applied: true };
        if (retry?.status === 'pending') return { applied: false };
      }
      // Unexpected error - report it
      return { applied: false, error: String(error) };
    }

    // Now execute the real operation: resolve the attention item.
    try {
      const item = await this.attention.get(decision.attentionId);
      if (!item) {
        // Attention item no longer exists. Mark application as failed.
        await this.commit('dapp-fail', (tx) =>
          tx
            .collection<DecisionApplicationRecord>('decision_applications')
            .set(applicationId, {
              ...record,
              status: 'failed',
              completedAt: Date.now(),
              errorCode: 'attention_not_found',
              error: 'Attention item was deleted',
            }),
        );
        return { applied: false, error: 'Attention item not found' };
      }

      // Execute the resolve operation via AttentionStore.
      await this.attention.resolve(decision.attentionId);

      // Mark application as applied.
      await this.commit('dapp-succeed', (tx) =>
        tx
          .collection<DecisionApplicationRecord>('decision_applications')
          .set(applicationId, {
            ...record,
            status: 'applied',
            completedAt: Date.now(),
          }),
      );

      return { applied: true };
    } catch (error) {
      // Operation failed. Mark application as failed with error details.
      const err = error as { code?: string; message?: string } | Error;
      const errorCode = 'code' in err ? err.code : 'unknown';
      const errorMsg = err instanceof Error ? err.message : String(error);

      await this.commit('dapp-fail', (tx) =>
        tx
          .collection<DecisionApplicationRecord>('decision_applications')
          .set(applicationId, {
            ...record,
            status: 'failed',
            completedAt: Date.now(),
            errorCode: String(errorCode),
            error: errorMsg,
          }),
      );

      return { applied: false, error: errorMsg };
    }
  }

  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }

  /**
   * Get the application record for a decision, if one exists.
   */
  async getApplication(
    decisionId: string,
  ): Promise<DecisionApplicationRecord | null> {
    return this.felt.decision_applications.get(applicationIdFor(decisionId));
  }

  /**
   * Get application records for multiple decisions.
   *
   * Returns a map of decisionId → application record (or undefined if no application).
   * Used by history composition to build the causal chain.
   */
  async getApplications(
    decisionIds: string[],
  ): Promise<Map<string, DecisionApplicationRecord | undefined>> {
    const result = new Map<string, DecisionApplicationRecord | undefined>();
    for (const decisionId of decisionIds) {
      const app = await this.getApplication(decisionId);
      result.set(decisionId, app ?? undefined);
    }
    return result;
  }
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
