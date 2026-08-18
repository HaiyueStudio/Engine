import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '.artifacts/packages');
mkdirSync(output, { recursive: true });

for (const workspace of ['shader-language', 'engine', 'animation-spec', 'extensions']) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is required to pack repository candidates.');
  const result = spawnSync(process.execPath, [npmCli, 'pack', '-w', `./${workspace}`, '--pack-destination', output, '--loglevel=error', '--cache=.npm-cache'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`[pack-candidates] wrote Engine candidates to ${output}`);
