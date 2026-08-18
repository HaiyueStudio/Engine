import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { convertLottie } from '../../animation-spec/dist/lottie.js';
import { analyzeLottieFeatures } from './feature-attribution.mjs';
import { createCapabilitySnapshot } from './capability-roadmap.mjs';
import {
  CAPABILITY_SUPPORT_PATH,
  entryFontMappings,
  entrySourceAssetPath,
  readCorpusManifest,
  syncCorpus,
  writeJson,
} from './corpus.mjs';

const offline = process.argv.includes('--offline');
const manifest = readCorpusManifest();
const sync = await syncCorpus(manifest, { offline });
const samples = manifest.entries.map(entry => {
  const source = readFileSync(entrySourceAssetPath(manifest, entry), 'utf8');
  const fonts = entryFontMappings(manifest, entry);
  const conversion = convertLottie(source, Object.keys(fonts).length > 0 ? { fonts } : undefined);
  return {
    id: entry.id,
    featureAnalysis: analyzeLottieFeatures(source, conversion.diagnostics, entry.features),
    fidelity: null,
  };
});
const state = repositoryState();
const snapshot = createCapabilitySnapshot(samples, state);
writeJson(CAPABILITY_SUPPORT_PATH, snapshot);
console.log(
  `[hya-capabilities] ${snapshot.summary.featureCount} features: `
  + `${snapshot.summary.fullCount} full, ${snapshot.summary.partialCount} partial, `
  + `${snapshot.summary.unsupportedCount} unsupported; precomp=${snapshot.summary.precompStatus}; `
  + `assets reused=${sync.reused}, downloaded=${sync.downloaded}.`,
);

function repositoryState() {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return {
    gitRevision: revision.status === 0 ? revision.stdout.trim() : 'unknown',
    workingTreeDirty: status.status !== 0 || status.stdout.trim().length > 0,
  };
}
