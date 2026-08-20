import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRayG10ReviewManifest } from './ray-g10-review-contract.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const formal = process.argv.includes('--formal');
const manifestArgument = process.argv.find(value => value.startsWith('--manifest='));
const manifestPath = resolve(
  engineRoot,
  manifestArgument?.slice('--manifest='.length) ?? 'artifacts/ray-tracing-g10-review/manifest.json',
);
const directory = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const structure = validateRayG10ReviewManifest(manifest, { formal });
if (structure.status !== 'passed') fail(structure);
const captureFiles = new Map(
  manifest.captures.map(capture => [capture.file, readFileSync(resolve(directory, capture.file))]),
);
const validation = validateRayG10ReviewManifest(manifest, { formal, captureFiles });
if (validation.status !== 'passed') fail(validation);
console.log(`[ray-g10-review] ${validation.mode} passed for ${relative(engineRoot, manifestPath)}.`);

function fail(validation) {
  throw new Error(
    `G10 review validation failed (${validation.mode}):\n- ${validation.violations.join('\n- ')}`,
  );
}
