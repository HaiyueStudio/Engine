import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';
import { auditAnimationScriptIsolation, auditAnimationScriptPackageClosure } from './animation-script-policy.mjs';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptsRoot, '../..');
const audit = auditAnimationScriptIsolation(workspace);
if (audit.status !== 'passed') throw new Error(`Animation script security audit failed: ${JSON.stringify(audit.findings)}`);
const packageClosure = auditAnimationScriptPackageClosure(workspace);
if (packageClosure.status !== 'passed') throw new Error(`Animation script package closure failed: ${JSON.stringify(packageClosure.findings)}`);
const temporary = mkdtempSync(path.join(tmpdir(), 'haiyue-animation-script-browser-gate-'));

try {
  transpile(path.join(workspace, 'extensions/src/animation-script'), path.join(temporary, 'script-runtime'));
  const result = await runChromeWebGpuFixture({
    root: scriptsRoot,
    fixture: 'animation-script-worker-fixture.html',
    mounts: [{ prefix: '/g09', directory: temporary }],
    timeoutMs: 60_000,
    crossOriginIsolation: true,
  });
  const failures = [];
  if (result.schema !== 'haiyue-animation-script-browser-evidence@1' || result.deterministicReplay !== true) failures.push('identity/replay');
  if (result.escapeCode !== 'E_SCRIPT_PROTOCOL') failures.push(`escape=${result.escapeCode}`);
  if (result.workerStats?.worker !== 0 || result.workerStats?.pending !== 0 || result.workerStats?.handles !== 0 || result.workerStats?.disposed !== true) failures.push('worker residual');
  if (result.gpuOwnerResidual?.pipelines !== 0 || result.gpuOwnerResidual?.buffers !== 0 || result.gpuOwnerResidual?.disposed !== true) failures.push('GPU owner residual');
  if (!Array.isArray(result.gpuPixel) || result.gpuPixel[0] <= 0 || result.gpuPixel[3] !== 255) failures.push(`pixel=${JSON.stringify(result.gpuPixel)}`);
  if (result.officialWgslCandidate?.evidenceClass !== 'candidate-documentation-trace'
    || result.officialWgslCandidate?.source !== 'https://rive.app/docs/scripting/wgsl-shaders'
    || result.officialWgslCandidate?.vertexEntryPoint !== 'vertexMain'
    || result.officialWgslCandidate?.fragmentEntryPoint !== 'fragmentMain'
    || result.officialWgslCandidate?.customVertexExecuted !== true) failures.push('official custom vertex trace');
  if (result.validationErrorCount !== 0 || result.uncapturedErrorCount !== 0 || result.unclassifiedFailureCount !== 0) failures.push('browser/GPU diagnostics');
  if (result.browserEvidence?.nativeBackend !== true || /swiftshader|software|warp/iu.test(result.browserEvidence?.angleBackend ?? '')) failures.push('non-native GPU backend');
  if (result.browserDiagnostics?.consoleErrorCount !== 0 || result.browserDiagnostics?.exceptionCount !== 0 || result.browserDiagnostics?.unclassifiedFailureCount !== 0) failures.push('browser console/exception');
  if (failures.length) throw new Error(`Animation script browser security gate failed:\n- ${failures.join('\n- ')}\n${JSON.stringify(result, null, 2)}`);
  process.stdout.write(`${JSON.stringify({ ...result, sourceAudit: audit, packageClosure }, null, 2)}\n`);
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
