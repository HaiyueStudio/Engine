import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmArgs, npmCommand } from './npm-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error('Usage: npm run build:target -- example:<name> [game:<name> ...]');
  process.exit(2);
}

const batches = new Map();
for (const target of targets) {
  const separator = target.indexOf(':');
  const kind = separator < 0 ? '' : target.slice(0, separator);
  const name = separator < 0 ? '' : target.slice(separator + 1);
  const definition = kind === 'example'
    ? {
        kind,
        directory: 'examples',
        filter: 'EXAMPLE_FILTER',
        manifestKind: 'examples',
        environment: { EXAMPLE_SKIP_SOURCE_VIEWER: '1' },
      }
    : kind === 'game'
      ? { kind, directory: 'games', filter: 'GAME_FILTER', manifestKind: 'games', environment: {} }
      : null;

  if (!definition || !name) {
    console.error(`Invalid target "${target}". Expected example:<name> or game:<name>.`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(resolve(root, definition.directory, 'manifest.json'), 'utf8'));
  if (manifest.kind !== definition.manifestKind || !manifest.entries.some(entry => entry.id === name)) {
    console.error(`Unknown ${kind} target "${name}".`);
    process.exit(1);
  }

  let batch = batches.get(kind);
  if (!batch) {
    batch = { definition, names: [] };
    batches.set(kind, batch);
  }
  if (!batch.names.includes(name)) batch.names.push(name);
}

for (const { definition, names } of batches.values()) {
  console.log(`\n[build-target] ${definition.manifestKind}: ${names.join(', ')}`);
  const result = spawnSync(npmCommand(), npmArgs(['run', 'build', '-w', `./${definition.directory}`]), {
    cwd: root,
    env: {
      ...process.env,
      ...definition.environment,
      [definition.filter]: names.join(','),
    },
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
