/**
 * `npm run migrate:sqlite-to-felt` — the one-time SQLite → FeltDB importer.
 *
 * Explicit by design: nothing in the application startup path calls this. The
 * legacy database is opened read-only and is never written, marked, vacuumed or
 * altered, so it stays available as a backup after a successful cutover.
 *
 *   migrate:sqlite-to-felt            import, then verify
 *   migrate:sqlite-to-felt --dry-run  validate and report, write nothing
 *   migrate:sqlite-to-felt --source <path> --state <path>
 *
 * Phase 6 migrates historical SQLite data into FeltDB. SQLite is not restored
 * as a runtime persistence mechanism.
 */
import { openFeltState } from '../src/server/felt/state.js';
import { AUDIT_RETENTION } from '../src/server/computer-collections.js';
import { readLegacy } from './legacy-sqlite.js';
import { buildPlan, MIGRATED_COLLECTIONS } from './import-plan.js';
import { applyPlan, classifyPlan } from './apply-plan.js';
import { verifyMigration } from './verify.js';

interface Options {
  source: string;
  state: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    source: 'data/opendots.sqlite',
    state: 'data/opendots-state',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--source') options.source = argv[++i] ?? options.source;
    else if (arg === '--state') options.state = argv[++i] ?? options.state;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// The report iterates the planner's list rather than a local copy, so the
// documented collections and the imported collections cannot drift apart.
const REPORT_COLLECTIONS = MIGRATED_COLLECTIONS;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = readLegacy(options.source);
  const plan = buildPlan(snapshot, { auditRetention: AUDIT_RETENTION });

  // A dry run still opens the target: it has to, to report conflicts and
  // idempotency against the real state. It simply never writes.
  const state = openFeltState({ path: options.state });
  let conflicts: { collection: string; id: string }[] = [];
  let created = 0;
  let skipped = 0;
  try {
    const classified = await classifyPlan(state.db, plan);
    conflicts = classified.conflicts;
    const wouldCreate = classified.groups.reduce(
      (sum, group) => sum + group.create.length,
      0,
    );
    skipped = classified.groups.reduce((sum, group) => sum + group.skip, 0);

    if (options.dryRun) {
      created = 0;
      console.log('DRY RUN — no FeltDB records were written.');
      console.log(`${'records to create:'.padEnd(27)}${wouldCreate}`);
    } else if (conflicts.length === 0 && plan.problems.length === 0) {
      const outcome = await applyPlan(state.db, plan);
      created = outcome.created;
      skipped = outcome.skipped;
      conflicts = outcome.conflicts;
    } else {
      created = 0;
    }

    // Verification reads the finished state, so it only runs for a real
    // migration. A dry run has deliberately written nothing to verify.
    const failed =
      options.dryRun || conflicts.length
        ? []
        : (
            await verifyMigration(
              state.db,
              snapshot,
              new Set(plan.audit.trimmedIds),
            )
          ).checks.filter((entry) => !entry.ok);

    console.log('OpenDots SQLite → FeltDB migration');
    for (const collection of REPORT_COLLECTIONS)
      console.log(
        `${(collection + ':').padEnd(27)}${plan.counts[collection] ?? 0}`,
      );
    console.log(`${'JSON values parsed:'.padEnd(27)}${plan.jsonParsed}`);
    console.log(
      `${'ready values converted:'.padEnd(27)}${plan.readyConverted}`,
    );
    console.log(
      `${'boolean values converted:'.padEnd(27)}${plan.boolsConverted}`,
    );
    console.log(
      `${'audit records imported:'.padEnd(27)}${plan.audit.imported}`,
    );
    console.log(
      `${'audit records retained:'.padEnd(27)}${plan.audit.retained}`,
    );
    console.log(`${'audit records trimmed:'.padEnd(27)}${plan.audit.trimmed}`);
    console.log(`${'records created:'.padEnd(27)}${created}`);
    console.log(`${'records already present:'.padEnd(27)}${skipped}`);
    console.log(`${'conflicts:'.padEnd(27)}${conflicts.length}`);
    console.log(
      `${'errors:'.padEnd(27)}${plan.problems.length + failed.length}`,
    );

    for (const problem of plan.problems)
      console.error(
        `  ${problem.collection}[${problem.id}]: ${problem.message}`,
      );
    for (const conflict of conflicts)
      console.error(`  conflict ${conflict.collection}[${conflict.id}]`);
    for (const entry of failed)
      console.error(`  verification failed: ${entry.name} ${entry.detail}`);

    const complete =
      plan.problems.length === 0 &&
      conflicts.length === 0 &&
      failed.length === 0;
    console.log(`migration: ${complete ? 'COMPLETE' : 'INCOMPLETE'}`);

    if (!complete) process.exitCode = 1;
  } finally {
    state.close();
  }
}

await main();
