import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptsRoot, '../..');
const temporary = mkdtempSync(path.join(tmpdir(), 'haiyue-audio-browser-gate-'));

try {
  transpile(path.join(workspace, 'animation-spec/src/audio'), path.join(temporary, 'audio-spec'));
  transpile(path.join(workspace, 'extensions/src/animation/audio'), path.join(temporary, 'audio-runtime'));
  const result = await runChromeWebGpuFixture({
    root: scriptsRoot,
    fixture: 'audio-offline-context-fixture.html',
    mounts: [{ prefix: '/g08', directory: temporary }],
    timeoutMs: 60_000,
    crossOriginIsolation: true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function transpile(sourceRoot, outputRoot) {
  for (const source of walk(sourceRoot)) {
    if (!source.endsWith('.ts')) continue;
    const output = path.join(outputRoot, path.relative(sourceRoot, source).replace(/\.ts$/u, '.js'));
    mkdirSync(path.dirname(output), { recursive: true });
    const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    writeFileSync(output, compiled);
  }
}

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(resolved));
    else result.push(resolved);
  }
  return result;
}
