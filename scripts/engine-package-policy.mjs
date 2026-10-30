import ts from 'typescript';
import { validateConsumerLoadingPolicy } from './engine-package-loading-policy.mjs';

export function parsePackageVerificationArgs(args) {
  let release = false, outputDirectory;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--release' && !release) release = true;
    else if (argument === '--output-dir' && outputDirectory === undefined) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--output-dir requires a directory');
      outputDirectory = value;
    } else throw new Error(`Unknown or duplicate public package verification argument "${argument}".`);
  }
  return { release, outputDirectory };
}

const FORBIDDEN_PACKAGE_PATHS = Object.freeze([
  'node_modules/@dimforge/rapier3d-compat/',
  'node_modules/box2d.ts/',
]);

const FORBIDDEN_OUTPUT_MARKERS = Object.freeze([
  '@dimforge/rapier3d-compat',
  'RapierPhysics3DBackend',
  'box2d.ts',
  'Box2DPhysics2DBackend',
  'class AmbientOcclusionPass',
  'class GtaoPass',
  'class SaoPass',
  'class SsaoPass',
  'haiyue:builtin-postprocess gtao',
  'haiyue:builtin-postprocess sao',
  'haiyue:builtin-postprocess ssao',
]);

export function validateEnginePackManifest({
  manifest,
  packageJson,
  budget,
  requirePublishMetadata = false,
}) {
  const errors = [];
  const files = manifest.files.map(file => file.path).sort();
  const allowedPatterns = budget.tarball.allowedFilePatterns;
  const declaredWhitelist = packageJson.files ?? [];

  if (packageJson.sideEffects !== false) {
    errors.push('engine package must declare sideEffects=false for consumer tree-shaking');
  }
  if (JSON.stringify(declaredWhitelist) !== JSON.stringify(budget.tarball.filesWhitelist)) {
    errors.push('engine package files whitelist disagrees with config/engine-package-budget.json');
  }
  for (const file of files) {
    if (!allowedPatterns.some(pattern => matchesPackageGlob(file, pattern))) {
      errors.push(`tarball contains a non-publish file: ${file}`);
    }
    if (isExplicitlyForbiddenPublishedFile(file)) {
      errors.push(`tarball contains a forbidden release artifact: ${file}`);
    }
  }
  errors.push(...validatePackageByteBudget(manifest, budget.tarball, 'tarball'));

  const requiredTargets = collectPackageTargets(packageJson);
  const published = new Set(files);
  for (const target of requiredTargets) {
    if (!published.has(target)) errors.push(`published package target is missing: ${target}`);
  }

  const pendingProjectInputs = [];
  if (!packageJson.repository) pendingProjectInputs.push('repository');
  if (!packageJson.license) pendingProjectInputs.push('license');
  if (!files.some(file => /^readme(?:\.|$)/i.test(file))) pendingProjectInputs.push('README');
  if (!packageJson.engines?.node) pendingProjectInputs.push('engines.node');
  if (requirePublishMetadata && pendingProjectInputs.length > 0) {
    errors.push(`engine publish metadata is incomplete: ${pendingProjectInputs.join(', ')}`);
  }

  return {
    errors,
    files,
    requiredTargets,
    pendingProjectInputs,
  };
}

export function validateCapabilityPackageBudgetConfig(budget) {
  const errors = [];
  for (const section of ['consumers', 'animationSpecConsumers', 'extensionConsumers', 'shaderLanguageConsumers']) {
    for (const [id, policy] of Object.entries(budget[section] ?? {})) {
      const review = policy.capacityReview;
      if (!review) continue; // Existing schema-4 consumers retain their historical contract.
      if (!Number.isSafeInteger(review.reviewedGzipBytes) || review.reviewedGzipBytes <= 0
        || !Number.isSafeInteger(review.growthReserveBytes) || review.growthReserveBytes <= 0
        || policy.maxGzipBytes !== review.reviewedGzipBytes + review.growthReserveBytes
        || typeof review.capabilityBasis !== 'string' || !review.capabilityBasis.trim()
        || typeof review.decision !== 'string' || !review.decision.trim()) {
        errors.push(`${id} reviewed gzip capacity requires measured bytes, positive reserve, capability basis and decision`);
      }
    }
  }
  for (const [id, policy] of Object.entries(budget.extensionConsumers ?? {})) {
    if (policy.loading) errors.push(...validateConsumerLoadingPolicy(policy.loading, policy.maxGzipBytes)
      .map(error => `${id}: ${error}`));
  }
  if (budget.schemaVersion !== 4
    || budget.budgetPolicy?.model !== 'reviewed-capability-plus-growth-reserve'
    || budget.budgetPolicy?.fileCount !== 'observe-only') {
    errors.push('public package budget must use schemaVersion 4 with observe-only file counts');
  }
  for (const [packageName, policy] of Object.entries(budget.publicPackages ?? {})) {
    const reviewed = policy.capacity?.reviewed;
    const reserve = policy.capacity?.growthReserve;
    if (!reviewed || !reserve || !policy.capacity?.capabilityBasis) {
      errors.push(`${packageName} is missing reviewed capacity, growth reserve, or capability basis`);
      continue;
    }
    for (const [maximumField, reviewedField, reserveField] of [
      ['maxPackedBytes', 'packedBytes', 'packedBytes'],
      ['maxUnpackedBytes', 'unpackedBytes', 'unpackedBytes'],
    ]) {
      const maximum = policy[maximumField];
      const reviewedValue = reviewed[reviewedField];
      const reserveValue = reserve[reserveField];
      if (!Number.isInteger(maximum) || !Number.isInteger(reviewedValue) || !Number.isInteger(reserveValue)
        || maximum < 1 || reviewedValue < 1 || reserveValue < 1 || maximum !== reviewedValue + reserveValue) {
        errors.push(`${packageName} ${maximumField} must equal positive reviewed capacity plus positive growth reserve`);
      }
    }
    if ('maxFileCount' in policy || 'fileCount' in reserve) {
      errors.push(`${packageName} file counts are observations, not limits or growth reserves`);
    }
    if (!Number.isInteger(reviewed.fileCount) || reviewed.fileCount < 1) {
      errors.push(`${packageName} must retain its positive reviewed file count observation`);
    }
  }
  const engine = budget.publicPackages?.['@haiyue/engine'];
  if (engine && (budget.tarball?.maxPackedBytes !== engine.maxPackedBytes
    || budget.tarball?.maxUnpackedBytes !== engine.maxUnpackedBytes)) {
    errors.push('legacy engine tarball limits must match the capability-attributed @haiyue/engine envelope');
  }
  if (budget.tarball && 'maxFileCount' in budget.tarball) errors.push('legacy engine tarball cannot impose a file count limit');
  return errors;
}

/** File count is reported by the producer; only byte capacity constrains packing. */
export function validatePackageByteBudget(manifest, policy, label) {
  const errors = [];
  for (const [field, maximum, metric] of [
    ['size', 'maxPackedBytes', 'packed'], ['unpackedSize', 'maxUnpackedBytes', 'unpacked'],
  ]) {
    if (!Number.isSafeInteger(manifest[field]) || manifest[field] < 0) errors.push(`${label} has invalid ${metric} bytes`);
    else if (manifest[field] > policy[maximum]) errors.push(`${label} ${metric} ${manifest[field]}B exceeds ${policy[maximum]}B`);
  }
  return errors;
}

/** Stable capabilities must be exercised through their actual published subpath. */
export function validateExtensionConsumerCoverage({ packageJson, capabilities, consumers, fixtures }) {
  const errors = [], covered = new Set();
  const groups = capabilities.packages?.[packageJson.name]?.groups ?? [];
  const stable = groups.filter(group => group.stability === 'stable').flatMap(group => Object.keys(group.entrypoints));
  if (stable.length === 0) errors.push(`${packageJson.name} has no admitted stable capabilities`);
  for (const entrypoint of stable) {
    const target = packageJson.exports?.[entrypoint];
    if (!target?.types || !target?.import) errors.push(`${packageJson.name}${entrypoint.slice(1)} lacks a public runtime or declaration target`);
  }
  for (const [id, policy] of Object.entries(consumers)) {
    if (policy.packageName !== packageJson.name || !packageJson.exports?.[policy.entrypoint]) {
      errors.push(`${id} must identify an existing ${packageJson.name} entrypoint`);
      continue;
    }
    const specifier = policy.entrypoint === '.' ? packageJson.name : packageJson.name + policy.entrypoint.slice(1);
    const source = ts.createSourceFile(`${id}.mjs`, fixtures[id] ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = source.statements
      .filter(statement => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      .map(statement => statement.moduleSpecifier)
      .filter(value => value && ts.isStringLiteral(value))
      .map(value => value.text);
    if (!Array.isArray(policy.requiredExports) || policy.requiredExports.length === 0) {
      errors.push(`${id} must retain at least one runtime export in its focused consumer`);
    }
    if (!imports.includes(specifier)) errors.push(`${id} fixture must import its declared capability ${specifier}`);
    else covered.add(policy.entrypoint);
  }
  for (const entrypoint of stable) {
    if (!covered.has(entrypoint)) errors.push(`${packageJson.name}${entrypoint.slice(1)} lacks a focused packed consumer`);
  }
  return errors;
}

export function collectPublicTypeEntrypoints(packages) {
  return packages.flatMap(packageJson => Object.entries(packageJson.exports ?? {})
    .filter(([, target]) => typeof target?.types === 'string')
    .map(([path]) => path === '.' ? packageJson.name : packageJson.name + path.slice(1)));
}

export function validateEngineConsumerResult(result, policy) {
  const errors = [];
  if (result.gzipBytes > policy.maxGzipBytes) {
    errors.push(`${result.id} gzip ${result.gzipBytes}B exceeds ${policy.maxGzipBytes}B`);
  }
  for (const requiredExport of policy.requiredExports) {
    if (!result.exports.includes(requiredExport)) {
      errors.push(`${result.id} is missing retained export ${requiredExport}`);
    }
  }
  for (const forbiddenPath of FORBIDDEN_PACKAGE_PATHS) {
    if (result.modules.some(moduleId => moduleId.includes(forbiddenPath))) {
      errors.push(`${result.id} bundled forbidden package ${forbiddenPath}`);
    }
  }
  for (const marker of FORBIDDEN_OUTPUT_MARKERS) {
    if (result.code.includes(marker)) {
      errors.push(`${result.id} bundled forbidden output marker ${marker}`);
    }
  }
  const allowedArtifacts = new Set(policy.allowedGeneratedShaderArtifacts);
  for (const artifact of result.generatedShaderArtifacts) {
    if (!allowedArtifacts.has(artifact)) {
      errors.push(`${result.id} bundled unrelated generated shader ${artifact}`);
    }
  }
  if (!result.modules.some(moduleId => moduleId.startsWith('@haiyue/engine/dist/'))) {
    errors.push(`${result.id} did not resolve modules from the packed engine tarball`);
  }
  if (result.imports.length > 0 || result.dynamicImports.length > 0) {
    errors.push(
      `${result.id} emitted unresolved imports: ${[...result.imports, ...result.dynamicImports].join(', ')}`,
    );
  }
  return errors;
}

export function matchesPackageGlob(path, glob) {
  let pattern = '^';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index++;
      }
    } else if (character === '*') {
      pattern += '[^/]*';
    } else {
      pattern += escapeRegExp(character);
    }
  }
  return new RegExp(`${pattern}$`).test(path);
}

function collectPackageTargets(packageJson) {
  const targets = new Set();
  for (const field of ['main', 'module', 'types']) {
    if (typeof packageJson[field] === 'string') targets.add(normalizeTarget(packageJson[field]));
  }
  for (const target of Object.values(packageJson.exports ?? {})) {
    if (typeof target === 'string') {
      targets.add(normalizeTarget(target));
      continue;
    }
    for (const value of Object.values(target ?? {})) {
      if (typeof value === 'string') targets.add(normalizeTarget(value));
    }
  }
  return [...targets].sort();
}

function normalizeTarget(path) {
  return path.startsWith('./') ? path.slice(2) : path;
}

function isExplicitlyForbiddenPublishedFile(path) {
  return path.endsWith('.map')
    || path === '.DS_Store'
    || path.startsWith('.claude/')
    || path.startsWith('devLog/')
    || path.startsWith('src/')
    || path.startsWith('test/')
    || /\.(?:jpe?g|png|webp|gif)$/i.test(path);
}

function escapeRegExp(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}
