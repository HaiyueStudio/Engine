import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveStudioRepositoryPath } from './studio-repository-layout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

// Runtime product contracts belong to executable tests, not source-token gates.
// These files cover profile negotiation/fallback, frame-plan composition,
// PBR/shadow ownership, device recovery, readback ordering, and native glTF PBR.
for (const path of [
  'engine/test/render-product-stage9.test.mjs',
  'engine/test/render3d-gpu-driven-batch.test.mjs',
  'engine/test/lifecycle-stage4.test.mjs',
  'engine/test/readback-submit-order.test.mjs',
  'extensions/test/gltf-loader.test.mjs',
]) requireFile(path);

const manifests = [validateManifest('examples'), validateManifest('games')];
const allCapabilities = new Set(manifests.flatMap(manifest => manifest.entries.flatMap(entry => entry.capabilities)));
for (const capability of ['render-profiles', 'pbr-metallic-roughness', 'pbr-clearcoat', 'directional-shadow', 'environment-ibl', 'distance-fog', 'height-fog', 'material-variants', 'gltf', 'gpu-driven', '2d', 'gui', 'spine', 'tilemap']) {
  if (!allCapabilities.has(capability)) violations.push(`stable capability has no manifest coverage: ${capability}`);
}

for (const config of ['engine/rollup.config.js', 'extensions/rollup.config.js', 'editor/rollup.config.js', 'examples/rollup.config.js', 'games/rollup.config.js']) {
  requireSharedBuildImport(config);
}
for (const config of ['examples/rollup.config.js', 'games/rollup.config.js']) {
  requireSharedBuildImport(config, 'loadContentManifest');
  forbidCallIdentifiers(config, new Set(['readdirSync', 'existsSync']));
}
for (const script of ['scripts/build-target.mjs', 'scripts/preview-target.mjs', 'scripts/run-slow-checks.mjs']) {
  requireFile(script);
}

for (const path of [
  'examples/index.html', 'examples/catalog.js', 'examples/catalog.test.mjs',
  'docs/engine-guide/getting-started.md', 'docs/for-ai/api-stability.md',
  'docs/engine-guide/plugin-authoring.md', 'docs/engine-guide/asset-lifecycle.md',
  'docs/engine-guide/script-runtime.md', 'docs/for-ai/performance.md',
  'docs/engine-guide/device-recovery.md', 'docs/engine-guide/browser-requirements.md',
  'docs/engine-guide/render-profiles.md', 'docs/engine-guide/pbr-rendering.md',
  'docs/for-ai/capability-coverage.md', 'docs/for-ai/release-process.md',
  'docs/for-ai/lighting-shadow-scaling.md', 'docs/for-ai/adr/0014-render-product-and-delivery-contract.md',
  'docs/for-ai/adr/0020-pbr-clearcoat-capability.md',
  'docs/for-ai/adr/0021-benchmark-driven-lighting-shadow-scale.md', 'CHANGELOG.md',
]) requireFile(path);
for (const path of [
  'engine/test/fog-product-contract.test.mjs',
  'scripts/verify-fog-example.mjs',
  'review/baselines/render-pixels-fog.json',
]) requireFile(path);

for (const path of walkSources(['engine/src', 'extensions/src', 'editor/src'])) {
  const value = source(path);
  for (const match of value.matchAll(/docsPath:\s*['"]([^'"]+)['"]/g)) requireFile(`docs/api/${match[1]}.md`);
}

const matrix = json('config/release-matrix.json');
if (matrix.schemaVersion !== 1 || !matrix.browsers?.some(item => item.tier === 'required') || !matrix.deviceClasses?.some(item => item.tier === 'required')) {
  violations.push('release browser/device matrix is incomplete');
}
const performanceBudgets = json('config/webgpu-performance-budgets.json');
for (const suite of matrix.gates?.webgpuPerformanceBudgets?.requiredSuites ?? []) {
  if (!performanceBudgets.suites?.[suite]) violations.push(`release performance suite has no budget: ${suite}`);
}
const comparison = matrix.gates?.crossEnginePerformance;
if (comparison?.releaseRole !== 'blocking-portable-comparison'
  || comparison?.rankedBackend !== 'webgpu'
  || comparison?.command !== 'npm run performance:compare:formal') {
  violations.push('release matrix does not define the portable blocking cross-engine performance gate');
}
if (JSON.stringify(comparison?.requiredRankedEngines) !== JSON.stringify(['haiyue', 'three', 'babylon', 'playcanvas'])) {
  violations.push('portable comparison WebGPU ranking engine set is incomplete');
}
if (!comparison?.requiredInformationalEngines?.includes('galacean')) {
  violations.push('portable comparison does not retain Galacean as an informational WebGL2 result');
}
if (!matrix.gates?.pixelRegression?.includes('fog-distance-height')) {
  violations.push('release matrix does not require the Fog pixel regression');
}
if (!matrix.gates?.pixelRegression?.includes('pbr-clearcoat-on-off')) {
  violations.push('release matrix does not require the PBR Clearcoat pixel regression');
}
for (const token of ['PBR Clearcoat', '`pbr-showcase`', 'required glTF fixture']) {
  if (!source('docs/for-ai/capability-coverage.md').includes(token)) violations.push(`Clearcoat capability coverage misses ${token}`);
}
for (const token of ['1 / 8 / 32 / 128', 'camera + viewport + layer mask', 'mega-batch benchmark']) {
  if (!source('docs/for-ai/lighting-shadow-scaling.md').includes(token)) violations.push(`lighting/shadow scale plan misses ${token}`);
}
if (!source('package.json').includes('node scripts/verify-fog-example.mjs')) {
  violations.push('verify:render does not execute the Fog product regression');
}
for (const token of ['distance / height Fog', '`fog`', 'Basic/PBR/Blinn/Instanced']) {
  if (!source('docs/for-ai/capability-coverage.md').includes(token)) violations.push(`Fog capability coverage misses ${token}`);
}
for (const scenario of matrix.requiredScenarios ?? []) {
  if (scenario.startsWith('editor:')) continue;
  const [kind, id] = scenario.split(':');
  const manifest = manifests.find(item => item.kind === `${kind}s`);
  if (!manifest?.entries.some(entry => entry.id === id)) violations.push(`release scenario is absent from manifest: ${scenario}`);
}
for (const packagePath of ['engine/package.json', 'extensions/package.json']) {
  const pkg = json(packagePath);
  if (pkg.sideEffects !== false) violations.push(`${packagePath} must declare sideEffects false`);
  for (const [subpath, declaration] of Object.entries(pkg.exports ?? {})) {
    if (!declaration.types || !declaration.import) violations.push(`${packagePath} export ${subpath} misses types/import`);
  }
}

if (violations.length) {
  console.error('[stage9-render-product] Contract violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}
console.log(`[stage9-render-product] ${manifests.reduce((sum, item) => sum + item.entries.length, 0)} manifest targets, docs, build boundaries, exports, and release matrix structure passed.`);

function validateManifest(kind) {
  const manifest = json(`${kind}/manifest.json`);
  if (manifest.schemaVersion !== 1 || manifest.kind !== kind || !Array.isArray(manifest.entries)) violations.push(`invalid ${kind} manifest header`);
  const ids = new Set();
  for (const entry of manifest.entries ?? []) {
    if (!entry.id || ids.has(entry.id)) violations.push(`duplicate/empty ${kind} id: ${entry.id}`);
    ids.add(entry.id);
    for (const field of ['entry', 'capabilities', 'assets', 'screenshot', 'performance', 'ci']) if (!(field in entry)) violations.push(`${kind}:${entry.id} misses ${field}`);
    requireFile(`${kind}/${entry.entry}`);
    if (!['smoke', 'full', 'manual'].includes(entry.ci)) violations.push(`${kind}:${entry.id} has invalid CI level`);
    if (entry.screenshot?.required && entry.screenshot.baseline) requireFile(entry.screenshot.baseline);
    if (entry.performance?.budget) {
      requireFile(entry.performance.budget);
      const benchmark = existsSync(resolve(root, entry.performance.budget)) ? json(entry.performance.budget) : {};
      const measuredIds = (benchmark.results ?? []).map(result => result.id);
      const reconstructedIds = benchmark.evidenceStatus === 'invalidated-after-host-migration'
        ? benchmark.declaredScenarioIds ?? []
        : [];
      if (![...measuredIds, ...reconstructedIds].includes(entry.performance.scenario)) {
        violations.push(`${kind}:${entry.id} performance scenario is absent from its baseline: ${entry.performance.scenario}`);
      }
    }
  }
  const discovered = discoverMainTargets(kind);
  for (const id of discovered) if (!ids.has(id)) violations.push(`${kind}/${id}/main.ts is not in manifest`);
  for (const id of ids) if (!discovered.has(id)) violations.push(`${kind} manifest target has no directory entry: ${id}`);
  if (kind === 'examples') validateExampleCatalog(manifest);
  return manifest;
}

function validateExampleCatalog(manifest) {
  const groups = manifest.catalog?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    violations.push('examples manifest catalog.groups must be a non-empty array');
    return;
  }
  const groupIds = new Set();
  const groupOrders = new Set();
  const entryOrders = new Map();
  for (const group of groups) {
    if (!group.id || groupIds.has(group.id)) violations.push(`duplicate/empty example catalog group: ${group.id}`);
    if (!group.title || typeof group.icon !== 'string' || !Number.isInteger(group.order) || group.order < 0) {
      violations.push(`incomplete example catalog group: ${group.id}`);
    }
    if (groupOrders.has(group.order)) violations.push(`duplicate example catalog group order: ${group.order}`);
    groupIds.add(group.id);
    groupOrders.add(group.order);
    entryOrders.set(group.id, new Set());
  }
  for (const entry of manifest.entries) {
    requireFile(`examples/${entry.id}/index.html`);
    const catalog = entry.catalog;
    if (!entry.title || !catalog || !groupIds.has(catalog.group) || !Number.isInteger(catalog.order) || catalog.order < 0) {
      violations.push(`examples:${entry.id} has invalid catalog metadata`);
      continue;
    }
    const orders = entryOrders.get(catalog.group);
    if (orders.has(catalog.order)) violations.push(`examples catalog group ${catalog.group} has duplicate order ${catalog.order}`);
    orders.add(catalog.order);
  }
  for (const [groupId, orders] of entryOrders) {
    if (orders.size === 0) violations.push(`example catalog group ${groupId} is empty`);
  }
}

function discoverMainTargets(kind) {
  const result = new Set();
  const directory = resolveLogicalPath(kind);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(resolve(directory, entry.name, 'main.ts'))) result.add(entry.name);
  }
  return result;
}

function walkSources(roots) {
  const result = [];
  const visit = absolute => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = resolve(absolute, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.(ts|mjs)$/.test(entry.name)) result.push(relative(root, child));
    }
  };
  for (const path of roots) visit(resolveLogicalPath(path));
  return result;
}

function source(path) { const absolute = resolveLogicalPath(path); requireFile(path); return existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''; }
function json(path) { try { return JSON.parse(source(path)); } catch (error) { violations.push(`invalid JSON ${path}: ${error.message}`); return {}; } }
function requireFile(path) { const absolute = resolveLogicalPath(path); if (!existsSync(absolute) || !statSync(absolute).isFile()) violations.push(`missing ${path}`); }

function resolveLogicalPath(path) {
  if (path === 'games/rollup.config.js') return resolveStudioRepositoryPath('Games', 'rollup.config.js');
  if (path === 'games') return resolveStudioRepositoryPath('Games', 'games');
  if (path.startsWith('games/')) {
    return resolveStudioRepositoryPath('Games', 'games', path.slice('games/'.length));
  }
  if (path.startsWith('editor/')) {
    return resolveStudioRepositoryPath('Editor', 'editor', path.slice('editor/'.length));
  }
  if (path.startsWith('ui/')) {
    return resolveStudioRepositoryPath('UI', path.slice('ui/'.length));
  }
  return resolve(root, path);
}

function parseModule(path) {
  return ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function requireSharedBuildImport(path, binding = null) {
  const module = parseModule(path);
  const imports = module.statements.filter(ts.isImportDeclaration);
  const shared = imports.find(statement => (
    ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text.endsWith('/config/rollup.shared.js')
  ));
  if (!shared) {
    violations.push(`${path} bypasses shared build policy`);
    return;
  }
  if (!binding) return;
  const named = shared.importClause?.namedBindings;
  const imported = named && ts.isNamedImports(named)
    ? named.elements.some(element => (element.propertyName ?? element.name).text === binding)
    : false;
  if (!imported) violations.push(`${path} does not import ${binding} from the shared manifest build policy`);
}

function forbidCallIdentifiers(path, forbidden) {
  const module = parseModule(path);
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && forbidden.has(node.expression.text)) {
      violations.push(`${path} still scans directories through ${node.expression.text}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
}
