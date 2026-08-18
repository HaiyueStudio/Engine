import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const EXTENSIONS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SOURCE_DIRECTORY = join(EXTENSIONS_DIRECTORY, 'src');
const INDEX_SOURCE = join(SOURCE_DIRECTORY, 'animation3d.ts');

function declarationTarget(importer, specifier) {
  const unresolved = resolve(dirname(importer), specifier);
  return unresolved.endsWith('.js')
    ? `${unresolved.slice(0, -3)}.d.ts`
    : `${unresolved}.d.ts`;
}

function collectReachableDeclarations(indexDeclaration) {
  const pending = [indexDeclaration];
  const reachable = new Map();
  const relativeModule =
    /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/gu;

  while (pending.length > 0) {
    const declaration = pending.pop();
    if (reachable.has(declaration)) continue;
    const source = readFileSync(declaration, 'utf8');
    reachable.set(declaration, source);
    for (const match of source.matchAll(relativeModule)) {
      pending.push(declarationTarget(declaration, match[1]));
    }
  }
  return reachable;
}

test('stable declarations expose no private Animation3D path or implementation handle', () => {
  const outputDirectory = mkdtempSync(
    join(tmpdir(), 'haiyue-animation3d-declarations-'),
  );
  try {
    const configPath = join(
      EXTENSIONS_DIRECTORY,
      'tsconfig.animation3d-type-tests.json',
    );
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(configFile.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      EXTENSIONS_DIRECTORY,
      {
        declaration: true,
        declarationMap: false,
        emitDeclarationOnly: true,
        noEmit: false,
        outDir: outputDirectory,
        rootDir: SOURCE_DIRECTORY,
      },
      configPath,
    );
    const program = ts.createProgram({
      rootNames: [INDEX_SOURCE],
      options: parsed.options,
      projectReferences: parsed.projectReferences,
    });
    const emit = program.emit();
    const diagnostics = [
      ...ts.getPreEmitDiagnostics(program),
      ...emit.diagnostics,
    ];
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: fileName => fileName,
        getCurrentDirectory: () => EXTENSIONS_DIRECTORY,
        getNewLine: () => '\n',
      }),
    );

    const indexDeclaration = join(
      outputDirectory,
      'animation3d.d.ts',
    );
    const reachable = collectReachableDeclarations(indexDeclaration);
    const forbidden = [
      /\/runtime\//u,
      /\/animation-state-machine\//u,
      /\bAnimation3DTrackSampler\b/u,
      /\bCompiledAnimation3D(?:Layer|State|Transition|Motion)\b/u,
      /\bAnimation3DStateMachineMixerPort\b/u,
      /\bAnimation3DActionRuntime\b/u,
      /\bAnimation3DActionHandle\b/u,
      /\bAnimation3DStateMachineMixer(?:Adapter|Integration)\b/u,
      /\b(?:begin|commit|cancel)SynchronizedFrame\b/u,
      /\btransitionLimitReached\b/u,
      /\bAnimation3DResource(?:Loader|Source|Handle)?\b/u,
    ];

    for (const [fileName, source] of reachable) {
      const relativeName = fileName.slice(outputDirectory.length);
      for (const pattern of forbidden) {
        assert.doesNotMatch(
          `${relativeName}\n${source}`,
          pattern,
          `${relativeName} leaks ${pattern}`,
        );
      }
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
