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
  if (manifest.size > budget.tarball.maxPackedBytes) {
    errors.push(`tarball gzip ${manifest.size}B exceeds ${budget.tarball.maxPackedBytes}B`);
  }
  if (manifest.unpackedSize > budget.tarball.maxUnpackedBytes) {
    errors.push(`tarball unpacked ${manifest.unpackedSize}B exceeds ${budget.tarball.maxUnpackedBytes}B`);
  }
  if (files.length > budget.tarball.maxFileCount) {
    errors.push(`tarball file count ${files.length} exceeds ${budget.tarball.maxFileCount}`);
  }

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
  if (budget.schemaVersion !== 3
    || budget.budgetPolicy?.model !== 'reviewed-capability-plus-growth-reserve') {
    errors.push('public package budget must use the capability-attributed schemaVersion 3 model');
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
      ['maxFileCount', 'fileCount', 'fileCount'],
    ]) {
      const maximum = policy[maximumField];
      const reviewedValue = reviewed[reviewedField];
      const reserveValue = reserve[reserveField];
      if (!Number.isInteger(maximum) || !Number.isInteger(reviewedValue) || !Number.isInteger(reserveValue)
        || maximum < 1 || reviewedValue < 1 || reserveValue < 1 || maximum !== reviewedValue + reserveValue) {
        errors.push(`${packageName} ${maximumField} must equal positive reviewed capacity plus positive growth reserve`);
      }
    }
  }
  const engine = budget.publicPackages?.['@haiyue/engine'];
  if (engine && (budget.tarball?.maxPackedBytes !== engine.maxPackedBytes
    || budget.tarball?.maxUnpackedBytes !== engine.maxUnpackedBytes
    || budget.tarball?.maxFileCount !== engine.maxFileCount)) {
    errors.push('legacy engine tarball limits must match the capability-attributed @haiyue/engine envelope');
  }
  return errors;
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
