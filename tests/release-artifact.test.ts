/**
 * Release gate: prove the *published artifact* works, not just the source tree.
 *
 * The source-tree suites pass because they run from a checkout, where `feltdb.flow`
 * sits at the repository root beside `dist/`. A shipped package has neither, and
 * the container image copies only `dist/`. This suite closes that gap:
 *
 *   build → pack → clean temp dir → npm install the tarball
 *          → validate the shipped contract with the pinned FeltDB CLI
 *          → start OpenDots from the installed package
 *          → write state through the HTTP API
 *          → stop → start a fresh process → read it back
 *
 * This is the gate that catches a missing `feltdb.flow`, a wrong package path, a
 * runtime dependency `files` failed to ship, a contract the installed copy cannot
 * resolve, and a namespace that changes between processes.
 *
 * It packs, installs and boots twice, so it is excluded from `npm test` and run
 * by `npm run test:release` and the CI release job.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));

const run = (cmd: string[], cwd = repo) =>
  execFileSync(cmd[0]!, cmd.slice(1), { cwd, encoding: 'utf8', stdio: 'pipe' });

/**
 * Resolve npm without going through PATH.
 *
 * A test runner spawns with its own environment, and `npm` here is an nvm shim
 * rather than a binary — so `spawnSync('npm', …)` and `spawnSync('sh', …)` both
 * fail with ENOENT. Addressing node and npm's CLI script by absolute path is the
 * same technique used for the pinned FeltDB CLI, and has no PATH dependency.
 */
function npmCli(): string {
  const candidates = [
    process.env.npm_execpath,
    join(
      dirname(process.execPath),
      '..',
      'lib/node_modules/npm/bin/npm-cli.js',
    ),
    join(dirname(process.execPath), '..', 'node_modules/npm/bin/npm-cli.js'),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates)
    if (existsSync(candidate)) return candidate;
  throw new Error(`Could not locate npm. Tried:\n  ${candidates.join('\n  ')}`);
}

const npm = (args: string[], cwd = repo) =>
  execFileSync(process.execPath, [npmCli(), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });

/** Poll a URL until it answers or the deadline passes. */
async function waitForHttp(url: string, deadlineMs = 90_000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

interface Booted {
  child: ChildProcess;
  log: () => string;
}

describe('release artifact — the installed package works standalone', () => {
  let workspace: string;
  let installed: string;
  const root = () => join(installed, 'node_modules', 'opendots');

  beforeAll(async () => {
    // Outside the repository entirely, so nothing can resolve back into it.
    workspace = mkdtempSync(join(tmpdir(), 'opendots-release-'));
    installed = join(workspace, 'app');
    // `npm init` needs its target to exist; spawnSync reports a missing working
    // directory as ENOENT on the spawned binary, which reads as a broken node.
    mkdirSync(installed, { recursive: true });

    npm(['run', 'build']);
    const packed = npm(['pack', '--pack-destination', workspace]);
    const tarball = join(workspace, packed.trim().split('\n').pop()!.trim());

    npm(['init', '-y'], installed);
    npm(
      [
        'install',
        tarball,
        '--no-audit',
        '--no-fund',
        '--loglevel',
        'error',
        // CI has already run `npm ci`, so the cache is warm; this turns a full
        // network fetch of the dependency tree into a mostly-local one.
        '--prefer-offline',
        // `@tanstack/ai-openai@^0.25.1` declares a peer on `@tanstack/ai`, whose
        // range npm's resolver cannot satisfy here and retries indefinitely — the
        // install burns 100% CPU forever without ever writing `node_modules`.
        // `--legacy-peer-deps` installs the same runtime closure without that
        // peer edge, and what this suite actually proves is unaffected: the
        // contract ships, the pinned CLI validates it, the server boots and
        // survives a restart. Every one of those still has to work against the
        // tree npm really produced.
        '--legacy-peer-deps',
      ],
      installed,
    );
  }, 900_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('ships the contract, the compiled server, the UI and the FeltDB dependency', () => {
    expect(existsSync(join(root(), 'feltdb.flow'))).toBe(true);
    expect(existsSync(join(root(), 'dist/feltdb.flow'))).toBe(true);
    expect(existsSync(join(root(), 'dist/server/server/index.js'))).toBe(true);
    expect(existsSync(join(root(), 'dist/client/index.html'))).toBe(true);
    expect(
      existsSync(join(installed, 'node_modules/@feltdb/core/package.json')),
    ).toBe(true);
  });

  it('ships no source, tests, migrations or legacy database', () => {
    expect(existsSync(join(root(), 'src'))).toBe(false);
    expect(existsSync(join(root(), 'tests'))).toBe(false);
    expect(existsSync(join(root(), 'migrations'))).toBe(false);
    expect(existsSync(join(root(), 'data/opendots.sqlite'))).toBe(false);
  });

  it('declares no SQLite runtime dependency and pins a compatible FeltDB', () => {
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      expect(dependency).not.toMatch(/sqlite/i);
    }
    // §2 — exact pin, not a range: the shipped contract is validated against this
    // version's FlowSpec grammar, so a floating range could resolve to one that
    // parses it differently.
    expect(pkg.dependencies['@feltdb/core']).toBe(pkg.opendots.feltdb.version);
    expect(
      JSON.parse(
        readFileSync(
          join(installed, 'node_modules/@feltdb/core/package.json'),
          'utf8',
        ),
      ).version,
    ).toBe(pkg.opendots.feltdb.version);
  });

  it('declares FeltDB compatibility in machine-readable product metadata', () => {
    expect(pkg.opendots.product).toBe('OpenDots on FeltDB');
    expect(pkg.opendots.durableStateAuthority).toBe('@feltdb/core');
    expect(pkg.opendots.contract).toBe('feltdb.flow');
    expect(pkg.opendots.runtimeSqlite).toBe(false);
    expect(pkg.opendots.feltdb.collections).toBe(18);
    // The same declaration must ship with the artifact, so an installed user can
    // answer the compatibility question without reading source.
    const shipped = JSON.parse(
      readFileSync(join(root(), 'package.json'), 'utf8'),
    );
    expect(shipped.opendots).toEqual(pkg.opendots);
  });
  it('resolves feltdb.flow from the installed package, not the repository', () => {
    const entry = join(root(), 'dist/server/server/contract.js');
    const out = run(
      [
        process.execPath,
        '-e',
        `import(${JSON.stringify(entry)}).then(m => {
           const c = m.loadContract();
           m.assertCollectionsDeclared(m.RUNTIME_COLLECTIONS);
           console.log(JSON.stringify({ path: c.path, app: c.app, n: c.collections.length }));
         })`,
      ],
      installed,
    );
    const resolved = JSON.parse(out.trim()) as {
      path: string;
      app: string;
      n: number;
    };
    // Both sides are compared after `realpath`, because Node resolves module URLs
    // through symlinks: on macOS the sandbox is reached as `/private/var/...`
    // while `mkdtemp` hands back `/var/...`, and a raw `startsWith` would report a
    // false negative for a contract that resolved perfectly correctly.
    expect(realpathSync(resolved.path).startsWith(realpathSync(root()))).toBe(
      true,
    );
    expect(resolved.app).toBe('OpenDots');
    expect(resolved.n).toBe(18);
    // And it is this package's copy, not a stray checkout the install could reach.
    expect(realpathSync(dirname(resolved.path))).toBe(
      realpathSync(join(root(), 'dist')),
    );
  });

  it('validates the shipped contract with the pinned FeltDB CLI', () => {
    const cli = join(installed, 'node_modules/@feltdb/core/bin/feltdb.js');
    const out = run(
      [process.execPath, cli, 'validate', join(root(), 'feltdb.flow')],
      installed,
    );
    expect(out).toContain('OpenDots');
    expect(out).toContain('18 collections');
  });

  it('rejects a malformed contract through the same pinned CLI', () => {
    const cli = join(installed, 'node_modules/@feltdb/core/bin/feltdb.js');
    const broken = join(workspace, 'broken.flow');
    writeFileSync(
      broken,
      'flow_version 1\n\napp Bad {\n  collection x {\n    y: nonsense_type\n  }\n}\n',
    );
    let rejected = false;
    try {
      run([process.execPath, cli, 'validate', broken], installed);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('runs the installed CLI without a checkout', () => {
    // Addressed through node rather than `node_modules/.bin`, whose shebang
    // would need `node` resolvable on PATH.
    const cli = join(root(), 'bin/opendots.js');
    expect(run([process.execPath, cli, '--help'], installed)).toContain(
      'OpenDots on FeltDB',
    );
    const status = run([process.execPath, cli, 'status'], installed);
    expect(status).toContain('18 collections declared');
    expect(status).toMatch(/namespace\s+opendots/);
    expect(run([process.execPath, cli, 'stop'], installed)).toContain(
      'foreground',
    );
  });
  it('serves the UI, writes through the API, and survives a restart', async () => {
    const port = 4399;
    const base = `http://127.0.0.1:${port}`;
    const statePath = join(workspace, 'state');
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      FELTDB_PATH: statePath,
    };

    const boot = (): Booted => {
      const child = spawn(
        process.execPath,
        [join(root(), 'bin/opendots.js'), 'start'],
        { cwd: installed, env, stdio: 'pipe' },
      );
      let log = '';
      child.stdout?.on('data', (chunk) => (log += chunk));
      child.stderr?.on('data', (chunk) => (log += chunk));
      return { child, log: () => log };
    };

    const first = boot();
    // Hoisted out of the first `try` so the second boot can assert on the exact
    // record the first one created.
    let memory: { id: string; text: string };
    try {
      expect(await waitForHttp(`${base}/api/state`)).toBe(true);

      // §10 — the UI is served by the same installed process that owns the state.
      const ui = await fetch(base);
      expect(ui.status).toBe(200);
      expect(await ui.text()).toContain('<!doctype html>');

      // §6 — write through the normal HTTP API, not a raw database handle.
      const created = await fetch(`${base}/api/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'written by the installed artifact' }),
      });
      expect(created.status).toBe(201);
      memory = (await created.json()) as { id: string; text: string };
      expect(memory.text).toBe('written by the installed artifact');

      const state = await (await fetch(`${base}/api/state`)).json();
      expect(
        (state as { memories: { text: string }[] }).memories.map((m) => m.text),
      ).toContain('written by the installed artifact');

      // §7 — a fresh environment produces no SQLite, anywhere.
      expect(existsSync(join(workspace, 'opendots.sqlite'))).toBe(false);
      expect(existsSync(join(installed, 'opendots.sqlite'))).toBe(false);
      expect(existsSync(join(statePath, 'opendots.sqlite'))).toBe(false);
    } finally {
      first.child.kill('SIGTERM');
    }

    // Let the state lock be released before the second boot.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // §6 — a fresh process, the same namespace, the same state.
    const second = boot();
    try {
      expect(await waitForHttp(`${base}/api/state`)).toBe(true);
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(
        (state as { memories: { id: string; text: string }[] }).memories,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: memory.id,
            text: 'written by the installed artifact',
          }),
        ]),
      );
      // The namespace still derives from the contract after a restart.
      const status = run(
        [process.execPath, join(root(), 'bin/opendots.js'), 'status'],
        installed,
      );
      expect(status).toMatch(/namespace\s+opendots/);
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- first boot ---\n${first.log()}\n--- second boot ---\n${second.log()}`,
        { cause: error },
      );
    } finally {
      second.child.kill('SIGTERM');
    }
  }, 300_000);
});
