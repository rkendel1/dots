import { AttentionStore } from './attention.js';
import { AttentionEvaluator } from './attention-evaluator.js';
import { DecisionStore } from './decisions.js';
import { DecisionApplicator } from './decision-applicator.js';
import { DecisionProposalStore } from './decision-proposals.js';
import { createShutdown } from './shutdown.js';
import { join } from 'node:path';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { openFeltState } from './felt/state.js';
import { findClientRoot } from './runtime-scope.js';
import { ExecutionStore } from './executions.js';
import { ExecutionService } from './execution-service.js';
import { computeProviderFromEnv } from './compute-execution-provider.js';
import {
  ExecutionReconciler,
  reconcileIntervalFromEnv,
} from './execution-reconciler.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import type { PlatformConfig } from './platform-config.js';
import { ConfigurationService } from './configuration.js';
import { capabilityDiscoveryFromEnv } from './compute-capability-discovery.js';
import { ComputeReadinessStore } from './compute-readiness-store.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
// The durable state is the single authority for every application domain. It is
// opened before the listener starts, so a second process fails fast instead of
// serving against state it does not own.
const state = openFeltState();
const store = new Store(state.db);
// The execution control layer. Compute is an independent release, so a missing or
// unreachable provider is not a startup failure: the service exists either way and
// the API reports that no provider is configured.
const executions = new ExecutionService(
  new ExecutionStore(state.db),
  computeProviderFromEnv(),
);
// The attention control plane. It reads the same durable records as everything
// else and writes its own interpretation of them — never a copy of an execution.
const attention = new AttentionStore(state.db);
const attentionEvaluator = new AttentionEvaluator(attention);
// Durable human decisions about attention items.
const decisions = new DecisionStore(state.db);
// The decision applicator applies recorded decisions to real control-plane
// operations (currently only dismiss → resolve). Others remain declarative.
const decisionApplicator = new DecisionApplicator(
  state.db,
  decisions,
  attention,
);
// Durable agent decision proposals — suggestions about attention items without authority.
const proposals = new DecisionProposalStore(state.db, attention);
// The reconciliation loop. It discovers its work from FeltDB on every cycle, so
// this line is where "survives a restart" actually happens rather than being
// assumed: the first cycle after startup re-derives the whole outstanding list.
const reconciler = new ExecutionReconciler(
  new ExecutionStore(state.db),
  computeProviderFromEnv(),
  {
    intervalMs: reconcileIntervalFromEnv(),
    // Attention is derived from the state each cycle settles, not polled for on
    // its own schedule. This is the single place execution truth becomes control
    // plane interpretation, and it is why a restarted process rebuilds its
    // attention view with no memory of its own.
    onCycleComplete: async ({ executions }) => {
      await attentionEvaluator.evaluate({
        executions,
        tasks: await store.tasks(),
      });
    },
  },
);
// Reconcile anything a previous process left in flight *before* the listener
// binds, so a restarted OpenDots never serves a stale view of a live execution.
await reconciler.reconcileAll();
const workspace = new WorkspaceStore(
  process.env.OWNER_ID ?? 'opendots-owner',
  state.db,
);
// The first-run defaults are durable-state writes, so they are created before
// anything reads them. Startup still fails fast here, before the listener binds.
await workspace.bootstrap();
const config: PlatformConfig = {
  intelligenceKey: process.env.INTELLIGENCE_API_KEY,
  intelligenceApiUrl: process.env.INTELLIGENCE_API_URL || undefined,
  intelligenceWsUrl: process.env.INTELLIGENCE_WS_URL || undefined,
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  runtimeUrl: `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`,
  ownerToken,
  computeEndpoint: process.env.COMPUTE_ENDPOINT || undefined,
};

// Initialize Compute capability discovery and perform initial readiness check
const computeDiscovery = capabilityDiscoveryFromEnv();
const computeReadiness = new ComputeReadinessStore(state.db);

if (computeDiscovery) {
  // Perform initial readiness check
  const readinessReport = await computeDiscovery.fullReadinessCheck();
  await computeReadiness.update(readinessReport);
}
const platform = await Platform.create(store, workspace, config);
const configService = new ConfigurationService(state.db, workspace.ownerId);
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = await workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no Intelligence conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its Intelligence conversation.');
    const text = await platform.turn(threadId, claim.prompt, signal);
    return { text, sources: [], sample: false };
  },
);
const wsOrigin = new URL(
  config.intelligenceWsUrl ?? 'wss://realtime.intelligence.copilotkit.ai',
).origin;
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin:
    process.env.APP_ORIGIN ??
    (process.env.NODE_ENV === 'development'
      ? 'http://127.0.0.1:5173'
      : undefined),
  platform,
  executions,
  reconciler,
  attention,
  decisions,
  applicator: decisionApplicator,
  ownerId: workspace.ownerId,
  proposals,
  configService,
  platformConfig: config,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsOrigin}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
// Module-relative, never working-directory relative: the installed package is
// started from a user's own project, which has no `dist/` of its own.
const clientRoot = findClientRoot();
app.use('/*', serveStatic({ root: clientRoot }));
app.get('*', serveStatic({ path: join(clientRoot, 'index.html') }));
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`OpenDots template listening on http://${host}:${info.port}`);
  runner.start();
  // Reconciliation starts only after the listener is up, so the startup cycle
  // above is the one bound by the "nothing stale on first request" guarantee.
  reconciler.start();
  void platform
    .start()
    .catch((error) =>
      reportChannelFailure(
        'Slack Channels activation failed; check setup status',
        [safeFailure(error)],
      ),
    );
});
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopReconciler: () => reconciler.stop(),
  stopPlatform: () => platform.stop(),
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  closeState: () => state.close(),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
