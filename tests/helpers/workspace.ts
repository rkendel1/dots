import { randomUUID } from 'node:crypto';
import { openFeltState, type FeltState } from '../../src/server/felt/state.js';
import { WorkspaceStore } from '../../src/server/workspace.js';

/**
 * Build a WorkspaceStore over an in-memory durable state.
 *
 * The state is in-memory so each test is isolated; tests that exercise restart
 * behaviour open a file-backed state instead.
 *
 * Returns a promise because the first-run defaults are created through the
 * durable state, which is async. Every caller must await this.
 *
 * Each call takes a unique namespace: two in-memory runtimes opened with the
 * same namespace share one store, so a fixed namespace would leak Spaces, Dots
 * and thread bindings between tests in the same file.
 */
export async function memoryWorkspace(
  ownerId = 'owner',
): Promise<{ store: WorkspaceStore; state: FeltState }> {
  const state = openFeltState({
    memory: true,
    namespace: `opendots-test-${randomUUID()}`,
  });
  const store = new WorkspaceStore(ownerId, state.db);
  await store.bootstrap();
  return { store, state };
}

export interface FileWorkspace {
  store: WorkspaceStore;
  state: FeltState;
  /** Close the durable runtime and release the process lock. Idempotent. */
  close(): void;
}

/**
 * Build a WorkspaceStore over a durable file-backed state.
 *
 * Returns both handles because each has its own lifecycle: `state.close()`
 * closes the FeltDB runtime and releases the process lock. A restart test must
 * close the state before reopening the same path, which is what `close()` does;
 * it is idempotent so a test can also rely on it during cleanup.
 */
export function fileWorkspace(
  statePath: string,
  ownerId = 'owner',
): FileWorkspace {
  const state = openFeltState({ path: statePath });
  const store = new WorkspaceStore(ownerId, state.db);
  let closed = false;
  return {
    store,
    state,
    close() {
      if (closed) return;
      closed = true;
      state.close();
    },
  };
}

export { WorkspaceStore, openFeltState };
