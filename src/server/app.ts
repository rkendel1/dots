import { attentionRoutes } from './attention-routes.js';
import { computerRoutes } from './computer-routes.js';
import { decisionRoutes } from './decision-routes.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { configured, type Config } from './research.js';
import type { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import { workspaceRoutes } from './workspace-routes.js';
import type { AttentionStore } from './attention.js';
import type { DecisionStore } from './decisions.js';
import type { DecisionApplicator } from './decision-applicator.js';
import type { DecisionProposalStore } from './decision-proposals.js';
import type { ExecutionService } from './execution-service.js';
import type { ExecutionReconciler } from './execution-reconciler.js';
import { executionRoutes } from './execution-routes.js';
import { configurationRoutes } from './configuration-routes.js';
import type { ConfigurationService } from './configuration.js';
import type { PlatformConfig } from './platform-config.js';
import type { StateFirstDB } from '@feltdb/core';
const interval = z.number().int().min(60).max(31_536_000).nullable();
export interface AppOptions {
  store: Store;
  runner: Runner;
  config: Config;
  ownerToken?: string;
  origin?: string;
  platform?: Platform;
  configService?: ConfigurationService;
  platformConfig?: PlatformConfig;
  /**
   * The execution control layer.
   *
   * Optional because OpenDots must be fully usable with no execution provider at
   * all — Compute is released separately, and its absence is not an error.
   */
  executions?: ExecutionService;
  /**
   * The reconciliation loop.
   *
   * Optional for the same reason `executions` is: OpenDots must be fully usable
   * with no execution provider at all.
   */
  reconciler?: ExecutionReconciler;
  /**
   * The control-plane attention store.
   *
   * Optional because attention needs somewhere durable to write, and the tests
   * that exercise other domains should not be made to construct one. When it is
   * absent the `/api/attention` routes are simply not mounted.
   */
  attention?: AttentionStore;
  /**
   * The decision store for human decisions about attention items.
   *
   * Optional, but mounted only when attention is also present. Decisions are
   * durable records of human choices about conditions.
   */
  decisions?: DecisionStore;
  /**
   * The decision applicator for applying decisions to control-plane operations.
   *
   * Optional; used only when both decisions and attention are present. Applies
   * decisions that have corresponding real operations (currently only dismiss).
   */
  applicator?: DecisionApplicator;
  /**
   * The owner ID for recording which human made a decision.
   *
   * Used when creating decisions to identify the actor. Optional; decisions
   * routes are only mounted when both this and the decision store are present.
   */
  ownerId?: string;
  /**
   * The decision proposal store for agent-suggested decisions.
   *
   * Optional; proposal routes are only mounted when attention is also present.
   * Proposals are durable records of agent suggestions but do not authorize anything.
   */
  proposals?: DecisionProposalStore;
  /**
   * The durable state database.
   * Used for capability discovery and configuration persistence.
   */
  db?: StateFirstDB;
}
export function createApp({
  store,
  runner,
  config,
  ownerToken,
  origin,
  platform,
  executions,
  reconciler,
  attention,
  decisions,
  applicator,
  ownerId,
  proposals,
  configService,
  platformConfig,
  db,
}: AppOptions) {
  const app = new Hono();
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 1_000_000,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const requestUrl = new URL(c.req.url);
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...(origin ? [new URL(origin).hostname] : []),
    ]);
    if (!ownerToken && !allowedHosts.has(requestUrl.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const requestOrigin = c.req.header('origin');
    const expectedOrigin = origin ?? new URL(c.req.url).origin;
    if (requestOrigin && requestOrigin !== expectedOrigin)
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site')
      return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    if (ownerToken) {
      const expected = Buffer.from(ownerToken);
      const supplied = Buffer.from(
        c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
      );
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        return c.json(
          { error: 'Enter your owner access token to unlock OpenDots.' },
          401,
        );
    }
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !c.req.header('content-type')?.includes('application/json')
    )
      return c.json({ error: 'Use application/json.' }, 415);
    await next();
  });
  if (platform) app.route('/api', computerRoutes(platform.computers));
  if (executions) app.route('/api', executionRoutes(executions, reconciler));
  if (attention && executions)
    // Context needs both stores to walk Work → Task → Execution live, so the
    // routes are mounted only when the execution plane is present.
    app.route(
      '/api',
      attentionRoutes({
        store: attention,
        sources: {
          executions: executions.executions,
          tasks: store,
        },
        decisions,
        applicator,
        proposals,
      }),
    );
  if (attention && decisions && ownerId && executions && applicator)
    // Decision routes need attention store, decision store, applicator, owner identity,
    // and executions. They are mounted only when all are present.
    app.route(
      '/api',
      decisionRoutes({
        decisions,
        attention,
        applicator,
        ownerId,
      }),
    );
  const voice = platform ? new VoiceService(platform) : undefined;
  if (platform && voice) app.route('/api', workspaceRoutes(platform, voice));
  if (configService && platformConfig)
    app.route('/api', configurationRoutes(configService, platformConfig, db));
  app.get('/api/state', async (c) =>
    c.json({
      settings: await store.settings(),
      tasks: await store.tasks(),
      memories: await store.memories(),
      mode: config.mode,
      configured: configured(config),
    }),
  );
  app.post('/api/tasks', async (c) => {
    const parsed = z
      .object({
        prompt: z.string().trim().min(3).max(4000),
        intervalSeconds: interval.optional(),
        threadId: z.string().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Enter a request between 3 and 4,000 characters; repeat intervals must be at least 60 seconds.',
        },
        400,
      );
    if (!(await store.settings()).researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    if (platform) {
      if (platform.setup().missing.length)
        return c.json(
          { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
          503,
        );
      if (!parsed.data.threadId)
        return c.json(
          { error: 'Select a conversation for this scheduled task.' },
          400,
        );
      try {
        await platform.workspace.requireThread(parsed.data.threadId);
      } catch {
        return c.json(
          { error: 'Conversation is not owned by this workspace.' },
          403,
        );
      }
    }
    const task = await store.createTask(
      parsed.data.prompt,
      parsed.data.intervalSeconds,
    );
    if (platform && parsed.data.threadId)
      await platform.workspace.bindTask(task.id, parsed.data.threadId);
    return c.json(task, 201);
  });
  app.get('/api/tasks/:id', async (c) => {
    const detail = await store.detail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'Task not found.' }, 404);
  });
  app.post('/api/tasks/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['run', 'pause', 'cancel']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Unknown task action.' }, 400);
    if (
      parsed.data.action === 'run' &&
      !(await store.settings()).researchAllowed
    )
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    const task = await store.action(c.req.param('id'), parsed.data.action);
    if (parsed.data.action !== 'run') runner.abort(c.req.param('id'));
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.put('/api/tasks/:id/schedule', async (c) => {
    const parsed = z
      .object({ intervalSeconds: interval })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Repeat interval must be 60 seconds to one year, or null.' },
        400,
      );
    const task = await store.schedule(
      c.req.param('id'),
      parsed.data.intervalSeconds,
    );
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.patch('/api/settings', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        paused: z.boolean().optional(),
        researchAllowed: z.boolean().optional(),
        memoryAllowed: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid settings.' }, 400);
    const previous = await store.settings();
    const settings = await store.updateSettings(parsed.data);
    if (
      settings.paused ||
      !settings.researchAllowed ||
      previous.memoryAllowed !== settings.memoryAllowed
    )
      runner.abortAll();
    if (settings.paused) await voice?.abortAll();
    else void voice?.resumePending();
    return c.json(settings);
  });
  app.post('/api/memories', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    return c.json(await store.saveMemory(parsed.data.text), 201);
  });
  app.put('/api/memories/:id', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    if (!(await store.memories()).some((m) => m.id === c.req.param('id')))
      return c.json({ error: 'Memory not found.' }, 404);
    return c.json(await store.saveMemory(parsed.data.text, c.req.param('id')));
  });
  app.delete('/api/memories/:id', async (c) =>
    (await store.deleteMemory(c.req.param('id')))
      ? c.json({ ok: true })
      : c.json({ error: 'Memory not found.' }, 404),
  );
  app.onError((error, c) => {
    console.error('API request failed:', error.name);
    return c.json(
      {
        error:
          'The server could not complete this request. Check server logs and database access.',
      },
      500,
    );
  });
  return app;
}
