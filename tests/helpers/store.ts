import { randomUUID } from 'node:crypto';
import { openFeltState, type FeltState } from '../../src/server/felt/state.js';
import { Store } from '../../src/server/store.js';

export interface OpenStore {
  store: Store;
  state: FeltState;
  /** Close the durable state and release the process lock. Idempotent. */
  close(): void;
}

function handle(state: FeltState): OpenStore {
  const store = new Store(state.db);
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

/**
 * Build a Store over an in-memory durable state.
 *
 * Each call takes a unique namespace: two in-memory runtimes opened with the
 * same namespace share one store, so a fixed namespace would leak tasks,
 * settings and memories between tests in the same file.
 */
export function memoryStore(): OpenStore {
  return handle(
    openFeltState({
      memory: true,
      namespace: `opendots-store-${randomUUID()}`,
    }),
  );
}

/**
 * Build a Store over a durable file-backed state.
 *
 * Both handles matter for restart tests: `state.close()` closes the runtime and
 * releases the process lock, which must happen before the same path is reopened.
 * `close()` is idempotent so cleanup can rely on it too.
 */
export function fileStore(statePath: string): OpenStore {
  return handle(openFeltState({ path: statePath }));
}

export { openFeltState, Store };
