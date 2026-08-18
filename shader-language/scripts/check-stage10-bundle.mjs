import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeHistoricalCostDiff } from './shader-cost-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(await readFile(resolve(root, 'shader-language/stage10-contract.json'), 'utf8'));
const deformation = await readFile(resolve(root, 'engine/dist/internal/deformation-shader-artifact.js'));
const simple3d = await readFile(resolve(root, 'engine/dist/internal/simple3d-shader-artifact.js'), 'utf8');
const evidence = {
  deformationArtifactRawBytes: deformation.length,
  deformationArtifactGzipBytes: gzipSync(deformation, { level: 9 }).length,
};
const failures = [];
const diff = computeHistoricalCostDiff(evidence, contract.bundle);
if (evidence.deformationArtifactGzipBytes > contract.bundle.deformationArtifactGzipBudgetBytes) {
  failures.push(`gzip ${evidence.deformationArtifactGzipBytes} exceeds ${contract.bundle.deformationArtifactGzipBudgetBytes}`);
}
if (/compileProductionDeformationFamilyV1|haiyue-production-deformation-family/.test(deformation.toString('utf8'))) {
  failures.push('engine deformation artifact contains the compiler or family parser');
}
if (/basic-material|forward-skinned|haiyue:deformation-pass/.test(simple3d)) {
  failures.push('simple-3D artifact retained duplicate forward deformation code');
}
if (failures.length > 0) throw new Error(`Stage 10 shader bundle gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage10:bundle] passed: raw=${format(diff.deformationArtifactRawBytes)}, gzip=${format(diff.deformationArtifactGzipBytes)}/${contract.bundle.deformationArtifactGzipBudgetBytes}.`);

function format(entry) {
  return `${entry.current} (historical=${entry.baseline}, delta=${entry.delta >= 0 ? '+' : ''}${entry.delta})`;
}
