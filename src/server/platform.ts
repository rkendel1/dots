import './copilotkit-telemetry.js';
import { ComputerService } from './computer-service.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import {
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { currentTurnText } from './headless.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { ConversationStore } from './conversation-store.js';
import { FeltAgentRunner } from './felt-agent-runner.js';
import type { IntelligenceService } from './intelligence.js';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';

/**
 * The OpenDots conversation platform.
 *
 * CopilotKit's runtime serves the chat protocol in SSE mode. Conversation
 * history is OpenDots state in FeltDB (via {@link FeltAgentRunner}); model
 * inference is the Intelligence capability, resolved per run from durable Setup
 * configuration. CopilotKit's hosted service is not used.
 */
export class Platform {
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly conversations: ConversationStore;
  readonly runner: FeltAgentRunner;
  readonly handler: CopilotHonoApp;

  private constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    readonly intelligence: IntelligenceService,
  ) {
    this.computers = new ComputerService(
      workspace,
      config,
      async () => (await store.settings()).paused,
    );
    this.conversations = new ConversationStore(workspace);
    this.runner = new FeltAgentRunner(this.conversations);
    this.pages = new PageService(workspace, () => this.conversations);
    const runtime = new CopilotRuntime({
      runner: this.runner,
      agents: async () =>
        Object.fromEntries(
          (await workspace.dots()).map((dot) => [dot.id, this.agent(dot.id)]),
        ),
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }

  static async create(
    store: Store,
    workspace: WorkspaceStore,
    config: PlatformConfig,
    intelligence: IntelligenceService,
  ) {
    return new Platform(store, workspace, config, intelligence);
  }

  private agent(dotId: string) {
    return new DotAgent(
      this.store,
      this.workspace,
      this.config,
      this.intelligence,
      dotId,
    );
  }

  async setup() {
    return setupStatus(this.config, await this.intelligence.status());
  }

  async requireReady() {
    const { missing } = await this.setup();
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }

  async stop() {}

  async createConversation(dotId: string, title: string) {
    await this.requireReady();
    if (!(await this.workspace.dot(dotId))) throw new Error('Dot not found.');
    return this.workspace.bindThread(randomUUID(), dotId, title);
  }

  async history(threadId: string): Promise<string> {
    await this.requireReady();
    return (await this.conversations.messages(threadId))
      .filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      )
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }

  async handle(request: Request): Promise<Response> {
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      await validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }

  /**
   * Run one server-initiated turn (scheduled task, voice compute) through the
   * same runner the chat uses, so it is persisted identically.
   */
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    await this.requireReady();
    signal.throwIfAborted();
    const thread = await this.workspace.requireThread(threadId);
    const history = await this.conversations.messages(threadId);
    const user = {
      id: `${metadata?.opendotsSource === 'voice_receipt' ? voiceReceiptMessagePrefix : ''}${randomUUID()}`,
      role: 'user',
      content: prompt,
      ...(metadata ? { metadata } : {}),
    } as Message;
    const agent = this.agent(thread.dotId);
    agent.threadId = threadId;
    agent.setMessages([...history, user]);
    const input: RunAgentInput = {
      threadId,
      runId: randomUUID(),
      messages: [...history, user],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    let runError: Error | undefined;
    const stop = () => void this.runner.stop({ threadId });
    signal.addEventListener('abort', stop, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        this.runner.run({ threadId, agent, input }).subscribe({
          next: (event: BaseEvent) => {
            if (event.type === EventType.RUN_ERROR)
              runError = new Error(
                (event as BaseEvent & { message: string }).message,
              );
          },
          error: reject,
          complete: resolve,
        });
      });
      signal.throwIfAborted();
      return currentTurnText(
        agent.messages.slice(history.length + 1),
        runError,
      );
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
}
