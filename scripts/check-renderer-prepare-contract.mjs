import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoots = [
  resolve(root, 'engine/src/renderer'),
  resolve(root, 'engine/src/gui/rendering'),
];
const failures = [];
let rendererCount = 0;
let postProcessPassCount = 0;

for (const rendererRoot of rendererRoots) {
  for (const entry of readdirSync(rendererRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = resolve(rendererRoot, entry.name);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !extendsBaseRenderer(statement)) continue;
      rendererCount += 1;
      const className = statement.name?.text ?? entry.name;
      const prepare = statement.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'prepare');
      if (!prepare || !ts.isMethodDeclaration(prepare)) {
        failures.push(`${className} must implement prepare(engine): void`);
        continue;
      }
      if (prepare.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        failures.push(`${className}.prepare must not be async; use initialize(): Promise<void> for real asynchronous work`);
      }
      if (!prepare.type || prepare.type.kind !== ts.SyntaxKind.VoidKeyword) {
        failures.push(`${className}.prepare must explicitly return void`);
      }
      const warmup = statement.members.find(
        member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'contributePipelineWarmup',
      );
      if (!warmup) {
        failures.push(`${className} must contribute its common variants to PipelineWarmupPlan`);
      }
      if (/create(?:Render|Compute)Pipeline\(/.test(prepare.getText(source))) {
        failures.push(`${className}.prepare must not synchronously compile pipelines; use contributePipelineWarmup()`);
      }
    }
  }
}

const postProcessRoot = resolve(root, 'engine/src/postprocess');
for (const entry of readdirSync(postProcessRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const path = resolve(postProcessRoot, entry.name);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !extendsClass(statement, 'PostProcessPass')) continue;
    postProcessPassCount += 1;
    const className = statement.name?.text ?? entry.name;
    const warmup = statement.members.find(
      member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'contributePipelineWarmup',
    );
    if (!warmup) failures.push(`${className} must contribute its pipelines to PipelineWarmupPlan`);
    const prepare = statement.members.find(
      member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'prepare',
    );
    if (prepare && /create(?:Render|Compute)Pipeline\(/.test(prepare.getText(source))) {
      failures.push(`${className}.prepare must not synchronously compile pipelines; use contributePipelineWarmup()`);
    }
  }
}

const baseSource = ts.createSourceFile(
  'BaseRenderer.ts',
  readFileSync(resolve(rendererRoots[0], 'BaseRenderer.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const baseClass = baseSource.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'BaseRenderer');
const basePrepare = baseClass?.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(baseSource) === 'prepare');
const baseWarmup = baseClass?.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(baseSource) === 'contributePipelineWarmup');
if (!basePrepare || !ts.isMethodDeclaration(basePrepare) || basePrepare.type?.kind !== ts.SyntaxKind.VoidKeyword) {
  failures.push('BaseRenderer must declare abstract prepare(engine): void');
}
if (!baseWarmup || !ts.isMethodDeclaration(baseWarmup) || !hasModifier(baseWarmup, ts.SyntaxKind.AbstractKeyword)) {
  failures.push('BaseRenderer must declare abstract contributePipelineWarmup(plan): void');
}

if (failures.length > 0) {
  console.error('[renderer-prepare] Contract violations:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `[renderer-prepare] ${rendererCount} BaseRenderer implementations and ${postProcessPassCount} post-process passes separate synchronous prepare from pipeline warmup.`,
);

function extendsBaseRenderer(node) {
  return extendsClass(node, 'BaseRenderer');
}

function extendsClass(node, baseName) {
  return node.heritageClauses?.some(clause =>
    clause.token === ts.SyntaxKind.ExtendsKeyword
    && clause.types.some(type => ts.isIdentifier(type.expression) && type.expression.text === baseName)) ?? false;
}

function hasModifier(node, kind) {
  return node.modifiers?.some(modifier => modifier.kind === kind) ?? false;
}
