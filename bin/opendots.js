#!/usr/bin/env node
/**
 * The `opendots` CLI.
 *
 * Deliberately dependency-free and runtime-only: an installed user must be able to
 * run the normal lifecycle without a checkout, TypeScript toolchain, or any
 * repository script. Everything it does is against the shipped artifact —
 * `dist/server/server/index.js` for the app, and the contract the runtime itself
 * loads, so `status` reports what the product would actually use rather than what
 * a script in the source tree believes.
 *
 * SQLite is deliberately absent here. There is no `migrate` command and no
 * database path to pass: the legacy database is a migration source, not a runtime
 * input.
 *
 *   opendots start [--port N] [--host H]
 *   opendots status
 *   opendots stop
 *   opendots validate
 *   opendots --help
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(packageRoot, 'dist/server/server/index.js');
const legacyDatabase = join(packageRoot, 'data/opendots.sqlite');

const USAGE = `OpenDots on FeltDB — development control plane with durable state

Usage:
  opendots start [--port <n>] [--host <h>]   Start the server and UI
  opendots status                             Report state location and contract
  opendots stop                               Stop a running server
  opendots validate                           Validate the shipped feltdb.flow
  opendots --help                             Show this message

Configuration (environment):
  FELTDB_PATH        Durable state directory (default: data/opendots-state)
  FELTDB_NAMESPACE   Collection namespace (default: the app identity in feltdb.flow)
  PORT / HOST        Listen address (default: 4310 / 0.0.0.0)
  OWNER_TOKEN        Required (24+ characters) when using external bindings

OpenDots keeps durable application state in FeltDB. SQLite is not used for
runtime state; any legacy data/opendots.sqlite is a migration source only.`;

/** Read the contract exactly the way the runtime does. */
function loadContract() {
  let dir = packageRoot;
  for (let depth = 0; depth < 10; depth++) {
    for (const candidate of [
      join(dir, 'feltdb.flow'),
      join(dir, 'dist/feltdb.flow'),
    ]) {
      if (existsSync(candidate)) {
        const source = readFileSync(candidate, 'utf8');
        const app = /^app\s+([A-Za-z_][A-Za-z0-9_-]*)\s*\{/m.exec(source);
        const collections = [
          ...source.matchAll(
            /^\s{2}collection\s+([A-Za-z_][A-Za-z0-9_-]*)\s*\{/gm,
          ),
        ].map((match) => match[1]);
        return { path: candidate, app: app?.[1] ?? null, collections };
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function requireBuild() {
  if (!existsSync(serverEntry)) {
    console.error(
      `opendots: ${serverEntry} is missing.\n` +
        'The published package ships prebuilt. Reinstall the package, or run `npm run build` in a checkout.',
    );
    process.exit(1);
  }
}
function status() {
  const contract = loadContract();
  const statePath = process.env.FELTDB_PATH ?? 'data/opendots-state';
  const namespace =
    process.env.FELTDB_NAMESPACE ??
    `${contract?.app?.toLowerCase() ?? 'unknown'}`;
  console.log('OpenDots on FeltDB');
  console.log(`  package root   ${packageRoot}`);
  console.log(
    `  built server   ${existsSync(serverEntry) ? 'present' : 'MISSING'}`,
  );
  console.log(`  contract       ${contract ? contract.path : 'MISSING'}`);
  console.log(
    `  application    ${contract?.app ?? 'unknown'} (${contract?.collections.length ?? 0} collections declared)`,
  );
  console.log(`  state path     ${resolve(process.cwd(), statePath)}`);
  console.log(`  namespace      ${namespace}`);
  console.log(
    `  legacy sqlite  ${existsSync(legacyDatabase) ? 'present (migration source only, unused at runtime)' : 'absent'}`,
  );
  if (!contract) {
    console.error(
      '\nNo feltdb.flow found. OpenDots cannot start without its contract.',
    );
    process.exit(1);
  }
}

async function start(args) {
  requireBuild();
  // Fail before spawning if the contract is missing, so the error names the cause
  // rather than surfacing as an unexplained child crash.
  if (!loadContract()) {
    console.error(
      'opendots: feltdb.flow was not found in the package. OpenDots cannot start without its contract.',
    );
    process.exit(1);
  }
  const env = { ...process.env };
  const port = indexOf(args, '--port');
  const host = indexOf(args, '--host');
  if (port) env.PORT = args[port + 1];
  if (host) env.HOST = args[host + 1];
  const child = spawn(process.execPath, [serverEntry], {
    stdio: 'inherit',
    env,
    cwd: process.cwd(),
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

function indexOf(args, flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : at;
}

function stop() {
  // OpenDots is a long-running foreground server holding an exclusive lock on its
  // state directory, so stopping it is owned by whatever supervises it and it is
  // never safe to kill by process name.
  console.log(
    'opendots stop: OpenDots runs in the foreground and owns an exclusive lock on\n' +
      'its state directory. Stop the process that supervises it:\n' +
      '  Ctrl-C                      (foreground run)\n' +
      '  docker compose stop app     (container deployment)',
  );
}

function validate() {
  const contract = loadContract();
  if (!contract) {
    console.error('opendots: no feltdb.flow found to validate.');
    process.exit(1);
  }
  console.log(`contract: ${contract.path}`);
  console.log(`  application    ${contract.app}`);
  console.log(`  collections    ${contract.collections.length}`);
}

const [command = 'status', ...args] = process.argv.slice(2);

switch (command) {
  case 'start':
    await start(args);
    break;
  case 'status':
    status();
    break;
  case 'stop':
    stop();
    break;
  case 'validate':
    validate();
    break;
  case '--help':
  case '-h':
  case 'help':
    console.log(USAGE);
    break;
  default:
    console.error(`opendots: unknown command "${command}".\n`);
    console.error(USAGE);
    process.exit(1);
}
