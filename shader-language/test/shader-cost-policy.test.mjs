import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateShaderCostBudget,
  computeHistoricalCostDiff,
  computeProductionCostDiff,
  loadShaderCostBudget,
} from '../scripts/shader-cost-policy.mjs';
import {
  cacheEntryMatches,
  PRODUCTION_CACHE_SCOPES,
} from '../scripts/verify-production-cache.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const budget = loadShaderCostBudget(root);

test('shader cost policy governs source, IR, variant, pipeline, generation, and DAG counts', () => {
  const report = fixtureReport();
  const result = evaluateShaderCostBudget(report, budget);
  assert.equal(result.status, 'passed');
  assert.ok(result.checks.some(check => check.metric === 'showcase.irNodeCountAfterOptimization'));
  assert.ok(result.checks.some(check => check.metric === 'production.variantCount'));
  assert.ok(result.checks.some(check => check.metric === 'production.generatedWgslBytesGrowth'));
  assert.ok(result.checks.some(check => check.metric === 'production.pipelineCountGrowth'));
  assert.ok(result.checks.some(check => check.metric === 'dag.engineBuilds'));
});

test('shader cost growth budget rejects small absolute values that grow too quickly', () => {
  const report = fixtureReport();
  report.production.generatedWgslFiles =
    budget.production.growthBaseline.generatedWgslFiles
    + budget.production.maxGrowth.generatedWgslFiles
    + 1;
  const result = evaluateShaderCostBudget(report, budget);
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.violations.map(item => item.metric),
    ['production.generatedWgslFilesGrowth'],
  );
});

test('shader cost report exposes an auditable per-metric baseline diff', () => {
  const report = fixtureReport();
  report.production.variantCount = budget.production.growthBaseline.variantCount + 1;
  const diff = computeProductionCostDiff(report, budget);
  assert.deepEqual(diff.variantCount, {
    baseline: budget.production.growthBaseline.variantCount,
    current: report.production.variantCount,
    delta: 1,
    maximumGrowth: budget.production.maxGrowth.variantCount,
  });
});

test('historical bundle evidence remains immutable while current cost is reported as a diff', () => {
  const historical = { rawBytes: 1000, gzipBytes: 250 };
  const diff = computeHistoricalCostDiff({ rawBytes: 1032, gzipBytes: 246 }, historical);
  assert.deepEqual(diff, {
    rawBytes: { baseline: 1000, current: 1032, delta: 32 },
    gzipBytes: { baseline: 250, current: 246, delta: -4 },
  });
  assert.deepEqual(historical, { rawBytes: 1000, gzipBytes: 250 });
});

test('shader cost policy rejects independent source, compile, and DAG regressions', () => {
  const report = fixtureReport();
  report.showcase.sourceBytes = budget.showcase.maxSourceBytes + 1;
  report.production.coldGenerationMs = budget.production.maxColdGenerationMs + 1;
  report.dag.engineBuilds = 2;
  const result = evaluateShaderCostBudget(report, budget);
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.violations.map(item => item.metric),
    ['showcase.sourceBytes', 'production.coldGenerationMs', 'dag.engineBuilds'],
  );
});

test('cache hits retain structural budgets without inventing cold compilation timings', () => {
  const report = fixtureReport();
  report.cache.hit = true;
  report.showcase.coldCompilationMs = null;
  report.production.coldGenerationMs = null;
  const result = evaluateShaderCostBudget(report, budget);
  assert.equal(result.status, 'passed');
  assert.equal(
    result.checks.find(check => check.metric === 'showcase.coldCompilationMs').status,
    'cache-hit',
  );
});

test('partial family cache misses keep unrelated cold timings unavailable', () => {
  const productionMiss = fixtureReport();
  productionMiss.cache = {
    hit: false,
    entries: [
      { id: 'builtin-render', hit: false },
      { id: 'showcase', hit: true },
    ],
  };
  productionMiss.showcase.coldCompilationMs = null;
  let result = evaluateShaderCostBudget(productionMiss, budget);
  assert.equal(result.status, 'passed');
  assert.equal(
    result.checks.find(check => check.metric === 'showcase.coldCompilationMs').status,
    'cache-hit',
  );

  const showcaseMiss = fixtureReport();
  showcaseMiss.cache = {
    hit: false,
    entries: [
      { id: 'builtin-render', hit: true },
      { id: 'showcase', hit: false },
    ],
  };
  showcaseMiss.production.coldGenerationMs = null;
  result = evaluateShaderCostBudget(showcaseMiss, budget);
  assert.equal(result.status, 'passed');
  assert.equal(
    result.checks.find(check => check.metric === 'production.coldGenerationMs').status,
    'cache-hit',
  );
});

test('production cache is content-addressed per generator family', () => {
  assert.deepEqual(
    PRODUCTION_CACHE_SCOPES.map(scope => scope.id),
    [
      'motion-blur',
      'builtin-postprocess',
      'builtin-render',
      'deformation',
      'material-lighting',
      'specialized-rendering',
      'compute',
    ],
  );
  assert.ok(PRODUCTION_CACHE_SCOPES.every(scope => scope.inputs.length >= 2));
  assert.ok(PRODUCTION_CACHE_SCOPES.every(scope => scope.outputPrefixes.length >= 1));
  assert.equal(cacheEntryMatches({ inputHash: 'input-a', outputHash: 'output-a' }, 'input-a', 'output-a'), true);
  assert.equal(cacheEntryMatches({ inputHash: 'input-a', outputHash: 'output-a' }, 'input-b', 'output-a'), false);
  assert.equal(cacheEntryMatches({ inputHash: 'input-a', outputHash: 'output-a' }, 'input-a', 'output-b'), false);
});

function fixtureReport() {
  return {
    cache: { hit: false },
    showcase: {
      sourceBytes: 4852,
      irNodeCountBeforeOptimization: 60,
      irNodeCountAfterOptimization: 59,
      variantCount: 1,
      pipelineCount: 2,
      coldCompilationMs: 20,
    },
    production: {
      generatedWgslBytes: 305504,
      generatedWgslFiles: 64,
      variantCount: 56,
      pipelineCount: 56,
      coldGenerationMs: 100,
    },
    dag: {
      shaderLanguageBuilds: 1,
      engineBuilds: 1,
      extensionsBuilds: 1,
      productionGenerationRuns: 1,
    },
  };
}
