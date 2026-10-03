/**
 * Read-only inspection of the legacy SQLite database.
 *
 * Diagnostic only: this prints what is actually in the file so the importer can
 * be written against real data rather than assumptions. It never writes.
 */
import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2] ?? 'data/opendots.sqlite';
const db = new DatabaseSync(path, { readOnly: true });

const tables = [
  'page_threads',
  'task_threads',
  'calls',
  'captures',
  'computer_permissions',
  'computer_audit',
  'pages',
  'page_reviews',
  'spaces',
  'dots',
  'dot_spaces',
  'thread_bindings',
  'tasks',
  'runs',
  'events',
  'memories',
  'settings',
];

for (const table of tables) {
  let count: unknown;
  try {
    count = (
      db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }
    ).c;
  } catch (error) {
    count = `ERR ${(error as Error).message.slice(0, 50)}`;
  }
  console.log(table.padEnd(22), count);
}

for (const table of [
  'page_threads',
  'task_threads',
  'calls',
  'captures',
  'computer_permissions',
  'computer_audit',
]) {
  const sql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name='${table}'`)
    .get() as { sql?: string } | undefined;
  console.log(`\n--- ${table} schema ---`);
  console.log(sql?.sql ?? 'MISSING');
  console.log(`--- ${table} sample ---`);
  console.log(
    JSON.stringify(db.prepare(`SELECT * FROM ${table} LIMIT 3`).all()),
  );
}

console.log('\n--- distinct page_threads.ready ---');
console.log(
  JSON.stringify(
    db
      .prepare('SELECT ready, COUNT(*) c FROM page_threads GROUP BY ready')
      .all(),
  ),
);

console.log('\n--- page_threads with duplicate threadId ---');
console.log(
  JSON.stringify(
    db
      .prepare(
        `SELECT threadId, COUNT(*) c, GROUP_CONCAT(pageId) pages
         FROM page_threads GROUP BY threadId HAVING c > 1`,
      )
      .all(),
  ),
);

console.log('\n--- orphan references ---');
const orphans = {
  'task_threads → task_threads.threadId not in thread_bindings': db
    .prepare(
      `SELECT COUNT(*) c FROM task_threads t
        WHERE NOT EXISTS (SELECT 1 FROM thread_bindings b WHERE b.id = t.threadId)`,
    )
    .get(),
  'calls.threadId not in thread_bindings': db
    .prepare(
      `SELECT COUNT(*) c FROM calls c
        WHERE NOT EXISTS (SELECT 1 FROM thread_bindings b WHERE b.id = c.threadId)`,
    )
    .get(),
  'captures.threadId not in thread_bindings': db
    .prepare(
      `SELECT COUNT(*) c FROM captures k
        WHERE NOT EXISTS (SELECT 1 FROM thread_bindings b WHERE b.id = k.threadId)`,
    )
    .get(),
  'page_threads.pageId not in pages': db
    .prepare(
      `SELECT COUNT(*) c FROM page_threads p
        WHERE NOT EXISTS (SELECT 1 FROM pages g WHERE g.id = p.pageId)`,
    )
    .get(),
  'page_threads.dotId not in dots': db
    .prepare(
      `SELECT COUNT(*) c FROM page_threads p
        WHERE NOT EXISTS (SELECT 1 FROM dots d WHERE d.id = p.dotId)`,
    )
    .get(),
  'computer_permissions.dotId not in dots': db
    .prepare(
      `SELECT COUNT(*) c FROM computer_permissions cp
        WHERE NOT EXISTS (SELECT 1 FROM dots d WHERE d.id = cp.dotId)`,
    )
    .get(),
  'computer_audit.dotId not in dots': db
    .prepare(
      `SELECT COUNT(*) c FROM computer_audit ca
        WHERE NOT EXISTS (SELECT 1 FROM dots d WHERE d.id = ca.dotId)`,
    )
    .get(),
  'task_threads.taskId not in tasks': db
    .prepare(
      `SELECT COUNT(*) c FROM task_threads t
        WHERE NOT EXISTS (SELECT 1 FROM tasks k WHERE k.id = t.taskId)`,
    )
    .get(),
};
console.log(JSON.stringify(orphans, null, 1));

console.log(
  '\n--- JSON validity of captures.value / computer_permissions.value ---',
);
const checkJson = (table: string, column: string) => {
  const rows = db.prepare(`SELECT rowid, ${column} v FROM ${table}`).all() as {
    rowid: number;
    v: string;
  }[];
  const bad: unknown[] = [];
  for (const row of rows) {
    try {
      JSON.parse(row.v);
    } catch (error) {
      bad.push({
        rowid: row.rowid,
        error: (error as Error).message.slice(0, 40),
      });
    }
  }
  return { total: rows.length, malformed: bad };
};
console.log('captures.value', JSON.stringify(checkJson('captures', 'value')));
console.log(
  'computer_permissions.value',
  JSON.stringify(checkJson('computer_permissions', 'value')),
);
console.log(
  'computer_permissions sample',
  JSON.stringify(
    db.prepare('SELECT * FROM computer_permissions LIMIT 3').all(),
  ),
);

console.log('\n--- computer_audit per-dot totals (retention inputs) ---');
console.log(
  JSON.stringify(
    db
      .prepare(
        `SELECT dotId, COUNT(*) total,
                SUM(CASE WHEN outcome = 'pending' THEN 1 ELSE 0 END) pending,
                SUM(CASE WHEN outcome != 'pending' THEN 1 ELSE 0 END) finished
           FROM computer_audit GROUP BY dotId ORDER BY dotId`,
      )
      .all(),
  ),
);

console.log('\n--- calls columns present ---');
console.log(JSON.stringify(db.prepare('PRAGMA table_info(calls)').all()));
db.close();
