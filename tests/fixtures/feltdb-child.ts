/**
 * Child process for the raw @feltdb/core runtime probes (Phase 0).
 *
 * These deliberately bypass OpenDots' state module so they can observe what
 * the runtime itself does, including where it does not enforce the guarantees
 * its README describes.
 *
 * Modes:
 *   writer <statePath> <label>  — open the path, write a record, report ids
 *   crash  <statePath>          — write N records then SIGKILL mid-flight
 */
import { createFeltDB } from '@feltdb/core';

interface Row {
  id?: string | number;
  writer?: string;
  index?: number;
}

const [mode, path, label] = process.argv.slice(2);

async function runWriter() {
  const outcome: Record<string, unknown> = { label };
  try {
    const db = createFeltDB({ namespace: 'opendots-felt-probe', path });
    const rows = db.collection<Row>('pages');
    await rows.insert({ writer: label }, `written-by-${label}`);
    outcome.opened = true;
    outcome.ids = (await rows.all()).map((row) => String(row.id)).sort();
    db.close();
    outcome.closed = true;
  } catch (error) {
    outcome.opened = false;
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  process.stdout.write(JSON.stringify(outcome));
}

async function runCrash(count = 500) {
  const db = createFeltDB({ namespace: 'opendots-felt-probe', path });
  const rows = db.collection<Row>('pages');
  for (let index = 0; index < count; index++) {
    await rows.insert({ index }, `row-${index}`);
  }
  // Die abruptly: no close(), no flush, no orderly shutdown.
  process.kill(process.pid, 'SIGKILL');
}

if (mode === 'writer') void runWriter();
else if (mode === 'crash') void runCrash();
