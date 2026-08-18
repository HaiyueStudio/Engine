import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkShaderMigrationManifest } from './check-migration-manifest.mjs';
import { generateProductionShaders, PRODUCTION_SHADER_GENERATORS } from './generate-production-shaders.mjs';
import { generateShaderLanguageShowcaseExample } from './generate-showcase-example.mjs';
import { computeProductionCostDiff, evaluateShaderCostBudget, loadShaderCostBudget } from './shader-cost-policy.mjs';
import { generateRuntimeArtifactContract } from './generate-runtime-artifact-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cachePath = resolve(root, 'artifacts/cache/shader-language/generation-v2.json');
const reportPath = resolve(root, 'artifacts/shader-language/shader-cost.json');
const showcasePath = resolve(root, 'examples/shader-language-lab/generated/showcase.generated.ts');
const compilerInputs = Object.freeze(['shader-language/dist']);

export const PRODUCTION_CACHE_SCOPES = Object.freeze([
  scope('motion-blur', 2,
    ['shader-language/scripts/generate-motion-blur-production.mjs', 'shader-language/pilot-motion-blur-postprocess.graph.json', 'shader-language/stage5-contract.json'],
    ['engine/src/shaders/generated/motion-']),
  scope('builtin-postprocess', 2,
    ['shader-language/scripts/generate-builtin-postprocess-production.mjs', 'shader-language/builtin-postprocess-family.json'],
    ['engine/src/shaders/generated/postprocess-']),
  scope('builtin-render', 2,
    ['shader-language/scripts/generate-builtin-render-production.mjs', 'shader-language/builtin-engine-2d-ui-family.json', 'shader-language/builtin-components-2d-ui-family.json', 'shader-language/builtin-simple-3d-runtime-family.json'],
    ['engine/src/shaders/generated/2d-ui-', 'extensions/src/shaders/generated/2d-ui-', 'engine/src/shaders/generated/simple3d-']),
  scope('deformation', 2,
    ['shader-language/scripts/generate-deformation-production.mjs', 'shader-language/builtin-deformation-family.json'],
    ['engine/src/shaders/generated/deformation-']),
  scope('material-lighting', 2,
    ['shader-language/scripts/generate-material-lighting-production.mjs', 'shader-language/builtin-material-lighting-family.json'],
    ['engine/src/shaders/generated/material-lighting-']),
  scope('specialized-rendering', 2,
    ['shader-language/scripts/generate-specialized-rendering-production.mjs', 'shader-language/builtin-specialized-rendering-family.json'],
    ['engine/src/shaders/generated/specialized-']),
  scope('compute', 2,
    ['shader-language/scripts/generate-compute-production.mjs', 'shader-language/builtin-compute-family.json'],
    ['engine/src/shaders/generated/compute-']),
]);

const showcaseScope = scope('showcase', 1,
  ['shader-language/scripts/generate-showcase-example.mjs', 'shader-language/pilot-pbr-composition.graph.json'],
  ['examples/shader-language-lab/generated/showcase.generated.ts']);

export async function verifyProductionShaderCache() {
  await generateRuntimeArtifactContract({ write: false });
  await checkShaderMigrationManifest();
  assertCacheRegistryMatchesGenerators();
  const cached = await readJson(cachePath);
  const generatedFiles = await collectGeneratedOutputFiles();
  const entries = [];
  const productionResults = [];
  let coldGenerationMs = null;

  for (const cacheScope of PRODUCTION_CACHE_SCOPES) {
    const inputFiles = await collectExistingFiles([...compilerInputs, ...cacheScope.inputs]);
    const outputFiles = filesForScope(generatedFiles, cacheScope);
    const inputHash = await hashFiles(inputFiles, `${cacheScope.id}@${cacheScope.artifactVersion}`);
    const outputHashBefore = await hashFiles(outputFiles, cacheScope.id);
    const previous = cached?.schemaVersion === 2 ? cached.entries?.[cacheScope.id] : null;
    const hit = cacheEntryMatches(previous, inputHash, outputHashBefore);
    let result = previous?.result ?? null;
    let durationMs = null;
    if (!hit) {
      const startedAt = performance.now();
      [result] = await generateProductionShaders({ write: false, only: cacheScope.id });
      durationMs = performance.now() - startedAt;
      coldGenerationMs = (coldGenerationMs ?? 0) + durationMs;
    }
    if (!result) throw new Error(`Shader generator cache entry ${cacheScope.id} has no result.`);
    const outputHash = await hashFiles(filesForScope(await collectGeneratedOutputFiles(), cacheScope), cacheScope.id);
    entries.push({ id: cacheScope.id, hit, inputHash, outputHash, durationMs, result });
    productionResults.push(result);
  }

  const showcaseInputFiles = await collectExistingFiles([...compilerInputs, ...showcaseScope.inputs]);
  const showcaseOutputFiles = filesForScope(await collectGeneratedOutputFiles(), showcaseScope);
  const showcaseInputHash = await hashFiles(showcaseInputFiles, `${showcaseScope.id}@${showcaseScope.artifactVersion}`);
  const showcaseOutputHashBefore = await hashFiles(showcaseOutputFiles, showcaseScope.id);
  const previousShowcase = cached?.schemaVersion === 2 ? cached.entries?.showcase : null;
  const showcaseHit = cacheEntryMatches(previousShowcase, showcaseInputHash, showcaseOutputHashBefore);
  let showcaseMetrics;
  let coldCompilationMs = null;
  if (showcaseHit) {
    showcaseMetrics = await readShowcaseMetrics();
  } else {
    const startedAt = performance.now();
    const showcase = await generateShaderLanguageShowcaseExample({ write: false });
    coldCompilationMs = performance.now() - startedAt;
    showcaseMetrics = showcase.metrics;
  }
  const showcaseOutputHash = await hashFiles(filesForScope(await collectGeneratedOutputFiles(), showcaseScope), showcaseScope.id);
  entries.push({
    id: showcaseScope.id,
    hit: showcaseHit,
    inputHash: showcaseInputHash,
    outputHash: showcaseOutputHash,
    durationMs: coldCompilationMs,
    result: { metrics: showcaseMetrics },
  });

  const verifiedOutputFiles = await collectGeneratedOutputFiles();
  const generatedWgsl = verifiedOutputFiles.filter(path => path.endsWith('.generated.wgsl'));
  const generatedWgslBytes = await sumFileBytes(generatedWgsl);
  const passCount = productionResults.reduce((total, result) => total + Number(result.passCount ?? 0), 0);
  const cacheHit = entries.every(entry => entry.hit);
  const inputHash = hashValues(entries.map(entry => `${entry.id}:${entry.inputHash}`));
  const outputHash = hashValues(entries.map(entry => `${entry.id}:${entry.outputHash}`));
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    cache: {
      kind: 'content-addressed-family-input-and-output',
      hit: cacheHit,
      hitCount: entries.filter(entry => entry.hit).length,
      missCount: entries.filter(entry => !entry.hit).length,
      inputHash,
      outputHash,
      path: repositoryPath(cachePath),
      entries: entries.map(({ result: _result, ...entry }) => entry),
    },
    showcase: {
      sourceBytes: showcaseMetrics.sourceBytes,
      irNodeCountBeforeOptimization: showcaseMetrics.irNodeCountBeforeOptimization,
      irNodeCountAfterOptimization: showcaseMetrics.irNodeCountAfterOptimization,
      variantCount: showcaseMetrics.variantCount,
      pipelineCount: showcaseMetrics.pipelineCount,
      coldCompilationMs,
    },
    production: {
      generatedWgslBytes,
      generatedWgslFiles: generatedWgsl.length,
      variantCount: passCount,
      pipelineCount: passCount,
      coldGenerationMs,
      generatorRuns: entries.filter(entry => entry.id !== 'showcase' && !entry.hit).length,
      generators: productionResults.map(result => ({
        id: result.id,
        passCount: result.passCount ?? 0,
        outputCount: result.outputCount ?? 0,
        artifactHash: result.artifactHash ?? null,
      })),
    },
  };
  const costBudget = loadShaderCostBudget(root);
  report.production.costDiff = computeProductionCostDiff(report, costBudget);
  report.budget = evaluateShaderCostBudget(report, costBudget);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.budget.status !== 'passed') {
    throw new Error(`Shader cost budget failed:\n- ${report.budget.violations.map(item => `${item.metric}: ${item.reason} (${item.actual} > ${item.maximum})`).join('\n- ')}`);
  }
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({
    schemaVersion: 2,
    entries: Object.fromEntries(entries.map(entry => [entry.id, {
      inputHash: entry.inputHash,
      outputHash: entry.outputHash,
      result: entry.result,
    }])),
  }, null, 2)}\n`);
  console.log(
    `[shader-language:cache] ${entries.filter(entry => entry.hit).length}/${entries.length} family entries hit; `
    + `${generatedWgsl.length} WGSL files/${generatedWgslBytes} bytes, `
    + `${passCount} variants/pipelines; cost budget passed.`,
  );
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyProductionShaderCache();
}

export function cacheEntryMatches(entry, inputHash, outputHash) {
  return entry?.inputHash === inputHash && entry?.outputHash === outputHash;
}

function scope(id, artifactVersion, inputs, outputPrefixes) {
  return Object.freeze({ id, artifactVersion, inputs: Object.freeze(inputs), outputPrefixes: Object.freeze(outputPrefixes) });
}

function assertCacheRegistryMatchesGenerators() {
  const registered = PRODUCTION_SHADER_GENERATORS.map(generator => `${generator.id}@${generator.artifactVersion}`).sort();
  const cached = PRODUCTION_CACHE_SCOPES.map(entry => `${entry.id}@${entry.artifactVersion}`).sort();
  if (JSON.stringify(registered) !== JSON.stringify(cached)) {
    throw new Error(`Production cache scopes do not match generator registry: ${cached.join(', ')} != ${registered.join(', ')}.`);
  }
}

async function collectGeneratedOutputFiles() {
  return collectExistingFiles([
    'engine/src/shaders/generated',
    'extensions/src/shaders/generated',
    'examples/shader-language-lab/generated/showcase.generated.ts',
  ]);
}

function filesForScope(files, cacheScope) {
  return files.filter(path => {
    const repository = repositoryPath(path);
    return cacheScope.outputPrefixes.some(prefix => repository.startsWith(prefix));
  });
}

async function collectExistingFiles(paths) {
  const files = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) continue;
    const metadata = await stat(absolute);
    if (metadata.isFile()) files.push(absolute);
    else files.push(...await walk(absolute));
  }
  return [...new Set(files)].sort((left, right) => repositoryPath(left).localeCompare(repositoryPath(right)));
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function hashFiles(files, salt = '') {
  const hash = createHash('sha256');
  hash.update(salt);
  hash.update('\0');
  for (const path of files) {
    hash.update(repositoryPath(path));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function hashValues(values) {
  const hash = createHash('sha256');
  for (const value of values) {
    hash.update(value);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function sumFileBytes(files) {
  let total = 0;
  for (const path of files) total += (await stat(path)).size;
  return total;
}

async function readShowcaseMetrics() {
  const source = await readFile(showcasePath, 'utf8');
  const prefix = 'export const SHADER_LANGUAGE_SHOWCASE = ';
  const start = source.indexOf(prefix);
  const end = source.lastIndexOf(' as const;');
  if (start < 0 || end < 0) throw new Error('Generated Shader Language showcase has an invalid module envelope.');
  return JSON.parse(source.slice(start + prefix.length, end)).metrics;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

function repositoryPath(path) {
  return relative(root, path).split(sep).join('/');
}
