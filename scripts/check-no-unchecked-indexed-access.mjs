import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { resolveStudioRepositoryPath } from './studio-repository-layout.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baseConfig = JSON.parse(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8'));

if (baseConfig.compilerOptions?.noUncheckedIndexedAccess !== true) {
  console.error('[no-unchecked-index] tsconfig.base.json must enable noUncheckedIndexedAccess.');
  process.exit(1);
}

const workspaces = [
  { label: 'engine', configPath: resolve(root, 'engine/tsconfig.json') },
  { label: 'extensions', configPath: resolve(root, 'extensions/tsconfig.json') },
  { label: 'ui', configPath: resolveStudioRepositoryPath('UI', 'tsconfig.json') },
  { label: 'editor', configPath: resolveStudioRepositoryPath('Editor', 'editor', 'tsconfig.json') },
  { label: 'examples', configPath: resolve(root, 'examples/tsconfig.json') },
  { label: 'games', configPath: resolveStudioRepositoryPath('Games', 'tsconfig.json') },
];
const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
let failed = false;

for (const workspace of workspaces) {
  const { label, configPath } = workspace;
  const effectiveConfigResult = spawnSync(
    process.execPath,
    [tsc, '-p', configPath, '--showConfig'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (effectiveConfigResult.error) throw effectiveConfigResult.error;

  let effectiveConfig;
  try {
    effectiveConfig = JSON.parse(effectiveConfigResult.stdout);
  } catch {
    const output = `${effectiveConfigResult.stdout ?? ''}\n${effectiveConfigResult.stderr ?? ''}`.trim();
    console.error(`[no-unchecked-index] ${label}: could not resolve the effective TypeScript config.`);
    if (output) console.error(output);
    failed = true;
    continue;
  }
  if (effectiveConfig.compilerOptions?.noUncheckedIndexedAccess !== true) {
    console.error(`[no-unchecked-index] ${label}: effective config must enable noUncheckedIndexedAccess.`);
    failed = true;
    continue;
  }

  const result = spawnSync(
    process.execPath,
    [
      tsc,
      '-p', configPath,
      '--noEmit',
      '--pretty', 'false',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw result.error;

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const diagnostics = output.split(/\r?\n/).filter(line => line.includes('error TS'));
  if (result.status !== 0 || diagnostics.length > 0) {
    console.error(`[no-unchecked-index] ${label}: failed with ${diagnostics.length} diagnostics.`);
    if (output) console.error(output);
    failed = true;
  } else {
    console.log(`[no-unchecked-index] ${label}: 0 diagnostics`);
  }
}

if (failed) process.exit(1);
