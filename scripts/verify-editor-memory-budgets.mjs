import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateEditorMemoryArtifact,
  validateEditorMemoryBudgetConfig,
} from './editor-memory-budget-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = validateEditorMemoryBudgetConfig(JSON.parse(
  await readFile(resolve(root, 'config/editor-memory-budgets.json'), 'utf8'),
));
const scenarios = [];
for (const [id, policy] of Object.entries(config.scenarios)) {
  const result = spawnSync(process.execPath, [
    '--expose-gc',
    resolve(root, 'scripts/editor-memory-scenario-child.mjs'),
    id,
    JSON.stringify(policy.parameters),
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  scenarios.push(JSON.parse(result.stdout.trim()));
}

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  headCommit: readHeadCommit(),
  nodeVersion: process.version,
  platform: `${process.platform}-${process.arch}`,
  scenarios,
};
const output = resolve(root, 'artifacts/editor/editor-memory-budget.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);

const { violations } = evaluateEditorMemoryArtifact(config, artifact);
for (const scenario of scenarios) {
  console.log(
    `[editor-memory] ${scenario.id}: heap=${formatMiB(scenario.metrics.heapDeltaBytes)}, `
    + `arrayBuffers=${formatMiB(scenario.metrics.arrayBufferDeltaBytes)}, `
    + `rss=${formatMiB(scenario.metrics.rssDeltaBytes)}, `
    + `cleanupHeap=${formatMiB(scenario.metrics.cleanupHeapResidualBytes)}`,
  );
}
if (violations.length > 0) {
  for (const violation of violations) console.error(`[editor-memory] ${violation}`);
  process.exit(1);
}
console.log(`[editor-memory] All scenarios passed. Wrote ${output}`);

function readHeadCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function formatMiB(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}
