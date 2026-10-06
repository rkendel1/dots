import type { BaseEvent, Message } from '@ag-ui/core';
import type { Collection } from '@feltdb/core';
import { transactionId, type StorageFence } from './felt/records.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * Durable conversation history, owned by OpenDots and stored in FeltDB.
 *
 * A conversation is the existing `thread_bindings` row (id, Dot, owner, title).
 * This store adds what used to live in CopilotKit's hosted service:
 *
 * - `conversation_runs` — one row per completed or interrupted agent run, with
 *   its compacted AG-UI events. Replaying them restores the chat UI exactly.
 * - `conversation_messages` — the conversation's messages after the last
 *   *completed* run. An interrupted run never writes here, so a partial stream
 *   is never mistaken for a finished assistant message.
 *
 * Every read and write goes through `WorkspaceStore.requireThread`, so a
 * conversation id alone never reaches another owner's history.
 */

export type ConversationRunStatus = 'completed' | 'interrupted';

export interface ConversationRunRecord extends StorageFence {
  id: string;
  runId: string;
  threadId: string;
  ownerId: string;
  agentId: string;
  seq: number;
  status: ConversationRunStatus;
  events: BaseEvent[];
  createdAt: number;
}

export interface ConversationMessageRecord extends StorageFence {
  id: string;
  threadId: string;
  ownerId: string;
  messageId: string;
  position: number;
  role: string;
  message: Message;
  createdAt: number;
}

export interface AppendRunInput {
  threadId: string;
  runId: string;
  agentId: string;
  status: ConversationRunStatus;
  events: BaseEvent[];
  /** The full message list after a completed run; omitted for interrupted runs. */
  messages?: Message[];
}

const pad = (value: number) => String(value).padStart(8, '0');

export class ConversationStore {
  private runRows: Collection<ConversationRunRecord>;
  private messageRows: Collection<ConversationMessageRecord>;

  constructor(private workspace: WorkspaceStore) {
    this.runRows =
      workspace.state.collection<ConversationRunRecord>('conversation_runs');
    this.messageRows = workspace.state.collection<ConversationMessageRecord>(
      'conversation_messages',
    );
  }

  /** Whether this owner has a conversation with this id. Never throws. */
  async owns(threadId: string): Promise<boolean> {
    return (await this.workspace.conversations()).some(
      (thread) => thread.id === threadId,
    );
  }

  async runs(threadId: string): Promise<ConversationRunRecord[]> {
    await this.workspace.requireThread(threadId);
    return (await this.runRows.find({ threadId }))
      .filter((run) => run.ownerId === this.workspace.ownerId)
      .sort((a, b) => a.seq - b.seq);
  }

  async messages(threadId: string): Promise<Message[]> {
    await this.workspace.requireThread(threadId);
    return (await this.messageRows.find({ threadId }))
      .filter((row) => row.ownerId === this.workspace.ownerId)
      .sort((a, b) => a.position - b.position)
      .map((row) => row.message);
  }

  async appendRun(input: AppendRunInput): Promise<void> {
    await this.workspace.requireThread(input.threadId);
    const ownerId = this.workspace.ownerId;
    const seq = (await this.runs(input.threadId)).length;
    const createdAt = Date.now();
    // One transaction, so the run and the message history it produced become
    // durable together or not at all.
    const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    await this.workspace.state.transaction(
      (tx) => {
        tx.collection<ConversationRunRecord>('conversation_runs').insert(
          plain({
            id: `${input.threadId}.${pad(seq)}`,
            runId: input.runId,
            threadId: input.threadId,
            ownerId,
            agentId: input.agentId,
            seq,
            status: input.status,
            events: input.events,
            createdAt,
            __version: 1,
          }),
          `${input.threadId}.${pad(seq)}`,
        );
        input.messages?.forEach((message, position) => {
          const id = `${input.threadId}.${pad(position)}`;
          tx.collection<ConversationMessageRecord>('conversation_messages').set(
            id,
            plain({
              id,
              threadId: input.threadId,
              ownerId,
              messageId: message.id,
              position,
              role: message.role,
              message,
              createdAt,
              __version: 1,
            }),
          );
        });
      },
      { transactionId: transactionId('conversation-run') },
    );
  }

  /* PageService's conversation port. A conversation needs nothing beyond its
   * binding, which PageService creates itself, so there is nothing remote to make. */
  async getOrCreateThread(_input: { threadId: string }): Promise<void> {}

  async getThreadMessages(input: { threadId: string }) {
    return { messages: await this.messages(input.threadId) };
  }
}
