import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveStudioRepositoryPath } from './studio-repository-layout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

for (const { kind, directory } of [
  { kind: 'examples', directory: resolve(root, 'examples') },
  { kind: 'games', directory: resolveStudioRepositoryPath('Games', 'games') },
]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(directory, entry.name, 'main.ts');
    try {
      validateSource(path, readFileSync(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

const gettingStartedPath = resolve(root, 'docs/engine-guide/getting-started.md');
const gettingStarted = readFileSync(gettingStartedPath, 'utf8');
for (const [index, block] of [...gettingStarted.matchAll(/```ts\s*\n([\s\S]*?)```/g)].entries()) {
  validateSource(`${gettingStartedPath}#typescript-${index + 1}`, block[1]);
}

if (violations.length > 0) {
  console.error('[scene-golden-path] Contract violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('[scene-golden-path] createScene -> switchScene -> run is consistent across docs, examples, and games.');

function validateSource(path, sourceText) {
  const displayPath = display(path);
  const sourceFile = ts.createSourceFile(displayPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scenes = [];
  const calls = [];

  visit(sourceFile);
  for (const scene of scenes) {
    const run = calls.find(call => call.method === 'run' && call.owner === scene.engine && call.position > scene.position);
    if (!run) continue;
    const sceneSwitch = calls.find(call =>
      call.method === 'switchScene'
      && call.owner === scene.engine
      && call.argument === scene.name
      && call.position > scene.position
      && call.position < run.position,
    );
    if (!sceneSwitch) {
      violations.push(`${displayPath}:${lineOf(sourceFile, scene.node)} creates ${scene.name} but does not switch it before ${scene.engine}.run()`);
    }
  }

  function visit(node) {
    const created = getSceneCreation(node, sourceFile);
    if (created) scenes.push(created);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(sourceFile);
      const method = node.expression.name.text;
      const argument = node.arguments[0]?.getText(sourceFile);
      calls.push({ owner, method, argument, position: node.getStart(sourceFile) });
      if (method === 'update' && scenes.some(scene => scene.name === owner)) {
        violations.push(`${displayPath}:${lineOf(sourceFile, node)} manually updates a scene created by HaiyueEngine`);
      }
      if (method === 'updateActiveScene') {
        violations.push(`${displayPath}:${lineOf(sourceFile, node)} bypasses the automatic active-scene frame lifecycle`);
      }
    }
    ts.forEachChild(node, visit);
  }
}

function getSceneCreation(node, sourceFile) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isCreateSceneCall(node.initializer)) {
    return sceneRecord(node.name.getText(sourceFile), node.initializer, node, sourceFile);
  }
  if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && isCreateSceneCall(node.right)) {
    return sceneRecord(node.left.getText(sourceFile), node.right, node, sourceFile);
  }
  return null;
}

function isCreateSceneCall(node) {
  return node !== undefined
    && ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'createScene';
}

function sceneRecord(name, call, node, sourceFile) {
  return {
    name,
    engine: call.expression.expression.getText(sourceFile),
    node,
    position: node.getStart(sourceFile),
  };
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function display(path) {
  const hashIndex = path.indexOf('#');
  const filePath = hashIndex < 0 ? path : path.slice(0, hashIndex);
  const suffix = hashIndex < 0 ? '' : path.slice(hashIndex);
  return `${relative(root, filePath)}${suffix}`;
}
