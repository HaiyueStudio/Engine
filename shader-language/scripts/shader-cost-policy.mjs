import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SHADER_COST_BUDGET_PATH = 'shader-language/shader-cost-budgets.json';

export function loadShaderCostBudget(root) {
  const budget = JSON.parse(readFileSync(resolve(root, SHADER_COST_BUDGET_PATH), 'utf8'));
  if (budget.schemaVersion !== 1
    || !budget.showcase
    || !budget.production
    || !budget.production.growthBaseline
    || !budget.production.maxGrowth
    || !budget.dag) {
    throw new Error(`${SHADER_COST_BUDGET_PATH} has an invalid schema.`);
  }
  return budget;
}

export function evaluateShaderCostBudget(report, budget) {
  const checks = [];
  const violations = [];
  const cacheEntries = Array.isArray(report.cache?.entries) ? report.cache.entries : [];
  const showcaseCacheHit = cacheEntries.length > 0
    ? cacheEntries.some(entry => entry.id === 'showcase' && entry.hit === true)
    : report.cache?.hit === true;
  const productionCacheEntries = cacheEntries.filter(entry => entry.id !== 'showcase');
  const productionCacheHit = productionCacheEntries.length > 0
    ? productionCacheEntries.every(entry => entry.hit === true)
    : report.cache?.hit === true;
  check('showcase.sourceBytes', report.showcase.sourceBytes, budget.showcase.maxSourceBytes);
  check(
    'showcase.irNodeCountBeforeOptimization',
    report.showcase.irNodeCountBeforeOptimization,
    budget.showcase.maxIrNodeCountBeforeOptimization,
  );
  check(
    'showcase.irNodeCountAfterOptimization',
    report.showcase.irNodeCountAfterOptimization,
    budget.showcase.maxIrNodeCountAfterOptimization,
  );
  check('showcase.variantCount', report.showcase.variantCount, budget.showcase.maxVariantCount);
  check('showcase.pipelineCount', report.showcase.pipelineCount, budget.showcase.maxPipelineCount);
  check(
    'showcase.coldCompilationMs',
    report.showcase.coldCompilationMs,
    budget.showcase.maxColdCompilationMs,
    showcaseCacheHit,
  );
  check(
    'production.generatedWgslBytes',
    report.production.generatedWgslBytes,
    budget.production.maxGeneratedWgslBytes,
  );
  check(
    'production.generatedWgslFiles',
    report.production.generatedWgslFiles,
    budget.production.maxGeneratedWgslFiles,
  );
  check('production.variantCount', report.production.variantCount, budget.production.maxVariantCount);
  check('production.pipelineCount', report.production.pipelineCount, budget.production.maxPipelineCount);
  checkGrowth('production.generatedWgslBytesGrowth', 'generatedWgslBytes');
  checkGrowth('production.generatedWgslFilesGrowth', 'generatedWgslFiles');
  checkGrowth('production.variantCountGrowth', 'variantCount');
  checkGrowth('production.pipelineCountGrowth', 'pipelineCount');
  check(
    'production.coldGenerationMs',
    report.production.coldGenerationMs,
    budget.production.maxColdGenerationMs,
    productionCacheHit,
  );
  if (report.dag) {
    check('dag.shaderLanguageBuilds', report.dag.shaderLanguageBuilds, budget.dag.maxShaderLanguageBuilds);
    check('dag.engineBuilds', report.dag.engineBuilds, budget.dag.maxEngineBuilds);
    check('dag.extensionsBuilds', report.dag.extensionsBuilds, budget.dag.maxExtensionsBuilds);
    check(
      'dag.productionGenerationRuns',
      report.dag.productionGenerationRuns,
      budget.dag.maxProductionGenerationRuns,
    );
  }
  return {
    schemaVersion: 1,
    budget: SHADER_COST_BUDGET_PATH,
    status: violations.length === 0 ? 'passed' : 'failed',
    checks,
    violations,
  };

  function check(metric, actual, maximum, unavailableOnCacheHit = false) {
    const unavailable = unavailableOnCacheHit && actual === null;
    const entry = { metric, actual, maximum, status: unavailable ? 'cache-hit' : 'passed' };
    checks.push(entry);
    if (unavailable) return;
    if (!Number.isFinite(actual)) {
      entry.status = 'failed';
      violations.push({ ...entry, reason: 'missing' });
    } else if (actual > maximum) {
      entry.status = 'failed';
      violations.push({ ...entry, reason: 'budget-exceeded' });
    }
  }

  function checkGrowth(metric, sourceMetric) {
    const actual = report.production[sourceMetric];
    const baseline = budget.production.growthBaseline[sourceMetric];
    const maximum = budget.production.maxGrowth[sourceMetric];
    check(metric, Number.isFinite(actual) && Number.isFinite(baseline) ? actual - baseline : NaN, maximum);
  }
}

export function computeProductionCostDiff(report, budget) {
  return Object.freeze(Object.fromEntries([
    'generatedWgslBytes',
    'generatedWgslFiles',
    'variantCount',
    'pipelineCount',
  ].map(metric => [metric, Object.freeze({
    baseline: budget.production.growthBaseline[metric],
    current: report.production[metric],
    delta: report.production[metric] - budget.production.growthBaseline[metric],
    maximumGrowth: budget.production.maxGrowth[metric],
  })])));
}

export function computeHistoricalCostDiff(current, historical) {
  return Object.freeze(Object.fromEntries(Object.entries(current).map(([metric, value]) => [
    metric,
    Object.freeze({
      baseline: historical[metric],
      current: value,
      delta: Number.isFinite(value) && Number.isFinite(historical[metric])
        ? value - historical[metric]
        : null,
    }),
  ])));
}
