/**
 * The attention view — "what needs my attention?".
 *
 * The fetching half of the feature. `AttentionCard` holds the rendering and the
 * distinctions between acknowledged, resolved and condition-cleared; this loads
 * the list, runs the two human actions, and fetches the context of a selected
 * item.
 *
 * Context is loaded on demand and never embedded in the list, because it is
 * resolved live from the records an item references — a list response must never
 * be able to cache it.
 */
import { useEffect, useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import { api } from './api';
import { relative } from './TaskPresentation';
import { AttentionCard, outstanding } from './AttentionCard';
import type { Attention, AttentionContext } from '../shared/types';

/**
 * Context for the selected item, loaded on demand.
 *
 * Fetched separately from the list rather than embedded in it, because context is
 * resolved live and a list response must never be able to cache it.
 */
function AttentionContextPane({ id }: { id: string }) {
  const [context, setContext] = useState<AttentionContext>();
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setContext(undefined);
    setError('');
    api<{ context: AttentionContext }>(`/attention/${id}/context`)
      .then((body) => current && setContext(body.context))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [id]);

  if (error) return <p className="chat-error">{error}</p>;
  if (!context) return <p className="muted">Loading context…</p>;
  if (context.sourceMissing)
    return (
      <p className="muted">
        The {context.attention.sourceType} this referred to no longer exists.
      </p>
    );

  const { execution, task, runs } = context;
  return (
    <div className="attention-context">
      <h4>Why am I seeing this?</h4>
      {task && (
        <dl>
          <dt>Task</dt>
          <dd>{task.prompt}</dd>
          <dt>Task status</dt>
          <dd>{task.status}</dd>
        </dl>
      )}
      {execution && (
        <dl>
          <dt>Execution</dt>
          <dd>
            <code>{execution.id}</code>
          </dd>
          <dt>Execution status</dt>
          {/* Read live, so this is the state now rather than the state when the
              item was raised. */}
          <dd>{execution.status}</dd>
          <dt>Provider</dt>
          <dd>{execution.provider}</dd>
          {execution.providerExecutionId && (
            <>
              <dt>Compute job</dt>
              <dd>
                <code>{execution.providerExecutionId}</code>
              </dd>
            </>
          )}
          {execution.error && (
            <>
              <dt>Reported error</dt>
              <dd>
                {execution.errorCode ? `${execution.errorCode}: ` : ''}
                {execution.error}
              </dd>
            </>
          )}
          <dt>Result</dt>
          {/* "Completed" and "the result is here" are different claims, and the
              record distinguishes them. */}
          <dd>
            {execution.resultRetrieved ? 'Retrieved' : 'Not retrieved yet'}
          </dd>
          {execution.receipt !== null && (
            <>
              <dt>Receipt</dt>
              <dd>Retrieved</dd>
            </>
          )}
        </dl>
      )}
      {runs.length > 0 && (
        <dl>
          <dt>Recent runs</dt>
          <dd>
            {runs.map((run) => (
              <span key={run.id} className="attention-run">
                {run.status} · {relative(run.startedAt)}
              </span>
            ))}
          </dd>
        </dl>
      )}
    </div>
  );
}

export function AttentionPanel({
  onChanged,
}: {
  /** Called after a human action, so the host can refresh anything it shows. */
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<Attention[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const body = await api<{ attention: Attention[] }>('/attention');
      setItems(body.attention);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (id: string, action: 'acknowledge' | 'resolve') => {
    setBusy(true);
    try {
      await api(`/attention/${id}/${action}`, 'POST', {});
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const open = items.filter(outstanding);
  // Everything else still exists — it simply stopped asking for anything. Shown
  // rather than hidden, because "this stopped being a problem" and "this never
  // happened" are different things.
  const settled = items.filter((item) => !outstanding(item));

  const card = (item: Attention) => (
    <AttentionCard
      key={item.id}
      item={item}
      busy={busy}
      selected={selected === item.id}
      onSelect={() => setSelected(selected === item.id ? '' : item.id)}
      onAcknowledge={() => void act(item.id, 'acknowledge')}
      onResolve={() => void act(item.id, 'resolve')}
    />
  );

  return (
    <section className="attention-panel">
      <div className="attention-panel-head">
        <h3>
          {open.length > 0 ? <BellRing size={14} /> : <Bell size={14} />}
          Needs attention
          <span className="attention-count">{open.length}</span>
        </h3>
        <button className="quiet-button" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">
          Nothing needs attention. Executions that are running normally do not
          appear here.
        </p>
      ) : (
        <>
          {open.length === 0 && (
            <p className="muted">Nothing needs attention right now.</p>
          )}
          <ul className="attention-list">{open.map(card)}</ul>
          {selected && <AttentionContextPane id={selected} />}
          {settled.length > 0 && (
            <details className="attention-settled">
              <summary>{settled.length} no longer needing attention</summary>
              <ul className="attention-list">{settled.map(card)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
