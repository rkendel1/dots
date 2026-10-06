import { compactEvents, EventType, type BaseEvent } from '@ag-ui/client';
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from '@copilotkit/runtime/v2';
import { finalizeRunEvents } from '@copilotkit/shared';
import { ReplaySubject, type Observable } from 'rxjs';
import type { ConversationStore } from './conversation-store.js';

/** The one run currently executing on a thread in this process. */
interface LiveRun {
  runId: string;
  agent: AgentRunnerRunRequest['agent'];
  /** Every event of the run so far, for clients that connect mid-run. */
  subject: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
}

const isTerminal = (event: BaseEvent) =>
  event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;

/**
 * CopilotKit `AgentRunner` whose conversation history is durable in FeltDB.
 *
 * It lets the CopilotKit runtime run in SSE mode, without CopilotKit's hosted
 * Intelligence service, while OpenDots keeps ownership of conversation state.
 *
 * Process memory holds only runs that are executing right now — needed to stop
 * them and to let a late client attach. History is always read from FeltDB, so
 * a restart loses nothing that completed.
 */
export class FeltAgentRunner extends AgentRunner {
  private live = new Map<string, LiveRun>();

  constructor(private conversations: ConversationStore) {
    super();
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId } = request;
    if (this.live.has(threadId)) throw new Error('Thread already running');
    const runId = request.input.runId;
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const live: LiveRun = {
      runId,
      agent: request.agent,
      subject,
      stopRequested: false,
    };
    this.live.set(threadId, live);

    void (async () => {
      const events: BaseEvent[] = [];
      const held: BaseEvent[] = [];
      const emit = (event: BaseEvent) => subject.next(event);
      let interruption: string | undefined;
      try {
        if (!(await this.conversations.owns(threadId)))
          throw new Error('Conversation does not belong to this owner.');
        // Messages already stored in earlier runs are not repeated in this run's
        // RUN_STARTED input, so replay never duplicates them.
        const historic = new Set<string>();
        for (const run of await this.conversations.runs(threadId))
          for (const event of run.events) {
            if ('messageId' in event && typeof event.messageId === 'string')
              historic.add(event.messageId);
            if (event.type === EventType.RUN_STARTED)
              for (const message of (
                event as { input?: { messages?: { id: string }[] } }
              ).input?.messages ?? [])
                historic.add(message.id);
          }
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            let next = event;
            if (event.type === EventType.RUN_STARTED) {
              const started = event as BaseEvent & { input?: unknown };
              if (!started.input)
                next = {
                  ...started,
                  input: {
                    ...request.input,
                    messages: request.input.messages?.filter(
                      (message) => !historic.has(message.id),
                    ),
                  },
                } as BaseEvent;
            }
            events.push(next);
            if (isTerminal(next)) held.push(next);
            else emit(next);
          },
        });
      } catch (error) {
        interruption = error instanceof Error ? error.message : String(error);
      }

      const failed =
        interruption !== undefined ||
        live.stopRequested ||
        events.some((event) => event.type === EventType.RUN_ERROR);
      const closing = finalizeRunEvents(events, {
        stopRequested: live.stopRequested,
        ...(interruption !== undefined
          ? { interruptionMessage: interruption }
          : {}),
      });
      const terminal = [...held, ...closing];
      try {
        if (events.length || interruption === undefined)
          await this.conversations.appendRun({
            threadId,
            runId,
            agentId: request.agent.agentId ?? 'default',
            status: failed ? 'interrupted' : 'completed',
            events: compactEvents([...events, ...closing]),
            messages: failed ? undefined : [...request.agent.messages],
          });
        terminal.forEach(emit);
      } catch (error) {
        // Never report success for a run that is not durable.
        emit({
          type: EventType.RUN_ERROR,
          message: `This conversation could not be saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        } as BaseEvent);
      } finally {
        if (this.live.get(threadId) === live) this.live.delete(threadId);
        subject.complete();
      }
    })();

    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const out = new ReplaySubject<BaseEvent>(Infinity);
    void (async () => {
      try {
        // An unknown or foreign conversation replays as empty: nothing leaks and
        // nothing distinguishes "not yours" from "does not exist".
        if (!(await this.conversations.owns(request.threadId)))
          return out.complete();
        const history = compactEvents(
          (await this.conversations.runs(request.threadId)).flatMap(
            (run) => run.events,
          ),
        );
        const seen = new Set<string>();
        for (const event of history) {
          out.next(event);
          if ('messageId' in event && typeof event.messageId === 'string')
            seen.add(event.messageId);
        }
        const live = this.live.get(request.threadId);
        if (!live) return out.complete();
        live.subject.subscribe({
          next: (event) => {
            if (
              'messageId' in event &&
              typeof event.messageId === 'string' &&
              seen.has(event.messageId)
            )
              return;
            out.next(event);
          },
          complete: () => out.complete(),
          error: (error) => out.error(error),
        });
      } catch (error) {
        out.error(error);
      }
    })();
    return out.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.live.has(request.threadId));
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const live = this.live.get(request.threadId);
    if (!live || live.stopRequested) return Promise.resolve(false);
    if (request.runId !== undefined && request.runId !== live.runId)
      return Promise.resolve(false);
    live.stopRequested = true;
    try {
      live.agent.abortRun();
      return Promise.resolve(true);
    } catch {
      live.stopRequested = false;
      return Promise.resolve(false);
    }
  }
}
