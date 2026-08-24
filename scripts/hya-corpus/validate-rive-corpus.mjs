import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveCorpusManifest } from './rive-corpus-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const formal = process.argv.includes('--formal');
const manifestArgument = process.argv.find(value => value.startsWith('--manifest='));
const manifestPath = resolve(
  root,
  manifestArgument?.slice('--manifest='.length)
    ?? 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json',
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const census = JSON.parse(readFileSync(resolve(root, manifest.census.path), 'utf8'));
const result = validateRiveCorpusManifest(manifest, census, { formal, root });
if (result.status !== 'passed') {
  throw new Error(`Rive G11 corpus validation failed (${result.mode}):\n- ${result.violations.join('\n- ')}`);
}
console.log(
  `[rive-corpus] ${result.mode} passed for ${relative(root, manifestPath)}; `
  + `assets=${result.summary.formalAssetCount}, adversarial=${result.summary.adversarialCaseCount}.`,
);
