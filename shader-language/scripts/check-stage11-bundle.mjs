import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeHistoricalCostDiff } from './shader-cost-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(await readFile(resolve(root, 'shader-language/stage11-contract.json'), 'utf8'));
const artifact = await readFile(resolve(root, 'engine/dist/internal/material-lighting-shader-artifact.js'));
const source = artifact.toString('utf8');
const evidence = {
  materialLightingArtifactRawBytes: artifact.length,
  materialLightingArtifactGzipBytes: gzipSync(artifact, { level: 9 }).length,
};
const failures = [];
const diff = computeHistoricalCostDiff(evidence, contract.bundle);
if (evidence.materialLightingArtifactGzipBytes > contract.bundle.materialLightingArtifactGzipBudgetBytes) {
  failures.push(`gzip ${evidence.materialLightingArtifactGzipBytes} exceeds ${contract.bundle.materialLightingArtifactGzipBudgetBytes}`);
}
if (/compileProductionMaterialLightingFamilyV1|emitProductionMaterialLightingPass|function parseFamily/.test(source)) {
  failures.push('engine material-lighting artifact contains compiler implementation');
}
if (/\b(?:MAX_LIGHTS|MAX_DIRECTIONAL_SHADOWS|BLINN_PHONG_MAX_LIGHTS|TOON_MAX_LIGHTS|CLEARCOAT_ENABLED|TRANSMISSION_ENABLED)\b/.test(source)) {
  failures.push('engine material-lighting artifact contains unresolved specialization placeholders');
}
if (failures.length > 0) throw new Error(`Stage 11 shader bundle gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage11:bundle] passed: raw=${format(diff.materialLightingArtifactRawBytes)}, gzip=${format(diff.materialLightingArtifactGzipBytes)}/${contract.bundle.materialLightingArtifactGzipBudgetBytes}.`);

function format(entry) {
  return `${entry.current} (historical=${entry.baseline}, delta=${entry.delta >= 0 ? '+' : ''}${entry.delta})`;
}
