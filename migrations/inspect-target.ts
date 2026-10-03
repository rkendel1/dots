/** Read-only listing of the live FeltDB collections, for the cutover check. */
import { openFeltState } from '../src/server/felt/state.js';

const path = process.argv[2] ?? 'data/opendots-state';
const state = openFeltState({ path });
try {
  for (const name of [
    'spaces',
    'dots',
    'dot_space_grants',
    'thread_bindings',
    'pages',
    'page_reviews',
    'settings',
    'tasks',
    'runs',
    'task_events',
    'memories',
    'page_threads',
    'page_thread_ids',
    'task_threads',
    'calls',
    'captures',
    'computer_permissions',
    'computer_audit',
  ]) {
    const rows = await state.db.collection(name).all();
    console.log(name.padEnd(22), rows.length);
  }
} finally {
  state.close();
}
