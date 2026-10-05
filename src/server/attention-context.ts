/**
 * Attention context — "why am I seeing this?".
 *
 * This is a projection over records that already exist, assembled at read time.
 * Nothing here is stored on the attention item: an execution that was `running`
 * when the item was raised may be `completed` now, and a context endpoint that
 * reported the state captured at raise time would be answering a question about
 * the past. So the chain is walked live on every request —
 *
 *     Attention → Work → Task → Execution → Compute job → Result / Receipt
 *
 * — and each link is whatever the database says *now*. A link that no longer
 * exists is reported as absent rather than omitted, because "the task was deleted"
 * is part of the answer to why something needs attention.
 *
 * {@link AttentionContext} is declared in `shared/` because the browser renders
 * it; only the composition lives here.
 */
import type {
  Attention,
  AttentionContext,
  Execution,
  Run,
  Task,
} from '../shared/types.js';

/** What the caller had to hand, read fresh for this request. */

export interface ContextSources {
  execution?: Execution | null;
  task?: Task | null;
  runs?: Run[];
}

/**
 * Assemble the context for one item from live durable state.
 *
 * Pure by design: it takes the *already-read* current records rather than
 * fetching them, so the caller controls what "current" means and this stays
 * trivially testable. It never caches, and it never writes.
 */
export function resolveContext(
  attention: Attention,
  sources: ContextSources,
): AttentionContext {
  const execution =
    attention.sourceType === 'execution' ? (sources.execution ?? null) : null;
  const task =
    attention.sourceType === 'task'
      ? (sources.task ?? null)
      : // An execution's task is one hop away and is resolved the same way, so
        // the chain Work → Task → Execution stays live rather than snapshot.
        execution?.taskId
        ? (sources.task ?? null)
        : null;

  // The item is "missing" only when it named an entity that is not there. An
  // execution with no task is normal — many executions are requested directly.
  const sourceMissing =
    (attention.sourceType === 'execution' && execution === null) ||
    (attention.sourceType === 'task' && task === null) ||
    (attention.sourceType === 'provider' && !attention.sourceId);

  return {
    attention,
    execution,
    task,
    runs: task ? (sources.runs ?? []) : [],
    sourceMissing,
  };
}
