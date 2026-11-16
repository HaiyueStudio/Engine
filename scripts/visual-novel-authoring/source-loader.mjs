import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const roots = ['visual-novel/story', 'narrative', 'i18n'].map(path =>
  new URL(`../../extensions/src/${path}/`, import.meta.url).href);
const owns = url => roots.some(root => url?.startsWith(root));

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && owns(context.parentURL)) {
    const resolved = new URL(specifier, context.parentURL);
    if (owns(resolved.href) && !resolved.pathname.endsWith('.ts')) {
      const candidate = new URL(resolved.href.replace(/(?:\.js)?$/, '.ts'));
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (owns(url) && url.endsWith('.ts')) {
    const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      fileName: new URL(url).pathname,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
