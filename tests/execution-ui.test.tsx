import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ExecutionCard, ExecutionPanel } from '../src/client/ExecutionPanel';
import type { Execution } from '../src/shared/types';

const base: Execution = {
  id: 'exec_1',
  taskId: 'task-1',
  dotId: null,
  status: 'running',
  provider: 'compute',
  providerExecutionId: 'job_abc',
  providerSessionId: null,
  providerStatus: 'running',
  idempotencyKey: 'k',
  prompt: 'summarize the repo',
  createdAt: Date.now(),
  startedAt: Date.now(),
  completedAt: null,
  result: null,
  errorCode: null,
  error: null,
};

/**
 * The UI is proved to render what the API returned.
 *
 * These render the component from a real API payload rather than asserting on
 * markup written by hand, which is what "the UI obtains this through the OpenDots
 * API" has to mean in practice: no field shown here is computed client-side, and
 * no status is inferred in the browser.
 */
it('shows a running execution with its provider and identity', () => {
  const html = renderToStaticMarkup(<ExecutionCard execution={base} />);
  expect(html).toContain('Running');
  expect(html).toContain('compute');
  expect(html).toContain('job_abc');
});

it('shows the result of a completed execution', () => {
  const html = renderToStaticMarkup(
    <ExecutionCard
      execution={{
        ...base,
        status: 'completed',
        completedAt: Date.now(),
        result: { stdout: 'the answer' },
      }}
    />,
  );
  expect(html).toContain('Completed');
  expect(html).toContain('the answer');
});

it('shows the error and code of a failed execution', () => {
  const html = renderToStaticMarkup(
    <ExecutionCard
      execution={{
        ...base,
        status: 'failed',
        errorCode: 'remote_execution_failure',
        error: 'the workload exited non-zero',
      }}
    />,
  );
  expect(html).toContain('Failed');
  expect(html).toContain('remote_execution_failure');
  expect(html).toContain('the workload exited non-zero');
});

it("shows the provider's own status when it differs from OpenDots'", () => {
  // A disagreement between the two vocabularies must be visible, not hidden by
  // the normalization.
  const html = renderToStaticMarkup(
    <ExecutionCard
      execution={{
        ...base,
        status: 'queued',
        providerStatus: 'waiting_for_capacity',
      }}
    />,
  );
  expect(html).toContain('Queued');
  expect(html).toContain('waiting_for_capacity');
});

it('offers Run only when a provider is configured', () => {
  const withProvider = renderToStaticMarkup(
    <ExecutionPanel
      executions={[base]}
      provider="compute"
      busy={false}
      onRun={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(withProvider).toContain('Run');
  expect(withProvider).toContain('Running');

  const without = renderToStaticMarkup(
    <ExecutionPanel
      executions={[]}
      provider={null}
      busy={false}
      onRun={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(without).toContain('No execution provider is configured');
  // The button is still shown, but disabled: hiding it would leave the user with
  // no way to learn that the execution plane exists and is simply not connected.
  expect(without).toMatch(/<button[^>]*disabled[^>]*>Run<\/button>/);
});

it('disables Run while a request is in flight', () => {
  const html = renderToStaticMarkup(
    <ExecutionPanel
      executions={[]}
      provider="compute"
      busy
      onRun={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Run<\/button>/);
});
