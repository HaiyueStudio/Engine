import { resolve } from 'node:path';
import ts from 'typescript';

/** Typecheck the complete project once before emitting any example bundles. */
export function checkExampleTypes(configPath) {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(formatDiagnostics([read.error]));
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, resolve(configPath, '..'), { noEmit: true });
  if (config.errors.length) throw new Error(formatDiagnostics(config.errors));
  const program = ts.createProgram(config.fileNames, config.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(formatDiagnostics(diagnostics));
  return config.fileNames.length;
}

/** Rollup visits only reachable modules; project diagnostics belong to the preflight above. */
export function exampleTypeScript() {
  return {
    name: 'haiyue-example-typescript',
    transform(code, id) {
      if (!/\.[cm]?tsx?$/u.test(id) || /\.d\.[cm]?ts$/u.test(id)) return null;
      const result = ts.transpileModule(code, {
        fileName: id,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          experimentalDecorators: true,
          importHelpers: true,
          sourceMap: true,
          inlineSources: true,
        },
      });
      const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
      if (errors.length) this.error(formatDiagnostics(errors));
      return { code: result.outputText, map: JSON.parse(result.sourceMapText) };
    },
  };
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => '\n',
  });
}
