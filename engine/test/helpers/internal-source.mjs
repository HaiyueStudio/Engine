import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('../../src/', import.meta.url).href;
// Exercise private modules without adding package exports just for tests. Workspace tsc is still required.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'pako' && context.parentURL?.startsWith(root)) return { url: new URL('./pako-interop.mjs', import.meta.url).href, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root)) {
      const url = new URL(specifier, context.parentURL);
      if (existsSync(new URL(`${url.href}.ts`))) {
        return { url: `${url.href}.ts`, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root) && url.endsWith('.ts')) {
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: new URL(url).pathname,
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    if (url.startsWith(root) && url.endsWith('.wgsl')) {
      return { format: 'module', source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))};`, shortCircuit: true };
    }
    return next(url, context);
  },
});

export function importEngineSource(path) { return import(new URL(path, root).href); }
