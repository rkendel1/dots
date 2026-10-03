import { randomUUID } from 'node:crypto';
import { PageError } from './pages.js';
import type { WorkspaceStore } from './workspace.js';
export interface PageIntelligence {
  getOrCreateThread(input: {
    threadId: string;
    userId: string;
    agentId: string;
    name: string;
  }): Promise<unknown>;
  getThreadMessages(input: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: { role: string; content?: unknown }[] }>;
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Intelligence request timed out. Retry to recover the same conversation.',
              ),
            ),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export class PageService {
  private pending = new Map<
    string,
    Promise<Awaited<ReturnType<WorkspaceStore['requireThread']>>>
  >();
  constructor(
    private workspace: WorkspaceStore,
    private intelligence: () => PageIntelligence,
  ) {}
  async conversation(spaceId: string, pageId: string, dotId: string) {
    const page = await this.workspace.pages.get(spaceId, pageId);
    const dot = await this.workspace.dot(dotId);
    if (!dot || !(await this.workspace.canAccessSpace(dotId, spaceId)))
      throw new PageError(
        'Choose a specialist in this Space with access enabled.',
        400,
      );
    const key = `${pageId}:${dotId}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const current = await this.workspace.pages.thread(pageId, dotId);
    if (current?.ready)
      return this.workspace.requireThread(current.threadId, dotId);
    // Reading the reservation is now asynchronous, so a second request can slip
    // past the check above while this one waits. Re-check before claiming the
    // lease, or the two would race and one would see a spurious 409.
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const sdk = this.intelligence();
    const task = (async () => {
      const candidateId = randomUUID();
      if (
        !(await this.workspace.pages.reserveThread(pageId, dotId, candidateId))
      )
        throw new PageError(
          'This page conversation is being created. Retry shortly.',
          409,
        );
      const threadId = (await this.workspace.pages.thread(pageId, dotId))!
        .threadId;
      try {
        await bounded(
          sdk.getOrCreateThread({
            threadId,
            userId: this.workspace.ownerId,
            agentId: dotId,
            name: page.title,
          }),
        );
        if (!(await this.workspace.canAccessSpace(dotId, spaceId)))
          throw new PageError('Space access has been revoked.');
        const thread =
          (await this.workspace.conversations()).find(
            (t) => t.id === threadId,
          ) ?? (await this.workspace.bindThread(threadId, dotId, page.title));
        await this.workspace.pages.finishThread(pageId, dotId);
        return thread;
      } catch (error) {
        await this.workspace.pages.releaseThread(pageId, dotId);
        throw error;
      }
    })();
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  async saveConversation(
    threadId: string,
    title: string,
    parentId: string | null,
  ) {
    const thread = await this.workspace.requireThread(threadId);
    const dot = await this.workspace.dot(thread.dotId);
    if (!dot) throw new PageError('Dot not found.', 404);
    const history = await bounded(
      this.intelligence().getThreadMessages({
        threadId,
        userId: this.workspace.ownerId,
      }),
    );
    const chunks: string[] = [];
    for (const message of history.messages) {
      if (!['user', 'assistant'].includes(message.role)) continue;
      let text = '';
      if (typeof message.content === 'string') text = message.content;
      else if (Array.isArray(message.content)) {
        text = message.content
          .flatMap((part) =>
            part &&
            typeof part === 'object' &&
            'text' in part &&
            typeof part.text === 'string'
              ? [part.text]
              : [],
          )
          .join('\n');
      }
      if (text.trim())
        chunks.push(`## ${message.role === 'user' ? 'You' : 'Dot'}\n\n${text}`);
    }
    const content = chunks.join('\n\n');
    if (!content)
      throw new PageError('This conversation has no persisted text to save.');
    if (content.length > 100000)
      throw new PageError(
        'This conversation exceeds the 100,000 character page limit. Save a shorter conversation.',
      );
    const destination =
      (await this.workspace.pages.forThread(threadId))?.spaceId ?? dot.spaceId;
    if (!(await this.workspace.canAccessSpace(dot.id, destination)))
      throw new PageError('Space access has been revoked.', 400);
    return this.workspace.pages.create(
      destination,
      { title, content, parentId },
      threadId,
    );
  }
}
