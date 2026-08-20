import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveStudioRepositoryPath } from './studio-repository-layout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectories = ['engine', 'extensions'];
const sourceDirectories = ['engine/src', 'extensions/src', 'ui/src', 'editor/src', 'examples', 'games'];
const explicitAnyAdapters = new Map([
  ['extensions/src/spine/Spine2DRuntime.ts', 'Dynamic Spine timeline adapter; normalized data stays inside the Spine runtime.'],
  ['extensions/src/spine/SpinePathConstraintSolver.ts', 'Dynamic Spine path timeline adapter.'],
  ['extensions/src/spine/SpineSkeletonRuntime.ts', 'Dynamic third-party Spine JSON normalization adapter.'],
  ['editor/src/export/templates/runtimeDeserializationTemplate.ts', 'Generated runtime-scene deserialization adapter.'],
  ['editor/src/export/templates/runtimePlayerTemplate.ts', 'Generated trusted-script runtime API adapter.'],
  ['examples/live2d-hya-compare/main.ts', 'Licensed Cubism Core is an optional browser global without public TypeScript declarations.'],
]);
const publicFailurePaths = [
  'engine/src/core',
  'engine/src/assets/AssetWorkerClient.ts',
  'extensions/src/gltf/gltfLoader.ts',
  'extensions/src/gltf/GltfAssetWorkerClient.ts',
  'extensions/src/spine/Spine2DRuntime.ts',
  'extensions/src/spine/Spine2DGpuRenderer.ts',
  'extensions/src/spine/SpineAtlasParser.ts',
  'editor/src/domain/scene/deserialization.ts',
  'editor/src/domain/store/EditorStore.ts',
  'editor/src/infra/app/appEvents.ts',
  'editor/src/infra/file/importedGltfSource.ts',
  'editor/src/player.ts',
  'editor/src/play/playSession.ts',
];

const failures = [];
checkStrictRoot();
checkExactOptionalProperties();
checkExplicitAnySources();
checkPublicDeclarations();
checkPublicFailurePaths();

if (failures.length > 0) {
  console.error('[stage3-contracts] Contract regression detected:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[stage3-contracts] strict/exact root, engine config inheritance, public declarations, ${explicitAnyAdapters.size} registered adapters, and public failure paths are clean.`);

function checkStrictRoot() {
  const config = JSON.parse(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8'));
  if (config.compilerOptions?.strict !== true) failures.push('tsconfig.base.json must keep compilerOptions.strict=true.');
  if (config.compilerOptions?.useUnknownInCatchVariables !== true) {
    failures.push('tsconfig.base.json must keep compilerOptions.useUnknownInCatchVariables=true.');
  }
}

function checkExactOptionalProperties() {
  const rootConfig = JSON.parse(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8'));
  if (rootConfig.compilerOptions?.exactOptionalPropertyTypes !== true) {
    failures.push('tsconfig.base.json must keep compilerOptions.exactOptionalPropertyTypes=true for dependent workspaces.');
  }
  const engineConfig = JSON.parse(readFileSync(resolve(root, 'engine/tsconfig.json'), 'utf8'));
  if (engineConfig.extends !== '../tsconfig.base.json') {
    failures.push('engine/tsconfig.json must inherit strict options from ../tsconfig.base.json.');
  }
  if (Object.hasOwn(engineConfig.compilerOptions ?? {}, 'exactOptionalPropertyTypes')) {
    failures.push('engine/tsconfig.json must not override root compilerOptions.exactOptionalPropertyTypes.');
  }
}

function checkExplicitAnySources() {
  for (const directory of sourceDirectories) {
    const absolute = resolveLogicalPath(directory);
    if (!existsSync(absolute)) continue;
    for (const file of walkTypeScriptFiles(absolute)) {
      const path = logicalPathFor(file);
      const anyNodes = findSyntax(file, node => node.kind === ts.SyntaxKind.AnyKeyword);
      const generatedAnyCount = path.startsWith('editor/src/export/')
        ? readFileSync(file, 'utf8').match(/\bany\b/g)?.length ?? 0
        : 0;
      const anyCount = Math.max(anyNodes.length, generatedAnyCount);
      if (anyCount === 0) continue;
      if (!explicitAnyAdapters.has(path)) {
        failures.push(`${path} contains ${anyCount} unregistered explicit any occurrence(s).`);
      }
    }
  }
  for (const path of explicitAnyAdapters.keys()) {
    if (!existsSync(resolveLogicalPath(path))) failures.push(`Registered any adapter no longer exists: ${path}.`);
  }
}

function checkPublicDeclarations() {
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'));
    for (const target of declarationEntrypoints(manifest)) {
      const entry = resolve(root, directory, target.replace(/^\.\//, ''));
      if (!existsSync(entry)) {
        failures.push(`Missing built declaration entrypoint ${relative(root, entry)}; build engine/extensions before this check.`);
        continue;
      }
      for (const file of collectDeclarationGraph(entry)) {
        for (const node of findSyntax(file, item => item.kind === ts.SyntaxKind.AnyKeyword)) {
          failures.push(`${formatLocation(file, node)} exposes unconstrained any through ${relative(root, entry)}.`);
        }
      }
    }
  }
}

function checkPublicFailurePaths() {
  for (const path of publicFailurePaths) {
    const absolute = resolveLogicalPath(path);
    const files = statSync(absolute).isDirectory() ? walkTypeScriptFiles(absolute) : [absolute];
    for (const file of files) {
      for (const node of findSyntax(file, isBareErrorFailure)) {
        failures.push(`${formatLocation(file, node)} uses a bare Error on a public failure path.`);
      }
    }
  }
}

function isBareErrorFailure(node) {
  if (ts.isThrowStatement(node)) return isNewError(node.expression);
  if (!ts.isCallExpression(node) || node.arguments.length === 0 || !isNewError(node.arguments[0])) return false;
  return ts.isIdentifier(node.expression) && node.expression.text === 'reject';
}

function isNewError(node) {
  return node !== undefined
    && ts.isNewExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'Error';
}

function declarationEntrypoints(manifest) {
  if (!manifest.exports) return [manifest.types];
  return Object.values(manifest.exports)
    .map(value => typeof value === 'string' ? value : value.types)
    .filter(value => typeof value === 'string');
}

function collectDeclarationGraph(entry) {
  const visited = new Set();
  visit(entry);
  return visited;

  function visit(file) {
    const canonical = resolve(file);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const source = parse(canonical);
    for (const statement of source.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier
        || !ts.isStringLiteralLike(statement.moduleSpecifier)
        || !statement.moduleSpecifier.text.startsWith('.')) continue;
      const dependency = resolveDeclaration(canonical, statement.moduleSpecifier.text);
      if (dependency) visit(dependency);
    }
  }
}

function resolveDeclaration(importer, specifier) {
  const raw = resolve(dirname(importer), specifier);
  const candidates = [raw, `${raw}.d.ts`, resolve(raw, 'index.d.ts')];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
}

function walkTypeScriptFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkTypeScriptFiles(path));
    else if (/\.tsx?$/.test(entry.name)) result.push(path);
  }
  return result;
}

function findSyntax(file, predicate) {
  const source = parse(file);
  const matches = [];
  visit(source);
  return matches;

  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
}

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function formatLocation(file, node) {
  const source = node.getSourceFile();
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${logicalPathFor(file)}:${position.line + 1}`;
}

function resolveLogicalPath(path) {
  if (path.startsWith('editor/')) {
    return resolveStudioRepositoryPath('Editor', 'editor', path.slice('editor/'.length));
  }
  if (path.startsWith('voxelEditor/')) {
    return resolveStudioRepositoryPath('Editor', 'voxelEditor', path.slice('voxelEditor/'.length));
  }
  if (path.startsWith('ui/')) {
    return resolveStudioRepositoryPath('UI', path.slice('ui/'.length));
  }
  if (path.startsWith('games/')) {
    return resolveStudioRepositoryPath('Games', 'games', path.slice('games/'.length));
  }
  return resolve(root, path);
}

function logicalPathFor(file) {
  const editorSourceRoot = resolveStudioRepositoryPath('Editor', 'editor');
  const voxelEditorRoot = resolveStudioRepositoryPath('Editor', 'voxelEditor');
  const uiRoot = resolveStudioRepositoryPath('UI');
  const gamesRoot = resolveStudioRepositoryPath('Games', 'games');
  if (file.startsWith(editorSourceRoot)) return normalize(`editor/${relative(editorSourceRoot, file)}`);
  if (file.startsWith(voxelEditorRoot)) return normalize(`voxelEditor/${relative(voxelEditorRoot, file)}`);
  if (file.startsWith(uiRoot)) return normalize(`ui/${relative(uiRoot, file)}`);
  if (file.startsWith(gamesRoot)) return normalize(`games/${relative(gamesRoot, file)}`);
  return normalize(relative(root, file));
}

function normalize(path) {
  return path.replaceAll('\\', '/');
}
