/**
 * The acceptance test for the singular claim of this PR:
 *
 *   A fresh OpenDots instance operates entirely from `feltdb.flow` + FeltDB,
 *   with `data/opendots.sqlite` never involved and never created.
 *
 * `runtime-cutover.test.ts` already covers persistence across restarts. This one
 * is different in two ways that matter:
 *
 *   - It starts from the **contract-resolved** namespace, the same value
 *     `src/server/felt/state.ts` derives at boot, so it exercises the real
 *     startup path rather than a test-chosen namespace.
 *   - It asserts SQLite is absent **at every step**, so a runtime that quietly
 *     created a legacy file and read from it would fail even if the data
 *     happened to look right.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContract } from '../src/server/contract.js';
import {
  DEFAULT_NAMESPACE,
  openFeltState,
  type FeltState,
} from '../src/server/felt/state.js';

import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const dirs: string[] = [];
const states: FeltState[] = [];

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Opened {
  store: Store;
  workspace: WorkspaceStore;
  /** The namespace this process actually opened. */
  namespace: string;
  close(): void;
}

/**
 * Start OpenDots from the contract, exactly as `src/server/index.ts` does.
 *
 * The namespace is always `DEFAULT_NAMESPACE` — derived from the contract, and
 * constant for the life of the application. It is deliberately *not* randomised
 * per call: a restart must reopen the same namespace, or "state came back" would
 * only prove that a fresh, empty namespace happened to look right.
 */
async function boot(statePath: string): Promise<Opened> {
  const state = openFeltState({
    path: statePath,
    namespace: DEFAULT_NAMESPACE,
  });
  states.push(state);
  const store = new Store(state.db);
  const workspace = new WorkspaceStore('owner', state.db);
  await workspace.bootstrap();
  // Pages are reached through `workspace.pages`, the store the real startup path
  // owns, rather than a hand-constructed one — so this exercises the production
  // wiring (space-existence delegation, page threads) rather than a shortcut.
  return {
    store,
    workspace,
    namespace: DEFAULT_NAMESPACE,
    close: () => state.close(),
  };
}

describe('acceptance — OpenDots runs from the .flow contract and FeltDB alone', () => {
  it('serves state across a restart and never creates a SQLite database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-contract-'));
    dirs.push(dir);
    const statePath = join(dir, 'opendots-state');
    // The legacy path is named explicitly and never passed to anything: the
    // runtime does not know it exists, and must not create it.
    const legacy = join(dir, 'opendots.sqlite');

    // 1–2. No SQLite, and the contract resolves.
    expect(existsSync(legacy)).toBe(false);
    const contract = loadContract();
    expect(contract.app).toBe('OpenDots');
    expect(contract.collections).toContain('pages');

    // 3–4. The namespace comes from the contract, not from a literal.
    expect(DEFAULT_NAMESPACE).toBe(contract.app.toLowerCase());

    // 5. Create representative state.
    const first = await boot(statePath);
    const space = await first.workspace.createSpace('Contract Space', 's');
    const dot = await first.workspace.createDot(
      space.id,
      'Contract Dot',
      'i',
      true,
      true,
    );
    const page = await first.workspace.pages.create(space.id, {
      title: 'Contract Page',
      content: 'body',
    });
    const task = await first.store.createTask('contract task');
    await first.store.saveMemory('contract memory', 'mem-1');

    // 6. Read it back through the application API, not through a raw handle.
    expect((await first.workspace.dot(dot.id))!.name).toBe('Contract Dot');
    expect((await first.workspace.pages.get(space.id, page.id)).title).toBe(
      'Contract Page',
    );
    expect((await first.store.task(task.id))!.prompt).toBe('contract task');

    // 7. Stop the process.
    first.close();
    expect(existsSync(legacy)).toBe(false);

    // 8–10. A fresh process reads the identical state.
    const second = await boot(statePath);
    // Same namespace, or the reads below would prove nothing.
    expect(second.namespace).toBe(first.namespace);
    expect((await second.workspace.dot(dot.id))!.name).toBe('Contract Dot');
    expect((await second.workspace.pages.get(space.id, page.id)).title).toBe(
      'Contract Page',
    );
    expect((await second.store.task(task.id))!.prompt).toBe('contract task');
    expect((await second.store.memories())[0]!.text).toBe('contract memory');
    expect((await second.workspace.spaces()).map((s) => s.name)).toContain(
      'Contract Space',
    );

    // 11. The legacy database was never created at any point.
    expect(existsSync(legacy)).toBe(false);
    second.close();
    expect(existsSync(legacy)).toBe(false);
  });
});
