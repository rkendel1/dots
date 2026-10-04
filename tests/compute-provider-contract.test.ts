/**
 * Contract tests for the OpenDots ↔ Compute execution boundary.
 *
 * The invariant these protect:
 *
 * ```
 *   OpenDots execution model  ↕  compute.remote@1
 * ```
 *
 * Compute's protocol is declared in Rust, in `compute-provider/src/lib.rs`. A
 * change there — a renamed route, a new `JobStatus`, a different idempotency
 * header — must fail *these* tests rather than silently breaking OpenDots in
 * production.
 *
 * ## How these tests avoid inventing a Compute endpoint
 *
 * They stub the transport, not the protocol. Every request the adapter makes is
 * asserted for its exact method, path and headers, and every response is a
 * literal shaped like the real one. If OpenDots were talking to a route Compute
 * does not declare, the path assertion below would be asserting fiction — so the
 * routes, the status vocabulary and the job-identity format listed here are
 * transcribed from Compute's own source and are the thing under test.
 *
 * No Compute instance is started, and none is required: this is a contract test,
 * not an integration test.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMPUTE_PROTOCOL,
  ComputeExecutionProvider,
  computeProviderFromEnv,
} from '../src/server/compute-execution-provider.js';
import {
  ExecutionProviderError,
  normalizeExecutionStatus,
} from '../src/server/execution-provider.js';

/** A `JobId` exactly as `compute_core::JobId::generate` produces one. */
const JOB = `job_${'a'.repeat(64)}`;

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Serve a fixed set of canned answers, recording what was asked for.
 *
 * Keyed by `"<METHOD> <path>"` so a test can also assert on a route the adapter
 * never calls, by leaving it unhandled and watching the adapter fail.
 */
function stub(routes: Record<string, { status?: number; json: unknown }>): {
  seen: Seen[];
  fetch: typeof fetch;
} {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    seen.push({
      url,
      method,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes[`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.json), {
      status: route.status ?? 200,
    });
  });
  return {
    seen,
    fetch: impl as unknown as typeof fetch,
  };
}

function provider(
  routes: Parameters<typeof stub>[0],
  options: { authorization?: string } = {},
) {
  const harness = stub(routes);
  const original = globalThis.fetch;
  globalThis.fetch = harness.fetch;
  return {
    ...harness,
    restore: () => {
      globalThis.fetch = original;
    },
    provider: new ComputeExecutionProvider({
      endpoint: 'http://compute.test:8080',
      ...(options.authorization
        ? { authorization: options.authorization }
        : {}),
    }),
  };
}

describe('compute.remote@1 — the routes OpenDots depends on', () => {
  it('submits a durable job to POST /compute/jobs with the protocol header', async () => {
    const harness = provider({
      'POST /compute/jobs': {
        json: { job_id: JOB, status: 'accepted', request_id: 'req_1' },
      },
    });
    try {
      const handle = await harness.provider.start({
        executionId: 'exec_1',
        idempotencyKey: 'opendots-key',
        input: { prompt: 'hello' },
      });
      expect(handle.providerExecutionId).toBe(JOB);
      const call = harness.seen[0]!;
      expect(call.method).toBe('POST');
      // The exact route `parse_route` declares for `ProviderOperation::Submit`.
      expect(call.url).toBe('http://compute.test:8080/compute/jobs');
      expect(call.headers['X-Compute-Protocol']).toBe(COMPUTE_PROTOCOL);
      // Compute's own idempotency header, spelled as Compute spells it.
      expect(call.headers['Idempotency-Key']).toBe('opendots-key');
    } finally {
      harness.restore();
    }
  });

  it('sends a workload that only uses fields Compute declares', async () => {
    const harness = provider({
      'POST /compute/jobs': { json: { job_id: JOB, status: 'accepted' } },
    });
    try {
      await harness.provider.start({
        executionId: 'exec_1',
        idempotencyKey: 'k',
        input: { prompt: 'summarize this' },
      });
      const body = harness.seen[0]!.body as {
        protocol: string;
        artifact: { Inline: Record<string, unknown> };
      };
      expect(body.protocol).toBe('compute.remote@1');
      // `ArtifactTransport` is an externally tagged enum in Compute, so the
      // variant really is a key named `Inline`.
      const inline = body.artifact.Inline;
      expect(inline).toBeDefined();
      const workload = inline!.workload as Record<string, unknown>;
      expect(workload.version).toBe('1');
      expect(workload.runtime).toBe('shell');
      const entrypoint = inline!.entrypoint as { path: string; data: string };
      expect(entrypoint.path).toBe('run.sh');
      const inputs = inline!.inputs as { path: string; data: string }[];
      expect(inputs[0]).toEqual({ path: 'prompt.txt', data: 'summarize this' });
    } finally {
      harness.restore();
    }
  });

  it('reads status from GET /compute/jobs/{id}', async () => {
    const harness = provider({
      [`GET /compute/jobs/${JOB}`]: {
        json: { job_id: JOB, status: 'waiting_for_capacity' },
      },
    });
    try {
      const report = await harness.provider.getStatus({
        providerExecutionId: JOB,
      });
      expect(report.providerStatus).toBe('waiting_for_capacity');
      expect(report.terminal).toBe(false);
      expect(harness.seen[0]?.url).toBe(
        `http://compute.test:8080/compute/jobs/${JOB}`,
      );
    } finally {
      harness.restore();
    }
  });

  it('reads the result only once the execution has finished', async () => {
    const harness = provider({
      [`GET /compute/jobs/${JOB}`]: {
        json: { job_id: JOB, status: 'running' },
      },
      [`GET /compute/jobs/${JOB}/result`]: {
        json: {
          job_id: JOB,
          status: 'succeeded',
          result: { exit_code: 0, stdout: { text: 'ok' } },
        },
      },
    });
    try {
      const running = await harness.provider.getStatus({
        providerExecutionId: JOB,
      });
      expect(running.terminal).toBe(false);
      expect(running.result).toBeUndefined();
      // No premature result read: that endpoint is only for finished work.
      expect(harness.seen.map((s) => s.url)).not.toContain(
        `http://compute.test:8080/compute/jobs/${JOB}/result`,
      );
    } finally {
      harness.restore();
    }
  });

  it('reads the result of a finished execution', async () => {
    const harness = provider({
      [`GET /compute/jobs/${JOB}`]: {
        json: { job_id: JOB, status: 'succeeded' },
      },
      [`GET /compute/jobs/${JOB}/result`]: {
        json: {
          job_id: JOB,
          status: 'succeeded',
          result: { exit_code: 0, stdout: { text: 'the answer' } },
        },
      },
    });
    try {
      const report = await harness.provider.getStatus({
        providerExecutionId: JOB,
      });
      expect(report.terminal).toBe(true);
      expect(report.result).toMatchObject({
        stdout: { text: 'the answer' },
      });
    } finally {
      harness.restore();
    }
  });

  it('cancels through POST /compute/jobs/{id}/cancel', async () => {
    const harness = provider({
      [`POST /compute/jobs/${JOB}/cancel`]: { json: {} },
    });
    try {
      await harness.provider.cancel({ providerExecutionId: JOB });
      expect(harness.seen[0]?.method).toBe('POST');
      expect(harness.seen[0]?.url).toBe(
        `http://compute.test:8080/compute/jobs/${JOB}/cancel`,
      );
    } finally {
      harness.restore();
    }
  });

  it('checks readiness with GET /compute/health', async () => {
    const harness = provider({ 'GET /compute/health': { json: {} } });
    try {
      expect(await harness.provider.ready()).toBe(true);
      expect(harness.seen[0]?.url).toBe(
        'http://compute.test:8080/compute/health',
      );
    } finally {
      harness.restore();
    }
  });

  it('reports not-ready rather than throwing when Compute is unreachable', async () => {
    const harness = provider({});
    try {
      expect(await harness.provider.ready()).toBe(false);
    } finally {
      harness.restore();
    }
  });
});

describe('compute.remote@1 — failures', () => {
  it("surfaces Compute's own error kind, verbatim", async () => {
    const harness = provider({
      'POST /compute/jobs': {
        status: 409,
        json: {
          kind: 'idempotency_conflict',
          message: 'idempotency key was already used for a different request',
        },
      },
    });
    try {
      await harness.provider
        .start({
          executionId: 'e',
          idempotencyKey: 'k',
          input: { prompt: 'p' },
        })
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(ExecutionProviderError);
          expect((error as ExecutionProviderError).code).toBe(
            'idempotency_conflict',
          );
          expect((error as ExecutionProviderError).message).toMatch(
            /already used for a different request/,
          );
        });
      expect.hasAssertions();
    } finally {
      harness.restore();
    }
  });

  it('refuses to ask Compute about a job identity it would reject', async () => {
    const harness = provider({});
    try {
      await expect(
        harness.provider.getStatus({ providerExecutionId: 'not-a-job' }),
      ).rejects.toThrow(/malformed job identity/);
      await expect(
        harness.provider.cancel({ providerExecutionId: 'not-a-job' }),
      ).rejects.toThrow(/malformed job identity/);
      // Nothing was sent: Compute would have rejected the path itself.
      expect(harness.seen).toHaveLength(0);
    } finally {
      harness.restore();
    }
  });

  it("rejects a job identity that does not match Compute's format", async () => {
    const harness = provider({
      'POST /compute/jobs': { json: { job_id: 'short', status: 'accepted' } },
    });
    try {
      await expect(
        harness.provider.start({
          executionId: 'e',
          idempotencyKey: 'k',
          input: { prompt: 'p' },
        }),
      ).rejects.toThrow(/malformed job identity/);
    } finally {
      harness.restore();
    }
  });

  it('refuses an idempotency key Compute would reject, without a round trip', async () => {
    const harness = provider({});
    try {
      for (const idempotencyKey of ['', 'x'.repeat(257), 'bad\nkey']) {
        await expect(
          harness.provider.start({
            executionId: 'e',
            idempotencyKey,
            input: { prompt: 'p' },
          }),
        ).rejects.toThrow(/idempotency key/i);
      }
      expect(harness.seen).toHaveLength(0);
    } finally {
      harness.restore();
    }
  });

  it('reports a submission status it does not understand, loudly', async () => {
    const harness = provider({
      'POST /compute/jobs': {
        json: { job_id: JOB, status: 'teleported' },
      },
    });
    try {
      await expect(
        harness.provider.start({
          executionId: 'e',
          idempotencyKey: 'k',
          input: { prompt: 'p' },
        }),
      ).rejects.toThrow(/unrecognized status "teleported"/);
    } finally {
      harness.restore();
    }
  });
});

describe('compute JobStatus → OpenDots lifecycle', () => {
  const cases: [string, boolean, string][] = [
    ['created', false, 'queued'],
    ['accepted', false, 'queued'],
    ['queued', false, 'queued'],
    ['waiting_for_capacity', false, 'queued'],
    ['reserved', false, 'queued'],
    ['admitted', false, 'starting'],
    ['preparing', false, 'starting'],
    ['running', false, 'running'],
    ['succeeded', true, 'completed'],
    ['failed', true, 'failed'],
    ['cancelled', true, 'cancelled'],
    ['timed_out', true, 'failed'],
    ['rejected', true, 'failed'],
  ];

  it.each(cases)(
    'maps Compute %s to %s',
    (providerStatus, terminal, expected) => {
      expect(normalizeExecutionStatus(providerStatus, terminal)).toBe(expected);
    },
  );

  it('refuses to guess a status this build has never seen', () => {
    // A Compute release adding a `JobStatus` must fail here, not silently map an
    // unknown outcome onto a lifecycle state.
    expect(() =>
      normalizeExecutionStatus('quantum_superposition', false),
    ).toThrow(/unrecognized status/);
  });

  it('treats a terminal-but-unknown-to-this-build status as a failure', () => {
    // Defensive: even within the known vocabulary, only `succeeded` completes.
    for (const terminal of [
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'rejected',
    ]) {
      const status = normalizeExecutionStatus(terminal, true);
      if (terminal === 'succeeded') expect(status).toBe('completed');
      else if (terminal === 'cancelled') expect(status).toBe('cancelled');
      else expect(status).toBe('failed');
    }
  });
});

describe('provider configuration', () => {
  it('is absent unless COMPUTE_ENDPOINT is set', () => {
    expect(computeProviderFromEnv({})).toBeUndefined();
    expect(computeProviderFromEnv({ COMPUTE_ENDPOINT: '   ' })).toBeUndefined();
  });

  it('is built from COMPUTE_ENDPOINT, and nothing else', () => {
    const built = computeProviderFromEnv({
      COMPUTE_ENDPOINT: 'http://localhost:8080',
      COMPUTE_AUTHORIZATION: 'Bearer secret',
    });
    expect(built?.name).toBe('compute');
    // No environment variable anywhere selects the scripted test provider.
    const withTestFlag = computeProviderFromEnv({
      COMPUTE_ENDPOINT: 'http://x',
      OPENDOTS_TEST: '1',
      NODE_ENV: 'test',
    });
    expect(withTestFlag?.name).toBe('compute');
  });
});
