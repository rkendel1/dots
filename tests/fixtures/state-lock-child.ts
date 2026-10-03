/**
 * Child process for the OpenDots state-lock probes (Phase 1).
 *
 * Goes through OpenDots' own state module, so it exercises the lock the
 * application enforces rather than the raw runtime.
 *
 * Modes:
 *   hold <statePath> <holdMs>  — open the state, announce it, hold, then close
 *   try  <statePath>           — attempt to open, report whether it was refused
 */
import {
  openFeltState,
  StateLockedError,
} from '../../src/server/felt/state.js';

const [mode, path, holdMs] = process.argv.slice(2);

async function run() {
  const outcome: Record<string, unknown> = { mode };
  try {
    const state = openFeltState({ path, namespace: 'opendots-lock-probe' });
    outcome.opened = true;
    outcome.pid = process.pid;
    // Announce the pid immediately so a parent can act while the lock is held,
    // rather than waiting for this process to finish.
    process.stdout.write(`{"pid":${process.pid},"ready":true}`);
    if (mode === 'hold') {
      await new Promise((resolve) => setTimeout(resolve, Number(holdMs ?? 0)));
    }
    state.close();
    outcome.closed = true;
    process.stdout.write(`\n${JSON.stringify(outcome)}`);
  } catch (error) {
    outcome.opened = false;
    outcome.refused =
      error instanceof StateLockedError ? 'StateLockedError' : 'other';
    outcome.message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`\n${JSON.stringify(outcome)}`);
  }
}

void run();
