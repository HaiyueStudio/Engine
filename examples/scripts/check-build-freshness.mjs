import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyExampleBuildFreshness } from './example-build-fingerprint.mjs';
import { SHARED_ENGINE_TARGET } from './shared-engine-bundle.mjs';

const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(examplesDir, 'manifest.json'), 'utf8'));
const filter = readArgument('--filter') ?? process.env.EXAMPLE_FILTER;
const demoIds = filter
  ? manifest.entries.filter(entry => entry.id === filter).map(entry => entry.id)
  : manifest.entries.map(entry => entry.id);
if (filter && demoIds.length === 0) throw new Error(`Unknown example "${filter}".`);
const targets = process.argv.includes('--skip-shell')
  ? [SHARED_ENGINE_TARGET, ...demoIds]
  : ['source-viewer', SHARED_ENGINE_TARGET, ...demoIds];
const result = await verifyExampleBuildFreshness({ targets });
console.log(
  `[examples:freshness] ${result.targetCount} targets match source ${result.sourceFingerprint.slice(0, 12)}.`,
);

function readArgument(name) {
  const argument = process.argv.find(value => value.startsWith(`${name}=`));
  return argument?.slice(name.length + 1);
}
