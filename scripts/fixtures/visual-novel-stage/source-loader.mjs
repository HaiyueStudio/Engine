import { existsSync } from 'node:fs';
import ts from 'typescript';

export const stageSource = new URL('../../../extensions/src/visual-novel/stage/', import.meta.url);
export const owns = url => url?.startsWith(stageSource.href);
export function resolveStageImport(specifier, parentURL) {
  if (!specifier.startsWith('.') || !owns(parentURL)) return;
  const url = new URL(specifier, parentURL);
  if (!owns(url.href)) return;
  if (!url.pathname.endsWith('.ts')) url.pathname = url.pathname.replace(/(?:\.js)?$/, '.ts');
  if (existsSync(url)) return url;
}
export function transpile(source, fileName) {
  return ts.transpileModule(source, {
    fileName, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
export async function resolve(specifier, context, next) {
  const url = resolveStageImport(specifier, context.parentURL);
  return url ? { url: url.href, shortCircuit: true } : next(specifier, context);
}
export async function load(url, context, next) {
  if (owns(url) && url.endsWith('.ts')) {
    const { readFile } = await import('node:fs/promises');
    return { format: 'module', source: transpile(await readFile(new URL(url), 'utf8'), new URL(url).pathname), shortCircuit: true };
  }
  return next(url, context);
}
