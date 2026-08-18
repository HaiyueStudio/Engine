import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeHistoricalCostDiff } from './shader-cost-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(await readFile(resolve(root, 'shader-language/stage13-contract.json'), 'utf8'));
const artifact = await readFile(resolve(root, 'engine/dist/internal/compute-shader-artifact.js'));
const source = artifact.toString('utf8');
const evidence = { computeArtifactRawBytes: artifact.length, computeArtifactGzipBytes: gzipSync(artifact, { level: 9 }).length };
const failures = [];
const diff = computeHistoricalCostDiff(evidence, contract.bundle);
if (evidence.computeArtifactGzipBytes > contract.bundle.computeArtifactGzipBudgetBytes) failures.push(`gzip ${evidence.computeArtifactGzipBytes} exceeds ${contract.bundle.computeArtifactGzipBudgetBytes}`);
if (/compileProductionComputeFamilyV1|function parseFamily|shaderError\(/.test(source)) failures.push('engine compute artifact contains compiler implementation');
if (!/haiyue:compute-ir [a-f0-9]{64}/.test(source)) failures.push('engine compute artifact is missing typed compute IR provenance');
if (failures.length > 0) throw new Error(`Stage 13 shader bundle gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage13:bundle] passed: raw=${format(diff.computeArtifactRawBytes)}, gzip=${format(diff.computeArtifactGzipBytes)}/${contract.bundle.computeArtifactGzipBudgetBytes}.`);

function format(entry) {
  return `${entry.current} (historical=${entry.baseline}, delta=${entry.delta >= 0 ? '+' : ''}${entry.delta})`;
}
