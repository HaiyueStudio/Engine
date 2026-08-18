import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const editorRoot = resolve(root, 'editor/src');
const domainRoot = resolve(editorRoot, 'domain');
const failures = [];

const slices = [
  'ProjectState', 'SessionState', 'RuntimeState', 'InspectorState', 'PlayState',
];
for (const slice of slices) requireFile(`editor/src/domain/store/${slice}.ts`);
requireFile('editor/src/domain/selection/SelectionState.ts');
requireFile('editor/src/domain/events/EditorEventBus.ts');
requireFile('editor/src/domain/workflows/CoreWorkflowCoordinator.ts');
requireFile('editor/src/infra/storage/LocalStorageEditorSessionPersistence.ts');
requireFile('editor/src/engine-adapter/PlayerRuntimeAdapter.ts');

const store = source('editor/src/domain/store/EditorStore.ts');
for (const required of ['editorSelectors', 'readonly commands', 'snapshot()', 'transaction.committed', 'transaction.rolled-back']) {
  if (!store.includes(required)) failures.push(`EditorStore is missing ${required}`);
}
for (const forbidden of [
  'getWorld(', 'setWorld(', 'getViewportEngine(', 'setViewportEngine(',
  'getRuntimeContext(', 'setRuntimeContext(', 'readonly resourceSelection',
  'readonly runtime =', 'readonly session =', 'store: this', 'localStorage', 'globalThis',
]) {
  if (store.includes(forbidden)) failures.push(`EditorStore still exposes legacy/mutable concern: ${forbidden}`);
}

const workflows = source('editor/src/domain/workflows/CoreWorkflowCoordinator.ts');
for (const method of ['openDocument', 'saveDocument', 'importAssets', 'preview', 'exportProject']) {
  if (!workflows.includes(`${method}<`)) failures.push(`core workflow is missing ${method}`);
}
for (const forbidden of ['transactionAsync', 'runGroupAsync', 'createOrOpenScene', 'manageResources', 'editEntities']) {
  if (source('editor/src/domain/store/EditorStore.ts').includes(forbidden)
    || source('editor/src/commands/CommandBus.ts').includes(forbidden)
    || workflows.includes(forbidden)) {
    failures.push(`async workflow legacy API remains: ${forbidden}`);
  }
}

for (const file of walk(domainRoot)) {
  if (!file.endsWith('.ts')) continue;
  const content = readFileSync(file, 'utf8');
  const path = relative(root, file);
  for (const pattern of [
    /\bwindow\b/, /\bdocument\b/, /\blocalStorage\b/, /\bsessionStorage\b/,
    /\bHTMLElement\b/, /\bHTMLCanvasElement\b/, /\bCustomEvent\b/, /\bEventTarget\b/,
  ]) {
    if (pattern.test(content)) failures.push(`${path} contains DOM dependency ${pattern}`);
  }
  for (const specifier of imports(file, content)) {
    if (specifier.includes('/infra/') || specifier.startsWith('../../infra') || specifier.startsWith('../infra')) {
      failures.push(`${path} imports infra module ${specifier}`);
    }
  }
}

for (const file of walk(editorRoot)) {
  if (!file.endsWith('.ts')) continue;
  const content = readFileSync(file, 'utf8');
  const path = relative(root, file);
  for (const forbidden of ['getWorld(', 'setWorld(', 'getViewportEngine(', 'setViewportEngine(', 'setEditorViewportEngine']) {
    if (content.includes(forbidden)) failures.push(`${path} still uses deleted runtime API ${forbidden}`);
  }
}

if (failures.length > 0) {
  console.error('[stage6-editor] Editor architecture contract violations:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[stage6-editor] slices, selectors/commands, minimal events, domain/infra boundary, runtime context, and five workflows passed.');

function source(path) { return readFileSync(resolve(root, path), 'utf8'); }
function requireFile(path) { if (!existsSync(resolve(root, path))) failures.push(`missing ${path}`); }
function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
function imports(file, content) {
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = [];
  visit(ast);
  return result;
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
}
