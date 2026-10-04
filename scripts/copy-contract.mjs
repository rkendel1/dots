/**
 * Copy the application contract into the build output.
 *
 * `feltdb.flow` is the authoritative declaration of OpenDots' durable state, and
 * the runtime has to find it wherever the product is installed. `contract.ts`
 * resolves it by walking up from its own module, so in a build the module lives at
 * `dist/server/server/` and the contract has to be reachable at or above `dist/`.
 *
 * The root `feltdb.flow` stays the single source of truth: `dist/` is gitignored,
 * so exactly one copy is ever committed and this step is purely mechanical. That
 * matters for the container image, which copies `/app/dist` and nothing else —
 * without this the image starts with "feltdb.flow was not found".
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'feltdb.flow');
const targetDir = join(root, 'dist');
const target = join(targetDir, 'feltdb.flow');

if (!existsSync(source)) {
  console.error(
    `build: ${source} is missing; the contract must ship with OpenDots.`,
  );
  process.exit(1);
}
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`build: copied feltdb.flow -> ${target}`);
