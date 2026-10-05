import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 7 architecture guards.
 *
 * The runtime is SQLite-free today because Phases 3–5 removed it. Nothing in the
 * type system prevents that from regressing: a single `import { DatabaseSync }
 * from 'node:sqlite'` in `src/server` would compile, lint and test cleanly. These
 * tests are the enforcement point, and they read the source tree directly rather
 * than trusting an import graph a build step produced.
 *
 * The scope is deliberate. Migration tooling under `migrations/` *is* allowed to
 * open SQLite — that is the whole point of a migration — so the guard is scoped to
 * `src/server`, and the boundary itself is asserted separately below.
 */

const ROOT = join(import.meta.dirname, '..');
const RUNTIME_ROOT = join(ROOT, 'src', 'server');
const MIGRATION_ROOT = join(ROOT, 'migrations');

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * Strip comments and string/template literals, leaving executable code only.
 *
 * Without this the guard would fire on documentation that merely *names*
 * SQLite — which several modules do when explaining what they replaced.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const runtimeFiles = sourceFiles(RUNTIME_ROOT);

describe('runtime state authority is FeltDB, never SQLite', () => {
  it('has runtime source files to inspect', () => {
    // A guard that silently scans nothing would pass forever.
    expect(runtimeFiles.length).toBeGreaterThan(10);
  });

  const FORBIDDEN: [string, RegExp][] = [
    ['node:sqlite import', /node:sqlite/],
    ['DatabaseSync', /\bDatabaseSync\b/],
    ['DATABASE_PATH', /\bDATABASE_PATH\b/],
    ['CREATE TABLE statement', /\bCREATE\s+TABLE\b/i],
    ['SELECT statement', /\bSELECT\b[\s\S]{0,80}?\bFROM\b/i],
    ['INSERT statement', /\bINSERT\s+INTO\b/i],
    ['UPDATE statement', /\bUPDATE\b[\s\S]{0,80}?\bSET\b/i],
    ['DELETE statement', /\bDELETE\s+FROM\b/i],
    ['PRAGMA', /\bPRAGMA\b/i],
  ];

  for (const [label, pattern] of FORBIDDEN)
    it(`has no ${label} anywhere in src/server`, () => {
      const offenders = runtimeFiles
        .filter((file) => pattern.test(code(readFileSync(file, 'utf8'))))
        .map((file) => file.slice(ROOT.length + 1));
      expect(offenders).toEqual([]);
    });

  it('never even mentions sqlite in runtime code', () => {
    // Stricter than the list above: a runtime module should have no reason to
    // name SQLite at all, not even in a variable or a log line.
    const offenders = runtimeFiles
      .filter((file) => /sqlite/i.test(code(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('constructs the durable state in exactly one place', () => {
    const sites = runtimeFiles
      .filter((file) =>
        /\bcreateFeltDB\b/.test(code(readFileSync(file, 'utf8'))),
      )
      .map((file) => file.slice(ROOT.length + 1));
    expect(sites).toEqual(['src/server/felt/state.ts']);
  });

  it('opens the durable state in exactly one place', () => {
    // `openFeltState` is the only supported entry point. A second caller would
    // risk a second process-local state owner competing for the lock. The module
    // that *declares* the function is excluded — it necessarily contains the name.
    const sites = runtimeFiles
      .filter((file) => !file.endsWith(join('felt', 'state.ts')))
      .filter((file) =>
        /\bopenFeltState\s*\(/.test(code(readFileSync(file, 'utf8'))),
      )
      .map((file) => file.slice(ROOT.length + 1));
    expect(sites).toEqual(['src/server/index.ts']);
  });
});

/**
 * The runtime collection matrix (PR §6), derived rather than asserted by hand.
 *
 * The authoritative list of collections is what the runtime actually opens, found
 * by scanning `db.collection(...)` call sites. Each name must resolve to a
 * collection that both reads and writes, which is re-proved in
 * `runtime-cutover.test.ts` against a live state. Pinning the list here means a
 * new collection cannot be added without also being given a migration story.
 */
const EXPECTED = [
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
  'task_events',
  'memories',
  'calls',
  'captures',
  'computer_permissions',
  'computer_audit',
  'executions',
  'attention',
  'decisions',
  'decision_applications',
  'decision_proposals',
  'configurations',
];

/**
 * Collections the runtime opens that have no legacy SQLite source.
 *
 * `executions` arrived in 0.2.0 and `attention` alongside it, both long after
 * SQLite was retired as a runtime store, so the Phase 6 migration has nothing to
 * import into either. `decisions`, `decision_applications`, `decision_proposals`,
 * and `configurations` came after SQLite and have no legacy source. They are
 * listed here explicitly rather than folded into the planner, so adding another
 * post-SQLite collection is a deliberate edit to this file rather than an accident.
 */
const NOT_MIGRATED = new Set([
  'executions',
  'attention',
  'decisions',
  'decision_applications',
  'decision_proposals',
  'configurations',
]);

describe('every runtime collection is FeltDB-backed', () => {
  const opened = new Set<string>();
  for (const file of runtimeFiles) {
    // Comments are stripped but string literals are *kept*: a collection name is
    // a string literal, so removing strings here would erase every name.
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const match of source.matchAll(
      /\bcollection(?:<[^>]*>)?\('([a-z_]+)'\)/g,
    ))
      opened.add(match[1]!);
  }

  it('opens exactly the twenty-four expected collections', () => {
    expect([...opened].sort()).toEqual([...EXPECTED].sort());
    expect(EXPECTED).toHaveLength(24);
  });

  it('imports every migrated collection, and the runtime opens each one', async () => {
    // Every collection the Phase 6 migration imports must have a runtime read and
    // write path, or it would be dead weight the migration creates. Imported from
    // the *planner*, which is pure — importing the CLI entry point would execute
    // the migration as a side effect.
    const { MIGRATED_COLLECTIONS } =
      await import('../migrations/import-plan.js');
    for (const collection of MIGRATED_COLLECTIONS)
      expect(opened.has(collection)).toBe(true);
  });

  it('leaves out exactly the collections that never existed in SQLite', async () => {
    // The two lists are no longer equal by design: a collection introduced after
    // SQLite was retired has no legacy source to migrate from. Anything else that
    // falls outside the planner is a real gap — a runtime collection the migration
    // silently forgets.
    const { MIGRATED_COLLECTIONS } =
      await import('../migrations/import-plan.js');
    const unmigrated = [...opened].filter(
      (collection) => !MIGRATED_COLLECTIONS.includes(collection as never),
    );
    expect(new Set(unmigrated)).toEqual(NOT_MIGRATED);
  });
});

describe('migration tooling is isolated from the runtime', () => {
  it('is not importable from runtime source', () => {
    const offenders = runtimeFiles
      .filter((file) =>
        /from\s+['"].*migrations\//.test(readFileSync(file, 'utf8')),
      )
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('lives outside the runtime build source root', () => {
    const server = readFileSync(join(ROOT, 'tsconfig.server.json'), 'utf8');
    // The server build must not be able to reach `migrations/`; if `include`
    // ever grew to cover it, SQLite would enter the runtime bundle.
    expect(server).not.toMatch(/migrations/);
  });

  it('is reachable only through explicit npm scripts', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    const scripts = Object.entries(pkg.scripts);
    const migration = scripts.filter(([, command]) =>
      command.includes('migrations/'),
    );
    // Every one must be an explicit administrative command, never a lifecycle
    // hook the application would run by itself.
    expect(migration.length).toBeGreaterThan(0);
    for (const [name] of migration)
      expect([
        'dev',
        'start',
        'build',
        'test',
        'browser',
        'browser:start',
      ]).not.toContain(name);
    for (const lifecycle of ['dev', 'start', 'build'])
      expect(pkg.scripts[lifecycle]).not.toMatch(/migrat/);
  });

  it('still contains the one module that may read SQLite', () => {
    // Pinning the location makes the boundary legible: if this ever moves, a
    // reviewer sees it in the diff rather than discovering it via `rg`.
    const readers = sourceFiles(MIGRATION_ROOT)
      .filter((file) => /node:sqlite/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(ROOT.length + 1))
      .sort();
    expect(readers).toEqual([
      'migrations/inspect-legacy.ts',
      'migrations/legacy-sqlite.ts',
    ]);
  });
});
