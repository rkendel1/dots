/**
 * `AttentionEvaluator` — durable state, interpreted as conditions needing a human.
 *
 * This is the control plane's judgement, and it is deliberately the *only* place
 * that makes it. It reads the same durable records the rest of OpenDots reads,
 * derives a set of conditions, and hands them to {@link AttentionStore}. It never
 * decides an execution's fate, never talks to Compute, and never mutates an
 * execution — reconciliation owns those.
 *
 * ## Idempotence is structural, not best-effort
 *
 * Conditions are keyed by `attentionIdFor(kind, sourceType, sourceId)`, so
 * evaluating the same condition any number of times addresses one record. That is
 * why a provider outage spanning four reconciliation cycles produces one item
 * rather than four: there is nothing to deduplicate after the fact, because there
 * was only ever one candidate row.
 *
 * ## The rules
 *
 * | Durable state                                             | Condition                    |
 * | --------------------------------------------------------- | ---------------------------- |
 * | `execution.status === 'failed'`                           | `execution_failed`           |
 * | non-terminal, no provider identity, recorded failure      | `execution_blocked`          |
 * | terminal and `resultRetrieved === false`                  | `execution_evidence_pending` |
 * | any execution unreachable from its provider               | `provider_unreachable`       |
 * | a task that is paused or failed                           | `human_decision_required`    |
 *
 * Two rules deserve their reasoning stated:
 *
 *   - **`execution_failed` never auto-resolves.** Reaching a terminal state is
 *     not being dealt with. The human may still need to read the output, decide
 *     whether to retry, or notice the failure matters. So a failed execution
 *     keeps its item `open` indefinitely, and only
 *     `POST /api/attention/:id/resolve` closes it.
 *   - **`execution_blocked` is narrower than it sounds.** It means an execution
 *     with no provider identity that has *also* failed to get one — not merely one
 *     that has not started yet. A freshly queued execution is normal, and raising
 *     attention for it on every cycle would train a human to ignore the list.
 *     Requiring a recorded failure alongside it is what separates "waiting to
 *     start" from "cannot start".
 */
import type { Execution, Task } from '../shared/types.js';
import { AttentionStore, type AttentionCondition } from './attention.js';
import { attentionIdFor } from './attention-collections.js';

export interface EvaluateInput {
  /** Every execution OpenDots knows about, in any lifecycle state. */
  executions: Execution[];
  /** The legacy scheduled tasks, which have their own decision states. */
  tasks?: Task[];
}

export interface EvaluateSummary {
  /** Conditions that were not previously recorded. */
  raised: number;
  /** Conditions already recorded, so not duplicated. */
  unchanged: number;
  /** Conditions no longer true, whose items were marked cleared. */
  cleared: number;
}

/**
 * Derive every condition the given durable state implies.
 *
 * Pure and exported so the mapping can be tested directly, without a database —
 * these rules are the part of this a reviewer most wants to read.
 */
export function conditionsFor(input: EvaluateInput): AttentionCondition[] {
  const conditions: AttentionCondition[] = [];
  const unreachable = new Set<string>();

  for (const execution of input.executions) {
    if (execution.status === 'failed') {
      conditions.push({
        kind: 'execution_failed',
        severity: 'critical',
        title: 'An execution failed',
        summary:
          execution.error ??
          `The provider could not complete this execution${
            execution.errorCode ? ` (${execution.errorCode})` : ''
          }.`,
        sourceType: 'execution',
        sourceId: execution.id,
      });
    }

    // Blocked means "cannot start", not "has not started yet". An execution with
    // no provider identity and a recorded reconciliation failure has been told it
    // cannot get one; a freshly queued one has simply not asked yet.
    if (
      execution.status !== 'failed' &&
      execution.status !== 'completed' &&
      execution.status !== 'cancelled' &&
      execution.providerExecutionId === null &&
      execution.reconciliationError !== null
    ) {
      conditions.push({
        kind: 'execution_blocked',
        severity: 'warning',
        title: 'An execution cannot start',
        summary:
          execution.reconciliationError ??
          'OpenDots could not hand this execution to the provider.',
        sourceType: 'execution',
        sourceId: execution.id,
      });
    }

    // Scoped to `completed` only, deliberately. A *failed* execution already has
    // an `execution_failed` item demanding the same human attention, and adding a
    // second one for its missing result would double every failure in the list
    // without telling anyone anything new. The reconciler still retrieves the
    // result of a failed execution — it just does not raise a second item for it.
    if (
      execution.status === 'completed' &&
      execution.resultRetrieved === false
    ) {
      conditions.push({
        kind: 'execution_evidence_pending',
        severity: 'info',
        title: 'A finished execution has no result yet',
        summary:
          'The execution finished, but its result has not been retrieved from the provider.',
        sourceType: 'execution',
        sourceId: execution.id,
      });
    }

    if (
      execution.reconciliationErrorCode === 'transport_failure' &&
      execution.provider
    )
      unreachable.add(execution.provider);
  }

  // One item per provider, not one per execution. An outage affecting twenty
  // executions is a single thing a human needs to know, and twenty identical rows
  // would bury the other four kinds.
  for (const provider of [...unreachable].sort()) {
    conditions.push({
      kind: 'provider_unreachable',
      severity: 'critical',
      title: 'The execution provider is unreachable',
      summary:
        'OpenDots could not reach the provider, so execution states may be out of date. Work is unaffected and resumes automatically.',
      sourceType: 'provider',
      sourceId: provider,
    });
  }

  for (const task of input.tasks ?? []) {
    // Only the two states that genuinely wait on a person. A queued or running
    // task is doing what it was told to do and needs nothing from a human.
    if (task.status !== 'paused' && task.status !== 'failed') continue;
    conditions.push({
      kind: 'human_decision_required',
      severity: task.status === 'failed' ? 'warning' : 'info',
      title:
        task.status === 'paused'
          ? 'A task is paused'
          : 'A task failed and needs a decision',
      summary:
        task.status === 'paused'
          ? 'This task is paused and will not run again until it is resumed.'
          : (task.error ??
            'This task failed. Decide whether to retry, edit or cancel it.'),
      sourceType: 'task',
      sourceId: task.id,
    });
  }

  return conditions;
}

/**
 * Evaluate every condition and reconcile it against durable attention.
 *
 * Safe after every reconciliation cycle and safe to run twice: conditions are
 * keyed by identity, so a second pass finds them already recorded and does
 * nothing except observe that previously-true conditions which are now false
 * have cleared.
 */
export class AttentionEvaluator {
  constructor(private readonly store: AttentionStore) {}

  async evaluate(input: EvaluateInput): Promise<EvaluateSummary> {
    const summary: EvaluateSummary = { raised: 0, unchanged: 0, cleared: 0 };
    const live = new Set<string>();

    for (const condition of conditionsFor(input)) {
      // Recomputed here rather than returned by `conditionsFor`, so the evaluator
      // and the store can never disagree about what a condition is.
      const id = attentionIdFor(
        condition.kind,
        condition.sourceType,
        condition.sourceId,
      );
      live.add(id);
      const { created } = await this.store.raise(condition);
      if (created) summary.raised++;
      else summary.unchanged++;
    }

    // Anything recorded but no longer true has its condition marked cleared. A
    // system observation: it records that the problem went away without
    // pretending a human closed the item.
    for (const item of await this.store.list()) {
      if (live.has(item.id)) continue;
      if (item.conditionClearedAt !== null) continue;
      await this.store.clearCondition(item.id);
      summary.cleared++;
    }

    return summary;
  }
}
