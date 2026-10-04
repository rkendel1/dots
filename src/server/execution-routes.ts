/**
 * Execution routes, following this repository's existing router convention.
 *
 * Mounted by `app.ts` as `app.route('/api', executionRoutes(...))`, the same way
 * `computerRoutes` and `workspaceRoutes` are. Every handler goes through
 * `ExecutionService`; none of them touches FeltDB.
 *
 * The surface is deliberately small:
 *
 *   `GET  /executions`        list, optionally filtered by task
 *   `POST /executions`        request one; carries the idempotency key
 *   `GET  /executions/:id`    read one, reconciled against the provider
 *   `POST /executions/:id/cancel`  ask the provider to stop it
 *
 * There is deliberately no `PATCH /executions/:id`. Execution status is not
 * client-writable: it only ever changes as a result of what the provider reports,
 * so a UI cannot put an execution into a state the provider never entered.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ExecutionService } from './execution-service.js';
import { ExecutionProviderError } from './execution-provider.js';
import { InvalidExecutionTransition } from './executions.js';

const prompt = z.string().trim().min(1).max(8000);
const idempotencyKey = z
  .string()
  .trim()
  .min(1)
  .max(256)
  // Compute rejects control characters in an idempotency key; rejecting them here
  // keeps the failure attributable to the request rather than to the provider.
  .refine(
    // Compute rejects control characters in an idempotency key, so this must too.
    // The escape is deliberate: it is the whole point of the rule, which is why
    // the lint rule about control characters in a regex is switched off here.
    // eslint-disable-next-line no-control-regex
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    { message: 'An idempotency key cannot contain control characters.' },
  );

export function executionRoutes(service: ExecutionService): Hono {
  const app = new Hono();

  app.get('/executions', async (c) =>
    c.json({
      executions: await service.executions.list(
        c.req.query('taskId')
          ? { taskId: c.req.query('taskId') as string }
          : {},
      ),
      // Whether a provider is configured at all, so the UI can offer the action
      // honestly instead of letting a user press a button that cannot work.
      provider: service.configured ? service.providerName : null,
    }),
  );

  app.post('/executions', async (c) => {
    const parsed = z
      .object({
        prompt,
        taskId: z.string().min(1).optional(),
        dotId: z.string().min(1).optional(),
        idempotencyKey,
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Send a prompt of 1–8,000 characters and an idempotency key of 1–256 bytes with no control characters.',
        },
        400,
      );
    if (!service.configured)
      return c.json(
        {
          error:
            'No execution provider is configured. Set COMPUTE_ENDPOINT to a Compute node serving compute.remote@1.',
        },
        503,
      );
    try {
      const { execution, created } = await service.request({
        prompt: parsed.data.prompt,
        idempotencyKey: parsed.data.idempotencyKey,
        ...(parsed.data.taskId ? { taskId: parsed.data.taskId } : {}),
        ...(parsed.data.dotId ? { dotId: parsed.data.dotId } : {}),
      });
      // A retry is answered with the execution the first attempt produced, and
      // says so, rather than being reported as a fresh creation.
      return c.json({ execution, created }, created ? 201 : 200);
    } catch (error) {
      if (error instanceof ExecutionProviderError)
        return c.json({ error: error.message }, 502);
      throw error;
    }
  });

  app.get('/executions/:id', async (c) => {
    const stored = await service.executions.get(c.req.param('id'));
    if (!stored) return c.json({ error: 'Execution not found.' }, 404);
    if (!service.configured) return c.json({ execution: stored });
    try {
      // Reading an execution refreshes it from the provider, so what the UI shows
      // is the provider's answer rather than a snapshot that may be stale.
      return c.json({ execution: await service.reconcile(stored) });
    } catch {
      // The provider is unreachable. The durable record is still correct and
      // still returned, rather than the read failing entirely.
      return c.json({ execution: stored });
    }
  });

  app.post('/executions/:id/cancel', async (c) => {
    const stored = await service.executions.get(c.req.param('id'));
    if (!stored) return c.json({ error: 'Execution not found.' }, 404);
    try {
      return c.json({ execution: await service.cancel(stored) });
    } catch (error) {
      if (error instanceof InvalidExecutionTransition)
        return c.json({ error: error.message }, 409);
      if (error instanceof ExecutionProviderError)
        return c.json({ error: error.message }, 502);
      throw error;
    }
  });

  return app;
}
