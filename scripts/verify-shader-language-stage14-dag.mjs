import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateShaderCostBudget,
  loadShaderCostBudget,
} from '../shader-language/scripts/shader-cost-policy.mjs';
import { SHADER_LANGUAGE_BROWSER_DAG } from './shader-language-browser-dag.mjs';
import { npmArgs, npmCommand } from './npm-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, 'artifacts/shader-language/stage14-dag.json');
const shaderTests = readdirSync(resolve(root, 'shader-language/test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => `shader-language/test/${name}`);
const engineTests = [
  'engine/test/precompiled-shader-runtime-v2.test.mjs',
  'engine/test/postprocess-generated-shader.test.mjs',
  'engine/test/depth-material-shader.test.mjs',
  'engine/test/fog-product-contract.test.mjs',
  'engine/test/deformation-shader-family.test.mjs',
  'engine/test/deformation-history-lifecycle.test.mjs',
  'engine/test/material-lighting-shader-family.test.mjs',
  'engine/test/specialized-rendering-shader-family.test.mjs',
  'engine/test/compute-shader-family.test.mjs',
];
const nodes = [
  node('build:shader-language', [], npm('run', 'build', '-w', './shader-language'), 'build'),
  node('generate:production', ['build:shader-language'], js('shader-language/scripts/verify-production-cache.mjs'), 'generation'),
  node('build:engine', ['generate:production'], npm('run', 'build', '-w', './engine'), 'build'),
  node('build:extensions', ['build:engine'], npm('run', 'build', '-w', './extensions'), 'build'),
  node('build:motion-blur-example', ['build:engine', 'build:extensions'], js('scripts/build-target.mjs', 'example:motion-blur'), 'content'),
  node('static:stage14-boundary', ['build:shader-language'], js('shader-language/scripts/check-stage14-boundary.mjs'), 'static'),
  node(
    'static:shader-contracts',
    ['build:engine', 'build:extensions'],
    js('--test', '--test-concurrency=1', ...shaderTests, ...engineTests),
    'static',
  ),
  node('static:stage9-bundle', ['build:engine', 'build:extensions'], js('shader-language/scripts/check-stage9-bundle.mjs'), 'static'),
  node('static:stage10-bundle', ['build:engine'], js('shader-language/scripts/check-stage10-bundle.mjs'), 'static'),
  node('static:stage11-bundle', ['build:engine'], js('shader-language/scripts/check-stage11-bundle.mjs'), 'static'),
  node('static:stage12-bundle', ['build:engine'], js('shader-language/scripts/check-stage12-bundle.mjs'), 'static'),
  node('static:stage13-bundle', ['build:engine'], js('shader-language/scripts/check-stage13-bundle.mjs'), 'static'),
  ...SHADER_LANGUAGE_BROWSER_DAG.map(entry => (
    node(entry.id, entry.dependencies, js(entry.script), 'browser')
  )),
];

const completed = new Set();
const nodeReports = [];
let failure = null;
try {
  while (completed.size < nodes.length) {
    const ready = nodes.find(candidate => (
      !completed.has(candidate.id)
      && candidate.dependencies.every(dependency => completed.has(dependency))
    ));
    if (!ready) throw new Error('Shader Stage 14 DAG contains a cycle or unresolved dependency.');
    const startedAt = performance.now();
    console.log(`\n[shader-language:stage14:dag] ${ready.id}`);
    const result = spawnSync(ready.command, ready.args, { cwd: root, stdio: 'inherit' });
    const durationMs = performance.now() - startedAt;
    nodeReports.push({
      id: ready.id,
      kind: ready.kind,
      dependencies: ready.dependencies,
      command: [ready.command, ...ready.args],
      durationMs,
      status: result.status === 0 ? 'passed' : 'failed',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${ready.id} exited with status ${String(result.status)}.`);
    completed.add(ready.id);
  }
} catch (error) {
  failure = error;
}

const dag = {
  shaderLanguageBuilds: countNode('build:shader-language'),
  engineBuilds: countNode('build:engine'),
  extensionsBuilds: countNode('build:extensions'),
};
const shaderCostPath = resolve(root, 'artifacts/shader-language/shader-cost.json');
let shaderCost = null;
let costBudget = null;
try {
  shaderCost = JSON.parse(readFileSync(shaderCostPath, 'utf8'));
  dag.productionGenerationRuns = shaderCost.cache.hit ? 0 : countNode('generate:production');
  shaderCost.dag = dag;
  costBudget = evaluateShaderCostBudget(shaderCost, loadShaderCostBudget(root));
  if (costBudget.status !== 'passed' && failure === null) {
    failure = new Error(`Shader Stage 14 DAG cost budget failed:\n- ${costBudget.violations.map(item => `${item.metric}: ${item.reason}`).join('\n- ')}`);
  }
} catch (error) {
  dag.productionGenerationRuns = countNode('generate:production');
  if (failure === null) failure = error;
}
const report = {
  schemaVersion: 1,
  suite: 'shader-language.stage14.dag',
  status: failure === null ? 'passed' : 'failed',
  generatedAt: new Date().toISOString(),
  nodeCount: nodes.length,
  completedNodeCount: completed.size,
  dag,
  cache: shaderCost?.cache ?? null,
  cost: shaderCost === null ? null : { ...shaderCost, budget: costBudget },
  nodes: nodeReports,
  failure: failure instanceof Error ? failure.message : failure === null ? null : String(failure),
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (failure) throw failure;
console.log(
  `[shader-language:stage14:dag] ${nodes.length} nodes passed; builds=`
  + `${dag.shaderLanguageBuilds}/${dag.engineBuilds}/${dag.extensionsBuilds}, `
  + `generation=${dag.productionGenerationRuns}, cache=${shaderCost?.cache.hit ? 'hit' : 'miss'}.`,
);

function node(id, dependencies, command, kind) {
  return Object.freeze({ id, dependencies: Object.freeze(dependencies), ...command, kind });
}

function npm(...args) {
  return { command: npmCommand(), args: npmArgs(args) };
}

function js(...args) {
  return { command: process.execPath, args };
}

function countNode(id) {
  return nodeReports.filter(entry => entry.id === id && entry.status === 'passed').length;
}
