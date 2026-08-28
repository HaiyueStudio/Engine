import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { validateRiveG11SecurityReport } from './rive-g11-security-contract.mjs';
import { assertFormalRepositoryIdentity, captureRepositoryIdentity } from '../formal-evidence/repository-identity.mjs';
import { audioEventFixture, audioResolver, FakeAudioBackend, loadG08Modules } from '../../extensions/test/audio-event-parity-fixture.mjs';
import { dataBindingFixture, interactionFixture, loadG07Modules } from '../../extensions/test/data-binding-parity-fixture.mjs';
import { capabilityTracePort, deferred, invocation, loadG09Modules, loopbackWorker, programFixture, runtimeLimits, shaderFixture } from '../../extensions/test/animation-script-parity-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const formal = process.argv.includes('--formal');
const output = resolve(root, argument('--out') ?? 'review/candidates/rive-g11-security-diagnostic.json');
const manifestBytes = readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const generated = JSON.parse(readFileSync(resolve(root, manifest.generatedParserCorpus.path), 'utf8'));
const repositoryStart = captureRepositoryIdentity(root);
if (formal) assertFormalRepositoryIdentity(repositoryStart, repositoryStart, { label: 'Engine' });
const revision = repositoryStart.revision;
const dirty = repositoryStart.dirty;
const importer = await import(new URL('../../animation-spec/dist-test/conversion/rive-ir/index.js', import.meta.url).href);
const [{ runtime: scriptRuntime }, g07, g08] = await Promise.all([loadG09Modules(), loadG07Modules(), loadG08Modules()]);
const implementations = createImplementations({ importer, scriptRuntime, g07, g08 });
const cases = [];
for (const declared of manifest.securityCases) {
  const implementation = implementations.get(declared.id);
  if (!implementation) {
    cases.push({ id: declared.id, class: declared.class, status: 'not-run', expectedDiagnostic: declared.expected, reason: 'No concrete G11 security driver is registered.' });
    continue;
  }
  cases.push(await measureCase(declared, implementation));
}
const summary = {
  total: cases.length,
  passed: cases.filter(value => value.status === 'passed').length,
  failed: cases.filter(value => value.status === 'failed').length,
  notRun: cases.filter(value => value.status === 'not-run').length,
};
const report = {
  schemaVersion: 1,
  kind: 'haiyue-rive-g11-security-workload',
  tupleId: 'rive-7.3-webgl2-2.40.0',
  status: summary.failed > 0 ? 'failed' : summary.notRun > 0 ? 'incomplete' : 'passed',
  evidenceClass: dirty ? 'dirty-worktree-diagnostic' : 'clean-revision-candidate',
  generatedAt: new Date().toISOString(),
  engineRevision: revision,
  engineDirty: dirty,
  nodeVersion: process.version,
  manifestSha256: sha256(manifestBytes),
  runner: {
    id: 'scripts/benchmark/rive-g11-run-security.mjs@1',
    importer: 'animation-spec/dist-test/conversion/rive-ir/index.js',
    sourceNeutralRuntimeDrivers: ['g07-interaction', 'g08-audio', 'g09-script-wgsl'],
  },
  unclassifiedFailureCount: cases.filter(value => value.status === 'failed' && value.underlyingDiagnostic === 'unclassified').length,
  cases,
  summary,
};
const validation = validateRiveG11SecurityReport(report, manifest, { formal, expectedRevision: formal ? revision : null, expectedManifestSha256: sha256(manifestBytes) });
if (validation.status !== 'passed') {
  const unclassified = cases.filter(value => value.underlyingDiagnostic === 'unclassified').map(value => value.id);
  throw new Error(`G11 security report failed ${validation.mode} validation:\n- ${validation.violations.join('\n- ')}${unclassified.length ? `\n- unclassified cases: ${unclassified.join(', ')}` : ''}`);
}
if (formal) assertFormalRepositoryIdentity(repositoryStart, captureRepositoryIdentity(root), { label: 'Engine' });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[rive-g11-security] passed=${summary.passed}/${summary.total}, failed=${summary.failed}, not-run=${summary.notRun}; wrote ${relative(root, output)}.`);

async function measureCase(declared, implementation) {
  const beforeMemory = process.memoryUsage().heapUsed;
  const started = performance.now();
  try {
    const result = await implementation.run();
    const cpuMs = performance.now() - started;
    const peakMemoryBytes = Math.max(beforeMemory, process.memoryUsage().heapUsed);
    const observedDiagnostic = implementation.map(result.underlyingDiagnostic);
    return {
      id: declared.id, class: declared.class,
      status: observedDiagnostic === declared.expected && result.ownerResidual === 0 ? 'passed' : 'failed',
      expectedDiagnostic: declared.expected, observedDiagnostic, underlyingDiagnostic: result.underlyingDiagnostic,
      freshOwner: true, ownerResidual: result.ownerResidual, cpuMs, peakMemoryBytes,
      limits: { cpuMs: 60_000, peakMemoryBytes: 1024 * 1024 * 1024 },
      runner: implementation.runner,
      ...(result.details ? { details: result.details } : {}),
    };
  } catch (error) {
    return {
      id: declared.id, class: declared.class, status: 'failed', expectedDiagnostic: declared.expected,
      observedDiagnostic: null, underlyingDiagnostic: diagnostic(error), freshOwner: true, ownerResidual: 0,
      cpuMs: performance.now() - started, peakMemoryBytes: Math.max(beforeMemory, process.memoryUsage().heapUsed),
      limits: { cpuMs: 60_000, peakMemoryBytes: 1024 * 1024 * 1024 }, runner: implementation.runner,
    };
  }
}

function createImplementations({ importer: rive, scriptRuntime: script, g07: interactionModules, g08: audioModules }) {
  const map = new Map();
  for (const item of generated.cases.filter(value => value.suite === 'security')) {
    map.set(item.id, implementation('g02-generated-parser', value => value, async () => {
      const bytes = readFileSync(resolve(root, item.path));
      return rejectedCode(() => rive.importFrozenRiv(bytes, item.options), 0);
    }));
  }
  map.set('decompression-bomb', implementation('g02-asset-byte-budget', identity, async () => rejectedCode(() => rive.importFrozenRiv(assetRiv({ embedded: [1, 2] }), { limits: { oneAssetBytes: 1 } }), 0)));
  map.set('private-network-asset', implementation('g02-hosted-url-policy', identity, async () => {
    const expected = Uint8Array.of(1);
    return rejectedCode(() => rive.importFrozenRiv(assetRiv({ url: 'https://127.0.0.1/metadata' }), { assetManifest: [assetManifest(expected)], assetResolver: resolver(expected) }), 0);
  }));
  map.set('asset-hash-mismatch', implementation('g02-asset-integrity', identity, async () => {
    const expected = Uint8Array.of(1);
    return rejectedCode(() => rive.importFrozenRiv(assetRiv({ url: 'https://assets.example/item' }), { allowedHostedOrigins: ['https://assets.example'], assetManifest: [assetManifest(expected)], assetResolver: resolver(Uint8Array.of(2)) }), 0);
  }));

  map.set('infinite-luau', implementation('g09-portable-vm-instruction-budget', scriptBudget, async () => {
    const program = programFixture('util', { id: 'g11-loop', entrypoint: 'add', instructions: [{ op: 'jump', target: 0 }] });
    return rejectedCode(() => new script.PortableScriptVm(program, runtimeLimits({ maxInstructionsPerInvocation: 32 }), capabilityTracePort()).invoke(invocation(program.id, 'add'), new AbortController().signal), 0);
  }));
  map.set('promise-storm', implementation('g09-portable-vm-promise-budget', scriptBudget, async () => {
    const program = programFixture('converter', { id: 'g11-promise', entrypoint: 'convert', capabilities: ['data.read'], instructions: [{ op: 'capability', capability: 'data.read', arguments: [] }, { op: 'return' }] });
    return rejectedCode(() => new script.PortableScriptVm(program, runtimeLimits({ maxPendingPromises: 0 }), capabilityTracePort({ result: Promise.resolve(null) })).invoke(invocation(program.id, 'convert'), new AbortController().signal), 0);
  }));
  map.set('script-output-amplification', implementation('g09-portable-vm-output-budget', scriptBudget, async () => {
    const program = programFixture('node', { id: 'g11-output', entrypoint: 'draw', capabilities: ['canvas.emit'], instructions: [{ op: 'capability', capability: 'canvas.emit', arguments: [] }, { op: 'capability', capability: 'canvas.emit', arguments: [] }, { op: 'return' }] });
    return rejectedCode(() => new script.PortableScriptVm(program, runtimeLimits({ maxOutputCommands: 1 }), capabilityTracePort()).invoke(invocation(program.id, 'draw'), new AbortController().signal), 0);
  }));
  map.set('invalid-wgsl-binding', implementation('g09-wgsl-binding-validator', shaderBinding, async () => {
    const shader = shaderFixture({ source: shaderFixture().source.replace('@group(0)', '@group(1)') });
    return thrownCode(() => script.validateSandboxedWgsl(shader, runtimeLimits()), 0);
  }));
  map.set('expensive-wgsl', implementation('g09-wgsl-source-budget', shaderBudget, async () => thrownCode(() => script.validateSandboxedWgsl(shaderFixture(), runtimeLimits({ maxShaderSourceBytes: 10 })), 0)));
  map.set('event-recursion', implementation('g07-interaction-recursion-budget', scriptBudget, async () => eventRecursion(interactionModules)));
  map.set('abort-reimport-race', implementation('g09-owner-replace-generation', abortMapping, async () => scriptOwnerRace(script, 'replace')));
  map.set('late-result-after-dispose', implementation('g09-owner-dispose-generation', abortMapping, async () => scriptOwnerRace(script, 'dispose')));
  map.set('device-loss', implementation('g09-custom-shader-device-loss', shaderBudget, async () => shaderDeviceLoss(script)));
  map.set('audio-voice-flood', implementation('g08-audio-voice-budget', limitMapping, async () => audioVoiceFlood(audioModules)));
  return map;
}

async function eventRecursion({ data, interaction, runtime }) {
  const raw = interactionFixture();
  raw.limits.maxEventRecursion = 2;
  raw.listeners.find(value => value.id === 'reported').actions = [{ kind: 'report-event', name: 'again' }];
  const dataRuntime = new runtime.DataBindingRuntime(data.parseHyaDataBinding(dataBindingFixture()));
  let input;
  const port = { begin() {}, invoke(action, event) { if (action.kind === 'report-event') input.enqueueReportedEvent(action.name, null, event.target); }, commit() {}, rollback() {}, dispose() {} };
  input = new runtime.InteractionRuntime(interaction.parseHyaInteraction(raw), { actionPort: port });
  let code;
  try { input.enqueueReportedEvent('start', null, 'button'); } catch (error) { code = diagnostic(error); }
  input.dispose(); dataRuntime.dispose();
  return { underlyingDiagnostic: code ?? 'accepted', ownerResidual: input.trace.captures.length + input.trace.pointers };
}

async function scriptOwnerRace(script, mode) {
  const program = programFixture('converter', { id: `g11-${mode}`, entrypoint: 'convert', registers: 2, capabilities: ['data.read'], instructions: [{ op: 'load-input', to: 0, name: 'handle' }, { op: 'capability', to: 1, capability: 'data.read', arguments: [0] }, { op: 'return', value: 1 }] });
  const gate = deferred();
  const port = capabilityTracePort({ gate: () => gate.promise });
  const owner = new script.ScriptSandboxOwner({ workerFactory: () => loopbackWorker(script), programs: [program], limits: runtimeLimits({ maxWallTimeMs: 1_000 }), capabilityPort: port });
  const handle = owner.createHandle('view-model', 'late', ['read']);
  const pending = owner.invoke(invocation(program.id, 'convert', { inputs: { handle } }));
  await waitFor(() => port.calls.length === 1);
  if (mode === 'replace') await owner.replacePrograms([program]); else await owner.dispose();
  const code = await rejectionCode(pending);
  gate.resolve(1);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
  await owner.dispose();
  const stats = owner.stats();
  return { underlyingDiagnostic: code, ownerResidual: stats.pending + stats.worker + stats.handles };
}

async function shaderDeviceLoss(script) {
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
  const loss = deferred();
  const device = fakeDevice(loss.promise);
  const owner = new script.CustomShaderOwner(device, runtimeLimits());
  await owner.compile(shaderFixture());
  owner.createUniformBuffer(16);
  loss.resolve({ reason: 'destroyed', message: 'g11' });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
  let code;
  try { owner.recordDraw(); } catch (error) { code = diagnostic(error); }
  owner.dispose();
  const stats = owner.stats();
  return { underlyingDiagnostic: code ?? 'accepted', ownerResidual: stats.pipelines + stats.buffers + stats.uniformBytes };
}

async function audioVoiceFlood({ audio, runtime }) {
  const raw = audioEventFixture();
  raw.limits.maxVoices = 1; raw.limits.maxVoicesPerResource = 1; raw.voiceStealing = 'reject';
  const backend = new FakeAudioBackend();
  const player = new runtime.AudioEventRuntime(audio.parseHyaAudioEvents(raw), backend, { resolver: audioResolver() });
  await player.prepare(['embedded-tone']);
  await player.dispatchCue({ eventId: 'one', cue: 'blip', operation: 'start', clock: 'event' });
  const code = await rejectionCode(player.dispatchCue({ eventId: 'two', cue: 'loop', operation: 'start', clock: 'event' }));
  player.dispose();
  return { underlyingDiagnostic: code, ownerResidual: player.stats.voices + player.stats.pendingVoices + player.assets.stats.cacheEntries };
}

function implementation(runner, map, run) { return { runner, map, run }; }
function identity(value) { return value; }
function scriptBudget(value) { return ['E_SCRIPT_TIMEOUT', 'E_SCRIPT_OOM', 'E_SCRIPT_EVENT_BUDGET', 'E_INTERACTION_RUNTIME_LIMIT'].includes(value) ? 'E_RIVE_SCRIPT_BUDGET' : value; }
function shaderBinding(value) { return value === 'E_SHADER_BINDING' ? 'E_RIVE_SHADER_BINDING' : value; }
function shaderBudget(value) { return ['E_SHADER_BUDGET', 'E_SHADER_DEVICE_LOST'].includes(value) ? 'E_RIVE_SHADER_BUDGET' : value; }
function abortMapping(value) { return ['E_SCRIPT_ABORTED', 'E_SCRIPT_DISPOSED'].includes(value) ? 'E_RIVE_ABORTED' : value; }
function limitMapping(value) { return value === 'E_AUDIO_RUNTIME_LIMIT' ? 'E_RIVE_LIMIT_EXCEEDED' : value; }

async function rejectedCode(run, ownerResidual) { return { underlyingDiagnostic: await rejectionCode(run()), ownerResidual }; }
function thrownCode(run, ownerResidual) { try { run(); return { underlyingDiagnostic: 'accepted', ownerResidual }; } catch (error) { return { underlyingDiagnostic: diagnostic(error), ownerResidual }; } }
async function rejectionCode(promise) { try { await promise; return 'accepted'; } catch (error) { return diagnostic(error); } }
function diagnostic(error) { return typeof error?.code === 'string' ? error.code : 'unclassified'; }
function assetManifest(bytes) { return { assetId: 1, revision: 'g11-fixture', sha256: sha256(bytes), byteLength: bytes.byteLength, mimeType: 'application/octet-stream', licenseId: 'g11-owned', allowedUse: 'security-test' }; }
function resolver(bytes) { return { async resolve() { return { bytes, mimeType: 'application/octet-stream' }; } }; }

function assetRiv({ embedded = null, url = null }) {
  const fields = [field(204, vu(1))];
  if (url) fields.push(field(362, str(url)));
  const objects = [object(105, fields)];
  if (embedded) objects.push(object(106, [field(212, blob(embedded))]));
  return riv(objects);
}
function vu(value) { let remaining = BigInt(value); const bytes = []; do { let byte = Number(remaining & 0x7fn); remaining >>= 7n; if (remaining) byte |= 0x80; bytes.push(byte); } while (remaining); return bytes; }
function text(value) { return [...new TextEncoder().encode(value)]; }
function str(value) { const bytes = text(value); return [...vu(bytes.length), ...bytes]; }
function blob(value) { return [...vu(value.length), ...value]; }
function field(key, payload) { return [...vu(key), ...payload]; }
function object(key, fields = []) { return [...vu(key), ...fields.flat(), 0]; }
function riv(objects) { return new Uint8Array([...text('RIVE'), ...vu(7), ...vu(3), 0, 0, ...objects.flat()]); }

function fakeDevice(lost) {
  return {
    lost,
    createShaderModule() { return { async getCompilationInfo() { return { messages: [] }; } }; },
    createBindGroupLayout(descriptor) { return { descriptor }; },
    createPipelineLayout(descriptor) { return { descriptor }; },
    async createRenderPipelineAsync(descriptor) { return { descriptor }; },
    createBuffer(descriptor) { return { descriptor, destroy() {} }; },
  };
}
async function waitFor(predicate, timeoutMs = 1_000) { const deadline = Date.now() + timeoutMs; while (!predicate()) { if (Date.now() > deadline) throw new Error('security case timed out'); await new Promise(resolvePromise => setTimeout(resolvePromise, 1)); } }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
