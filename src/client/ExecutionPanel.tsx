import { CircleAlert, CircleCheck, LoaderCircle, Square } from 'lucide-react';
import type { Execution } from '../shared/types';
import { relative } from './TaskPresentation';

/**
 * Execution visibility in the existing UI.
 *
 * Deliberately a component that *displays* what the API reported, and nothing
 * more. It never sets a status locally and never guesses: every value rendered
 * here came from `GET /api/executions`, which reconciles against the provider
 * first. If there is no provider configured the card says so rather than showing
 * a blank panel.
 */
const LABEL: Record<Execution['status'], string> = {
  queued: 'Queued',
  starting: 'Starting',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function StatusIcon({ status }: { status: Execution['status'] }) {
  if (status === 'completed') return <CircleCheck size={14} />;
  if (status === 'failed') return <CircleAlert size={14} />;
  if (status === 'queued' || status === 'starting' || status === 'running')
    return <LoaderCircle className="spin" size={14} />;
  return <Square size={12} />;
}

function ResultBody({ result }: { result: unknown }) {
  if (result === null || result === undefined) return null;
  const text =
    typeof result === 'string'
      ? result
      : (() => {
          try {
            return JSON.stringify(result, null, 2);
          } catch {
            return 'The provider returned a result that cannot be displayed.';
          }
        })();
  return <pre className="execution-result">{text}</pre>;
}

export function ExecutionCard({
  execution,
  onCancel,
}: {
  execution: Execution;
  onCancel?: () => void;
}) {
  const live =
    execution.status === 'queued' ||
    execution.status === 'starting' ||
    execution.status === 'running';
  return (
    <div className={`execution ${execution.status}`}>
      <div className="execution-head">
        <strong>Execution</strong>
        <span className="execution-status">
          <StatusIcon status={execution.status} />
          {LABEL[execution.status]}
        </span>
      </div>
      <dl>
        <dt>Provider</dt>
        <dd>{execution.provider}</dd>
        {execution.providerExecutionId && (
          <>
            <dt>Provider execution</dt>
            <dd>
              <code>{execution.providerExecutionId}</code>
            </dd>
          </>
        )}
        {execution.startedAt !== null && (
          <>
            <dt>Started</dt>
            <dd>{relative(execution.startedAt)}</dd>
          </>
        )}
        {execution.completedAt !== null && (
          <>
            <dt>Finished</dt>
            <dd>{relative(execution.completedAt)}</dd>
          </>
        )}
        {/* The provider's own status word, shown next to the normalized one so a
            disagreement is visible rather than hidden by the mapping. */}
        {execution.providerStatus &&
          execution.providerStatus !== execution.status && (
            <>
              <dt>Provider status</dt>
              <dd>
                <code>{execution.providerStatus}</code>
              </dd>
            </>
          )}
      </dl>
      {execution.error && (
        <p className="chat-error">
          {execution.errorCode ? `${execution.errorCode}: ` : ''}
          {execution.error}
        </p>
      )}
      {execution.status === 'completed' && (
        <ResultBody result={execution.result} />
      )}
      {live && onCancel && (
        <button className="quiet-button" onClick={onCancel}>
          <Square size={12} />
          Cancel execution
        </button>
      )}
    </div>
  );
}

/**
 * The list of executions for a task, plus the smallest possible Run action.
 *
 * The action is only offered when the API reported a provider. Pressing Run with
 * none configured would produce a 503, and offering a button that cannot work is
 * worse than saying the execution plane is not connected.
 */
export function ExecutionPanel({
  executions,
  provider,
  busy,
  onRun,
  onCancel,
  runDisabledReason,
}: {
  executions: Execution[];
  provider: string | null;
  busy: boolean;
  onRun: () => void;
  onCancel: (id: string) => void;
  runDisabledReason?: string;
}) {
  return (
    <section className="execution-panel">
      <div className="execution-panel-head">
        <h3>Executions</h3>
        <button disabled={busy || !provider} onClick={onRun}>
          Run
        </button>
      </div>
      {!provider ? (
        <p className="muted">
          {runDisabledReason ??
            'No execution provider is configured. Set COMPUTE_ENDPOINT to run work on Compute.'}
        </p>
      ) : executions.length === 0 ? (
        <p className="muted">No executions yet.</p>
      ) : (
        executions.map((execution) => (
          <ExecutionCard
            key={execution.id}
            execution={execution}
            onCancel={() => onCancel(execution.id)}
          />
        ))
      )}
    </section>
  );
}
