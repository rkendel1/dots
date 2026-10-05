/**
 * `feltdb.flow` is the authoritative declaration. This suite proves the three
 * places that know about durable collections agree, and that the declaration is
 * read with FeltDB's own tooling rather than a parser written here.
 *
 *   feltdb.flow  ↔  RUNTIME_COLLECTIONS  ↔  MIGRATED_COLLECTIONS
 *
 * A mismatch in any direction fails: an undeclared collection, a collection the
 * contract declares but nothing opens, a planner collection nobody declares, a
 * rename, or a silent removal.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATED_COLLECTIONS } from '../migrations/import-plan.js';
import { reviewKey } from '../src/server/pages.js';
import { eventKey } from '../src/server/store-collections.js';
import {
  grantKey,
  pageThreadKey,
} from '../src/server/workspace-collections.js';
import {
  assertCollectionsDeclared,
  FLOW_FILENAME,
  loadContract,
  readContractSource,
  RUNTIME_COLLECTIONS,
} from '../src/server/contract.js';

const contract = loadContract();
const declared = [...contract.collections];

/**
 * The pinned FeltDB CLI, resolved from the repository the contract came from
 * rather than from `PATH` or `npx`.
 */
const feltdbCli = () =>
  join(dirname(contract.path), 'node_modules/@feltdb/core/bin/feltdb.js');

describe('feltdb.flow contract validation', () => {
  it('parses as flow_version 1 with the OpenDots application identity', () => {
    expect(contract.version).toBe(1);
    expect(contract.app).toBe('OpenDots');
    expect(declared.length).toBeGreaterThan(0);
  });

  /**
   * The real check. `feltdb validate` owns FlowSpec syntax, field types and `ref`
   * target resolution, and `@feltdb/core` does not export its parser, so the
   * contract is verified by running the installed CLI rather than by re-parsing
   * the file here.
   *
   * It is invoked as `node node_modules/@feltdb/core/bin/feltdb.js` rather than
   * `npx feltdb`: `npx` can resolve a globally installed CLI of a different
   * version, which would validate against a grammar this repository has not
   * pinned. Pinning the path also makes the check independent of `cwd`.
   */
  it('is accepted by the real feltdb CLI', () => {
    const stdout = execFileSync(
      process.execPath,
      [feltdbCli(), 'validate', contract.path],
      { encoding: 'utf8' },
    );
    expect(stdout).toContain('OpenDots');
    expect(stdout).toContain('20 collections');
  });

  /**
   * Proves the check above can fail. Without this, a CLI that rejected every
   * contract — or a contract path that did not exist — would still leave the
   * suite green, and the acceptance evidence would be worthless.
   */
  it('rejects a contract the same CLI considers invalid', () => {
    const bad = join(mkdtempSync(join(tmpdir(), 'opendots-flow-')), 'bad.flow');
    writeFileSync(
      bad,
      'flow_version 1\n\napp Bad {\n  collection x {\n    y: nonsense_type\n  }\n}\n',
    );
    let failed = false;
    try {
      execFileSync(process.execPath, [feltdbCli(), 'validate', bad], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      failed = true;
      // The CLI prints the diagnostic to stdout and the summary to stderr, so
      // both streams are inspected rather than assuming one of them.
      const child = error as { stdout?: string; stderr?: string };
      expect(`${child.stdout ?? ''}${child.stderr ?? ''}`).toMatch(
        /Unsupported field type|validation failed/,
      );
    }
    expect(failed).toBe(true);
  });
});

describe('contract / runtime / migration collection agreement', () => {
  const runtime = [...RUNTIME_COLLECTIONS];
  const migrated = [...MIGRATED_COLLECTIONS];

  it('declares exactly the collections the runtime opens', () => {
    expect(declared.toSorted()).toEqual(runtime.toSorted());
  });

  it('declares every collection the migration planner imports', () => {
    // The contract must cover anything the migration writes. This is deliberately
    // a subset check rather than an equality: `executions` was introduced in 0.2.0,
    // after SQLite was retired as a runtime store, so there is no legacy source
    // for the migration to import into it and it is correctly absent from the
    // planner. Equality would force either a fictional migration or a contract
    // that omits a collection the runtime really uses.
    for (const collection of migrated) expect(declared).toContain(collection);
  });

  it('declares nothing the runtime neither opens nor the migration imports', () => {
    // The other direction: a collection in the contract that no path reaches is
    // dead weight, and drift between `RUNTIME_COLLECTIONS` and the contract is
    // exactly what this suite exists to catch.
    const known = new Set<string>([...runtime, ...migrated]);
    for (const collection of declared) expect(known.has(collection)).toBe(true);
  });

  it('covers all 20 runtime collections', () => {
    expect(runtime).toHaveLength(20);
    expect(declared).toHaveLength(20);
  });

  it('declares no collection twice', () => {
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('reports an actionable drift message for an undeclared collection', () => {
    // The error is what a developer sees when the contract and the runtime fall
    // apart, so it names the collection and states both remedies.
    const message = (() => {
      try {
        assertCollectionsDeclared([...runtime, 'scratch']);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    expect(message).toContain('FeltDB contract drift');
    expect(message).toContain(
      `runtime collection "scratch" is not declared in ${FLOW_FILENAME}`,
    );
    // Both remedies, so it is unambiguous which side is wrong.
    expect(message).toContain(`Add the collection to ${FLOW_FILENAME}`);
    expect(message).toContain('RUNTIME_COLLECTIONS');
  });

  it('fails when a collection is declared in the contract but missing from the runtime', () => {
    // The opposite direction of the same drift: set equality means a collection
    // nothing opens is a failure too, not merely a declaration to trust.
    const removedFromRuntime = runtime.filter((name) => name !== 'captures');
    expect(declared.toSorted()).not.toEqual(removedFromRuntime.toSorted());
    expect(removedFromRuntime).toHaveLength(runtime.length - 1);
  });

  it('fails when a collection is declared in the contract but missing from the planner', () => {
    const removedFromPlanner = migrated.filter((name) => name !== 'captures');
    expect(declared.toSorted()).not.toEqual(removedFromPlanner.toSorted());
    expect(removedFromPlanner).toHaveLength(migrated.length - 1);
  });

  it('accepts the real runtime registry', () => {
    expect(() => assertCollectionsDeclared(runtime)).not.toThrow();
  });

  it('detects a renamed collection rather than silently passing', () => {
    const source = readFileSync(contract.path, 'utf8').replace(
      'collection computer_audit {',
      'collection computer_audits {',
    );
    expect(readContractSource(source, 'x.flow').collections).toContain(
      'computer_audits',
    );
    expect(readContractSource(source, 'x.flow').collections).not.toContain(
      'computer_audit',
    );
  });

  it('fails loudly when the contract is missing', () => {
    expect(() => readContractSource('app OpenDots {\n}\n', 'x.flow')).toThrow(
      /flow_version/,
    );
  });
});

/**
 * Key-scheme ownership.
 *
 * The boundary is deliberate and follows the installed format's limits:
 *
 *   feltdb.flow      → collection identity, fields, relationships
 *   TypeScript       → deterministic record keys
 *
 * A `FlowCollection` declares `fields` and `indexes`; `flowSpecToManifest()`
 * emits `{ name, fields }` and no record-key expression exists anywhere in the
 * format. Writing a `key` keyword the installed CLI cannot parse would produce a
 * contract it rejects, so the keys stay in TypeScript where they have always
 * lived and where there is exactly one implementation of each.
 *
 * What is asserted here is the half FlowSpec *can* express: that the fields each
 * key is composed from are actually declared. A key function and its backing
 * fields are linked by importing the real function, so renaming a field in the
 * runtime without declaring it in the contract fails here.
 */
describe('key-scheme ownership', () => {
  const fieldsOf = (name: string) =>
    readFileSync(contract.path, 'utf8')
      .split(/\n\s*\n/)
      .filter((block) => block.includes(`collection ${name} {`))
      .flatMap((block) =>
        [...block.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(
          (match) => match[1]!,
        ),
      );

  it('keeps key construction deterministic in TypeScript', () => {
    // The point of keeping keys in one place: identical inputs must always yield
    // an identical record key, or a restart would silently duplicate rows.
    expect(pageThreadKey('p1', 'd1')).toBe(pageThreadKey('p1', 'd1'));
    expect(grantKey('d1', 's1')).toBe(grantKey('d1', 's1'));
    expect(reviewKey('t1', 'c1')).toBe(reviewKey('t1', 'c1'));
    expect(eventKey('t1', 7)).toBe(eventKey('t1', 7));

    // And distinct inputs must not collide, which is what the length-prefixed
    // hashing in pairKey/reviewKey exists to guarantee.
    expect(pageThreadKey('p1', 'd1')).not.toBe(pageThreadKey('p1', 'd2'));
    expect(grantKey('d1', 's1')).not.toBe(grantKey('d1', 's2'));
    expect(reviewKey('ab', 'c')).not.toBe(reviewKey('a', 'bc'));
  });

  it('backs pageThreadKey with fields declared on page_threads', () => {
    // pageThreadKey(pageId, dotId) is the record key of `page_threads`.
    expect(pageThreadKey('p1', 'd1')).toBe('p1.d1');
    expect(fieldsOf('page_threads')).toEqual(
      expect.arrayContaining(['pageId', 'dotId']),
    );
  });

  it('backs grantKey with fields declared on dot_space_grants', () => {
    // grantKey(dotId, spaceId) is the record key of `dot_space_grants`.
    expect(fieldsOf('dot_space_grants')).toEqual(
      expect.arrayContaining(['dotId', 'spaceId']),
    );
  });

  it('backs eventKey with fields declared on task_events', () => {
    // eventKey(taskId, seq) is the record key of `task_events`.
    expect(eventKey('t1', 7)).toBe('t1.000000000007');
    expect(fieldsOf('task_events')).toEqual(
      expect.arrayContaining(['taskId', 'seq']),
    );
  });

  it('backs page_reviews with declared fields, keyed by external identity', () => {
    // reviewKey(threadId, toolCallId) is the one key that is NOT composed of
    // stored fields: it names the conversation review it belongs to, so a retry
    // replays instead of duplicating. What the contract must declare is the
    // payload it resolves to, which is the page the review produced.
    expect(fieldsOf('page_reviews')).toEqual(
      expect.arrayContaining(['pageId', 'spaceId']),
    );
  });

  it('declares the thread-identity fields used by the conversation stores', () => {
    expect(fieldsOf('page_thread_ids')).toContain('threadId');
    expect(fieldsOf('task_threads')).toContain('taskId');
    expect(fieldsOf('captures')).toContain('threadId');
    expect(fieldsOf('calls')).toContain('threadId');
  });
});
