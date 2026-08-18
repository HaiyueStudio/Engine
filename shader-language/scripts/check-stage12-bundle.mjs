import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeHistoricalCostDiff } from './shader-cost-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(await readFile(resolve(root, 'shader-language/stage12-contract.json'), 'utf8'));
const artifact = await readFile(resolve(root, 'engine/dist/internal/specialized-rendering-shader-artifact.js'));
const source = artifact.toString('utf8');
const evidence = {
  specializedRenderingArtifactRawBytes: artifact.length,
  specializedRenderingArtifactGzipBytes: gzipSync(artifact, { level: 9 }).length,
};
const failures = [];
const diff = computeHistoricalCostDiff(evidence, contract.bundle);
if (evidence.specializedRenderingArtifactGzipBytes > contract.bundle.specializedRenderingArtifactGzipBudgetBytes) {
  failures.push(`gzip ${evidence.specializedRenderingArtifactGzipBytes} exceeds ${contract.bundle.specializedRenderingArtifactGzipBudgetBytes}`);
}
if (/compileProductionSpecializedRenderingFamilyV1|emitProductionSpecializedRenderingPass|function parseFamily/.test(source)) {
  failures.push('engine specialized-rendering artifact contains compiler implementation');
}
if (/\b(?:MAX_LIGHTS|CAP_SEGS|VERTS_PER_SEG)\b/.test(source)) {
  failures.push('engine specialized-rendering artifact contains unresolved specialization placeholders');
}
if (failures.length > 0) throw new Error(`Stage 12 shader bundle gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage12:bundle] passed: raw=${format(diff.specializedRenderingArtifactRawBytes)}, gzip=${format(diff.specializedRenderingArtifactGzipBytes)}/${contract.bundle.specializedRenderingArtifactGzipBudgetBytes}.`);

function format(entry) {
  return `${entry.current} (historical=${entry.baseline}, delta=${entry.delta >= 0 ? '+' : ''}${entry.delta})`;
}
