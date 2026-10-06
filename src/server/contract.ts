/**
 * The authoritative FeltDB contract for OpenDots.
 *
 * `feltdb.flow` at the repository root is the architectural declaration of what
 * OpenDots *is*: its application identity and the durable collections it owns.
 * This module is the runtime's view of that declaration — it is what startup
 * consumes, so the contract is load-bearing rather than documentation.
 *
 * Two responsibilities, deliberately kept apart:
 *
 *   1. **Reading** the declarations this module needs (the app name and the
 *      collection names) so the runtime can refuse to use an undeclared
 *      collection.
 *   2. **Checking** that what the runtime and the migration planner use is
 *      declared, and reporting drift in terms a human can act on.
 *
 * It is **not** a FlowSpec validator. FeltDB owns that: `feltdb validate` parses
 * the real grammar, checks field types and `ref` targets, and reports
 * diagnostics. `flowspec` is not importable from `@feltdb/core` (it is absent
 * from the package's `exports`), so duplicating its parser here would create a
 * second, weaker contract language. The narrow reader below extracts
 * declarations by pattern and defers every semantic question to the CLI, which
 * CI runs on every change.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The contract file, by the name FeltDB's own tooling looks for. */
export const FLOW_FILENAME = 'feltdb.flow';

/**
 * Every durable collection the OpenDots runtime owns.
 *
 * This is the registry the contract is checked against. It is the *runtime's*
 * list — what the code actually opens — and the drift check proves it agrees
 * with both `feltdb.flow` and the migration planner.
 */
export const RUNTIME_COLLECTIONS = [
  'settings',
  'spaces',
  'dots',
  'dot_space_grants',
  'pages',
  'page_reviews',
  'thread_bindings',
  'page_threads',
  'page_thread_ids',
  'tasks',
  'task_threads',
  'runs',
  'executions',
  'attention',
  'decisions',
  'decision_applications',
  'decision_proposals',
  'task_events',
  'memories',
  'calls',
  'captures',
  'computer_permissions',
  'computer_audit',
  'compute_readiness',
  'configurations',
  'conversation_runs',
  'conversation_messages',
] as const;

export type RuntimeCollection = (typeof RUNTIME_COLLECTIONS)[number];

/** What this module needs out of a FlowSpec. */
export interface OpenDotsContract {
  /** The `flow_version` the file declares. */
  readonly version: number;
  /** The application identity, e.g. `OpenDots`. */
  readonly app: string;
  /** Declared collection names, in declaration order. */
  readonly collections: readonly string[];
  /** Absolute path the contract was read from. */
  readonly path: string;
}

/**
 * Locate `feltdb.flow` by walking up from this module.
 *
 * The server is compiled from `src/` into `dist/server/`, so the contract sits a
 * different number of directories above the module depending on whether it runs
 * from source or from a build. Walking up is what makes one lookup work in both,
 * and keeps resolution independent of the current working directory.
 */
export function findContractFile(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, FLOW_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
/**
 * Read the declarations this module needs out of a FlowSpec source.
 *
 * Deliberately pattern-level rather than a grammar implementation: it recognises
 * `flow_version <n>`, `app <name> {` and `collection <name> {`, and ignores
 * everything else. Anything it cannot make sense of is left to
 * `feltdb validate`, which is the real parser and the only thing that should
 * ever rule on FlowSpec syntax.
 */
export function readContractSource(
  source: string,
  path: string,
): OpenDotsContract {
  // FeltDB's own formatter emits `app <name> {` at column 0 and nests
  // declarations two spaces in, which is the shape these patterns match.
  const version = /^flow_version\s+(\d+)\s*$/m.exec(source);
  if (!version) throw new Error(`${path}: missing "flow_version" declaration.`);
  const app = /^app\s+([A-Za-z_][A-Za-z0-9_-]*)\s*\{/m.exec(source);
  if (!app) throw new Error(`${path}: missing "app <name> {" declaration.`);
  const collections = [
    ...source.matchAll(/^\s{2}collection\s+([A-Za-z_][A-Za-z0-9_-]*)\s*\{/gm),
  ].map((match) => match[1]!);
  return {
    version: Number(version[1]),
    app: app[1]!,
    collections,
    path,
  };
}

let cached: OpenDotsContract | null = null;

/**
 * Load the contract, once per process.
 *
 * Throws when it is missing. A deployment that cannot produce its contract has
 * not declared what it is, and starting anyway would mean silently inventing the
 * persistence model — the one thing this phase exists to prevent.
 */
export function loadContract(): OpenDotsContract {
  if (cached) return cached;
  const path = findContractFile();
  if (!path)
    throw new Error(
      `OpenDots cannot start: ${FLOW_FILENAME} was not found. The application ` +
        `contract is the authoritative declaration of OpenDots' durable state ` +
        `and must ship with it.`,
    );
  cached = readContractSource(readFileSync(path, 'utf8'), path);
  return cached;
}

/** Test seam: forget the cached contract so a mutated fixture is re-read. */
export function resetContractCache() {
  cached = null;
}

/**
 * Reject a durable collection the contract does not declare.
 *
 * Called at startup, not only in tests: an undeclared collection is exactly the
 * drift that would turn the contract into a stale document.
 *
 * The message names the collection and states both remedies, because "it is not
 * declared" alone leaves the reader to guess which of the two sides is wrong.
 */
export function assertCollectionsDeclared(
  collections: readonly string[],
): void {
  const contract = loadContract();
  const declared = new Set(contract.collections);
  const undeclared = [...collections].filter((name) => !declared.has(name));
  if (!undeclared.length) return;
  const plural = undeclared.length === 1 ? '' : 's';
  throw new Error(
    [
      'FeltDB contract drift:',
      ...undeclared.map(
        (name) =>
          `runtime collection "${name}" is not declared in ${FLOW_FILENAME}.`,
      ),
      `Add the collection${plural} to ${FLOW_FILENAME} or remove ${plural ? 'them' : 'it'} ` +
        `from RUNTIME_COLLECTIONS in src/server/contract.ts.`,
    ].join('\n'),
  );
}
