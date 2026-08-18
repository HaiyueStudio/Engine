import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(root, 'engine/src');
const files = collectFiles(sourceRoot);
const graph = new Map(files.map(file => [file, []]));
const violations = [];

for (const file of files) {
  for (const specifier of collectSpecifiers(file)) {
    const target = resolveSourceModule(file, specifier);
    if (!target || !graph.has(target)) continue;
    graph.get(file).push(target);
    validateLayerRule(file, target);
  }
}

for (const cycle of findCycles(graph)) {
  violations.push(`module cycle: ${cycle.map(file => relative(sourceRoot, file)).join(' -> ')}`);
}

if (violations.length > 0) {
  console.error('[engine-modules] Module boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`[engine-modules] ${files.length} modules checked: no cycles or reverse facade dependencies.`);

function validateLayerRule(file, target) {
  const from = relative(sourceRoot, file).replaceAll('\\', '/');
  const to = relative(sourceRoot, target).replaceAll('\\', '/');
  if (from.startsWith('scene/internal/') && to === 'scene/Scene.ts') {
    violations.push(`${from} imports concrete facade ${to}`);
  }
  if (from === 'renderer/RenderPipeline.ts') {
    const allowed = new Set([
      'core/IEngine.ts',
      'core/EngineDiagnosticsAccess.ts',
      'core/RenderCommandContext.ts',
      'core/RenderView.ts',
      'core/renderPassDescriptor.ts',
      'ecs/World.ts',
      'renderer/frame-plan/RenderFramePlan.ts',
      'renderer/frame-plan/RenderPassCompatibility.ts',
    ]);
    if (!allowed.has(to)) violations.push(`${from} imports non-contract module ${to}`);
  }
  if (from.startsWith('core/') && from !== 'core/Engine.ts' && to === 'scene/Scene.ts') {
    violations.push(`${from} reverses the core -> scene facade dependency`);
  }
}

function collectFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) result.push(path);
  }
  return result.sort();
}

function collectSpecifiers(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result = [];
  visit(source);
  return result;

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (hasRuntimeImport(node.importClause)) result.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (hasRuntimeExport(node)) result.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
}

function hasRuntimeImport(clause) {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some(element => !element.isTypeOnly);
}

function hasRuntimeExport(node) {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true;
  return node.exportClause.elements.some(element => !element.isTypeOnly);
}

function resolveSourceModule(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const raw = resolve(dirname(importer), specifier);
  const candidates = [raw, `${raw}.ts`, `${raw}.tsx`, resolve(raw, 'index.ts')];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function findCycles(moduleGraph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const reported = new Set();
  const cycles = [];
  for (const file of moduleGraph.keys()) visit(file);
  return cycles;

  function visit(file) {
    if (visited.has(file)) return;
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      const cycle = [...stack.slice(start), file];
      const key = [...new Set(cycle)].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        cycles.push(cycle);
      }
      return;
    }
    visiting.add(file);
    stack.push(file);
    for (const target of moduleGraph.get(file) ?? []) visit(target);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }
}
