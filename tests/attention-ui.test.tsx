/**
 * The attention UI.
 *
 * Rendered statically from the payloads the API returns, so these tests are about
 * one thing: that the panel shows the *distinction* the domain makes, rather than
 * collapsing it.
 *
 * The distinctions worth protecting:
 *
 *   - Acknowledged ≠ resolved. An acknowledged item must still be listed.
 *   - Condition cleared ≠ resolved by a human, and must be labelled as such.
 *   - A healthy execution must not appear at all. Rendering ordinary progress as
 *     attention is how a person stops trusting a panel.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttentionCard } from '../src/client/AttentionCard';
import type { Attention } from '../src/shared/types';

/** A complete item, so a test changes one field and means it. */
function item(patch: Partial<Attention> = {}): Attention {
  return {
    id: 'attn_1',
    kind: 'execution_failed',
    severity: 'critical',
    status: 'open',
    title: 'An execution failed',
    summary: 'the workload exited non-zero',
    sourceType: 'execution',
    sourceId: 'exec_1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    acknowledgedAt: null,
    resolvedAt: null,
    conditionClearedAt: null,
    ...patch,
  };
}

/**
 * `AttentionPanel` fetches on mount, which static rendering cannot do, so the
 * card is rendered directly. That is the part carrying every distinction the
 * domain makes; the fetching and the actions are covered through the API suite.
 */
async function render(items: Attention[]) {
  return renderToStaticMarkup(
    <ul>
      {items.map((attention) => (
        <AttentionCard
          key={attention.id}
          item={attention}
          busy={false}
          selected={false}
          onSelect={() => {}}
          onAcknowledge={() => {}}
          onResolve={() => {}}
        />
      ))}
    </ul>,
  );
}

describe('the attention card', () => {
  it('shows what needs attention: severity, kind, explanation and age', async () => {
    const html = await render([item()]);
    expect(html).toContain('An execution failed');
    expect(html).toContain('Execution failed');
    expect(html).toContain('the workload exited non-zero');
    // Severity is carried structurally, not only in prose.
    expect(html).toContain('attention-item critical');
  });

  it('offers exactly two actions, and both are visible on an open item', async () => {
    const html = await render([item()]);
    expect(html).toContain('Acknowledge');
    expect(html).toContain('Resolve');
    // §14: no retry, no edit, no "change provider". This is a control plane for
    // deciding what matters, not a command channel.
    for (const forbidden of [
      'Retry',
      'Edit',
      'Cancel execution',
      'Change provider',
    ])
      expect(html).not.toContain(forbidden);
  });

  it('shows an acknowledged item as seen, and still offers Resolve', async () => {
    const html = await render([
      item({ status: 'acknowledged', acknowledgedAt: Date.now() }),
    ]);
    expect(html).toContain('Acknowledged');
    // Acknowledging is not resolving, so the item is not presented as finished and
    // the way out is still on offer.
    expect(html).toContain('Resolve');
    expect(html).not.toContain('>Resolved<');
  });

  it('labels a cleared condition as cleared rather than resolved', async () => {
    // The distinction the whole design turns on, made visible to a person: nothing
    // is wrong any more, and nobody decided anything.
    const html = await render([item({ conditionClearedAt: Date.now() })]);
    expect(html).toContain('Condition cleared');
    expect(html).not.toContain('Resolved<');
  });

  it('shows a resolved item as resolved, with no further actions', async () => {
    const html = await render([
      item({ status: 'resolved', resolvedAt: Date.now() }),
    ]);
    expect(html).toContain('Resolved');
    expect(html).not.toContain('Acknowledge');
  });

  it('distinguishes the kinds in plain language', async () => {
    const html = await render([
      item({ id: 'a', kind: 'provider_unreachable' }),
      item({ id: 'b', kind: 'execution_evidence_pending', severity: 'info' }),
      item({ id: 'c', kind: 'human_decision_required' }),
      item({ id: 'd', kind: 'execution_blocked', severity: 'warning' }),
    ]);
    expect(html).toContain('Provider unreachable');
    expect(html).toContain('Result pending');
    expect(html).toContain('Decision needed');
    expect(html).toContain('Execution blocked');
  });

  it('does not invent an explanation when the provider gave none', async () => {
    const html = await render([
      item({ summary: 'Compute reported a failure.' }),
    ]);
    expect(html).toContain('Compute reported a failure.');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('[object Object]');
  });
});
