/**
 * One attention item, rendered.
 *
 * Deliberately free of any data fetching, so it can be rendered and asserted on
 * its own — and so the browser bundle for a list row does not pull in the API
 * client. Every value shown here came from `GET /api/attention`; the component
 * decides nothing and computes nothing the server did not already say.
 *
 * The distinction it renders carefully is the one the domain exists to keep:
 * **acknowledged is not resolved**, and **a cleared condition is not a human
 * resolving anything**. They are different words, because collapsing them would
 * tell a person something had been dealt with when it had not.
 */
import { Bell, Check, Eye, TriangleAlert } from 'lucide-react';
import { relative } from './TaskPresentation';
import type { Attention } from '../shared/types';

export const KIND_LABEL: Record<Attention['kind'], string> = {
  execution_failed: 'Execution failed',
  execution_blocked: 'Execution blocked',
  execution_evidence_pending: 'Result pending',
  provider_unreachable: 'Provider unreachable',
  human_decision_required: 'Decision needed',
};

/**
 * Whether an item still needs a human.
 *
 * Mirrors the server's `needsAttention`: a live condition nobody has resolved.
 * Written out rather than imported because this runs in the browser, where the
 * server module is not reachable. It is two lines and is tested on both sides,
 * which is a fairer trade than a browser bundle importing server code.
 */
export function outstanding(item: Attention) {
  return item.conditionClearedAt === null && item.status !== 'resolved';
}

export function AttentionCard({
  item,
  selected,
  busy,
  onSelect,
  onAcknowledge,
  onResolve,
}: {
  item: Attention;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onAcknowledge: () => void;
  onResolve: () => void;
}) {
  return (
    <li
      className={`attention-item ${item.severity}${selected ? ' selected' : ''}`}
    >
      <button className="attention-open" onClick={onSelect}>
        <span className="attention-title">
          {item.severity === 'critical' ? (
            <TriangleAlert size={14} />
          ) : (
            <Bell size={14} />
          )}
          {item.title}
        </span>
        <span className="attention-meta">
          <span className="attention-kind">{KIND_LABEL[item.kind]}</span>
          <span>{relative(item.createdAt)}</span>
          {item.status === 'acknowledged' && (
            <span className="attention-badge">Acknowledged</span>
          )}
          {item.conditionClearedAt !== null && item.status !== 'resolved' && (
            // The condition went away on its own. Not the same as a human
            // resolving it, and saying so is the whole point of showing it.
            <span className="attention-badge cleared">Condition cleared</span>
          )}
        </span>
        <span className="attention-summary">{item.summary}</span>
      </button>
      <div className="attention-actions">
        {item.status !== 'resolved' ? (
          <>
            <button
              className="quiet-button"
              disabled={busy || item.status === 'acknowledged'}
              onClick={onAcknowledge}
            >
              <Eye size={12} />
              Acknowledge
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={onResolve}
            >
              <Check size={12} />
              Resolve
            </button>
          </>
        ) : (
          <span className="muted">Resolved</span>
        )}
      </div>
    </li>
  );
}
