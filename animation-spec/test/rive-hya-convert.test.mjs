import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputRoot = await mkdtemp(join(tmpdir(), 'haiyue-rive-convert-'));
execFileSync(process.execPath, [
  join(engineRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p', join(engineRoot, 'animation-spec', 'tsconfig.json'),
  '--outDir', outputRoot,
  '--declaration', 'false',
  '--declarationMap', 'false',
  '--sourceMap', 'false',
], { cwd: engineRoot, stdio: 'pipe' });
await addJsExtensions(outputRoot);

const converterModuleHref = pathToFileURL(join(outputRoot, 'rive', 'convert', 'index.js')).href;
const converter = await import(converterModuleHref);
const { parseAnimation } = await import(pathToFileURL(join(outputRoot, 'parser.js')).href);
const { DEFAULT_SANDBOXED_ANIMATION_SCRIPT_LIMITS } = await import(pathToFileURL(join(outputRoot, 'script', 'limits.js')).href);
test.after(async () => rm(outputRoot, { recursive: true, force: true }));

const encoder = new TextEncoder();
const zeroHash = '0'.repeat(64);

test('G10 emits byte-exact package and independently playable binary HYA', async () => {
  const input = await fixture();
  const first = await converter.convertRiveToHya(input);
  const second = await converter.convertRiveToHya(input, { mode: 'normal' });
  assert.deepEqual(first.packageBytes, second.packageBytes);
  assert.deepEqual(first.hyaBytes, second.hyaBytes);
  assert.equal(first.report.output.packageSha256, second.report.output.packageSha256);
  assert.equal(first.report.coverage.uncoveredProperties, 0);
  assert.equal(first.report.classification.unclassifiedObjects, 0);

  const files = converter.decodeRiveHyaArchive(first.packageBytes, converter.RIVE_CONVERSION_HARD_LIMITS);
  assert.deepEqual(files.map(file => file.path), ['animation.hya', 'manifest.json', 'report/conversion-evidence.json']);
  assert.equal(await digest(first.packageBytes), first.report.output.packageSha256);
  for (const entry of first.manifest.files) {
    const file = files.find(candidate => candidate.path === entry.path);
    assert.equal(await digest(file.bytes), entry.sha256, entry.path);
    assert.equal(file.bytes.byteLength, entry.byteLength, entry.path);
  }
  const hya = files.find(file => file.path === 'animation.hya');
  const parsed = parseAnimation(hya.bytes.buffer.slice(hya.bytes.byteOffset, hya.bytes.byteOffset + hya.bytes.byteLength));
  assert.equal(parsed.nodes[0].id, 'node');
  assert.equal(parsed.source, 'binary');
  const archiveText = new TextDecoder().decode(first.packageBytes);
  assert.equal(archiveText.includes('SecretRiveSourceType'), false, 'source registry names must not enter the runtime package');
});

test('G10 production pipeline executes raw RIV import and a revision-pinned capability evaluator', async () => {
  const descriptor = {
    adapterId: 'g10-empty-artboard-adapter', adapterRevisionSha256: 'a'.repeat(64),
    evaluatorId: 'g10-empty-artboard-evaluator', evaluatorRevisionSha256: 'b'.repeat(64), optionsRevision: 'strict-v1',
  };
  const evaluator = {
    descriptor,
    async evaluate(request) {
      assert.equal(request.imported.report.input.major, 7);
      assert.deepEqual(request.imported.report.registryCoverage.encounteredObjectTypeKeys, [1]);
      const object = request.imported.ir.objects[0];
      return {
        format: 'haiyue-rive-neutral-capability-evaluation', version: 1,
        inputIrSha256: request.inputIrSha256, tuple: descriptor,
        baseDocument: {
          format: 'haiyue-animation', version: '1.0',
          canvas: { width: 1, height: 1, coordinateSystem: 'screen-y-down' }, duration: 1,
          nodes: [{ id: object.id }],
        },
        artifacts: [],
        coverage: [{ objectId: object.id, propertyIds: [], capability: 'hya-core', representation: 'native-semantic' }],
        bakedTracks: [], assets: [],
        featureLedger: [{ feature: 'core.empty-artboard', capability: 'hya-core', representation: 'native-semantic', count: 1 }],
        classification: { unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0 },
      };
    },
  };
  const result = await converter.convertRivBytesToHya(minimalRiv(), { capabilityEvaluator: evaluator });
  assert.equal(result.report.coverage.objects, 1);
  assert.equal(result.report.coverage.properties, 0);
  assert.equal(result.report.tuple.evaluatorId, descriptor.evaluatorId);
  assert.equal(parseAnimation(result.hyaBytes.buffer.slice(result.hyaBytes.byteOffset, result.hyaBytes.byteOffset + result.hyaBytes.byteLength)).nodes[0].id, 'object:00000000');
});

test('G10 production pipeline rejects evaluator tuple substitution', async () => {
  const descriptor = {
    adapterId: 'adapter', adapterRevisionSha256: 'a'.repeat(64), evaluatorId: 'evaluator', evaluatorRevisionSha256: 'b'.repeat(64), optionsRevision: 'v1',
  };
  const evaluator = {
    descriptor,
    async evaluate(request) {
      return {
        format: 'haiyue-rive-neutral-capability-evaluation', version: 1, inputIrSha256: request.inputIrSha256,
        tuple: { ...descriptor, evaluatorId: 'substituted' },
        baseDocument: { format: 'haiyue-animation', version: '1.0', canvas: { width: 1, height: 1, coordinateSystem: 'screen-y-down' }, duration: 0, nodes: [] },
        artifacts: [], coverage: [], bakedTracks: [], assets: [], featureLedger: [],
        classification: { unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0 },
      };
    },
  };
  await assert.rejects(converter.convertRivBytesToHya(minimalRiv(false), { capabilityEvaluator: evaluator }), error => error.code === 'E_RIVE_CONVERT_FORMAT' && /tuple/u.test(error.message));
});

test('G10 production pipeline classifies an unstructured evaluator failure', async () => {
  const descriptor = {
    adapterId: 'adapter', adapterRevisionSha256: 'a'.repeat(64), evaluatorId: 'evaluator', evaluatorRevisionSha256: 'b'.repeat(64), optionsRevision: 'v1',
  };
  await assert.rejects(
    converter.convertRivBytesToHya(minimalRiv(false), { capabilityEvaluator: { descriptor, async evaluate() { throw new Error('provider failed'); } } }),
    error => error.code === 'E_RIVE_CONVERT_INTERNAL' && error.path === '$.options.capabilityEvaluator.evaluate',
  );
});

test('G10 validates a versioned visual sidecar and keeps it in the deterministic package', async () => {
  const input = await fixture({
    artifacts: [{
      id: 'visual-main', capability: 'vector-visual', representation: 'native-semantic',
      document: { format: 'haiyue-vector-visual', version: 1, width: 64, height: 64, nodes: [] },
    }],
    coverage: [{ objectId: 'object:00000000', propertyIds: ['field:00000000:000000'], capability: 'vector-visual', representation: 'native-semantic', artifactId: 'visual-main' }],
    featureLedger: [{ feature: 'vector.visual', capability: 'vector-visual', representation: 'native-semantic', count: 1, artifactId: 'visual-main' }],
  });
  const result = await converter.convertRiveToHya(input);
  const files = converter.decodeRiveHyaArchive(result.packageBytes, converter.RIVE_CONVERSION_HARD_LIMITS);
  assert.ok(files.some(file => file.path === 'sidecars/vector-visual/visual-main.json'));
});

test('G10 dispatches every frozen G03-G09 capability through its source-neutral parser', async () => {
  const documents = capabilityDocuments();
  const artifacts = Object.entries(documents).map(([capability, document], index) => ({ id: `artifact-${index}`, capability, representation: 'native-semantic', document }));
  const coverage = artifacts.map((artifact, index) => ({
    objectId: 'object:00000000', propertyIds: index === 0 ? ['field:00000000:000000'] : [],
    capability: artifact.capability, representation: artifact.representation, artifactId: artifact.id,
  }));
  const featureLedger = artifacts.map((artifact, index) => ({ feature: `capability.${index}`, capability: artifact.capability, representation: artifact.representation, count: 1, artifactId: artifact.id }));
  const result = await converter.convertRiveToHya(await fixture({ artifacts, coverage, featureLedger }));
  const files = converter.decodeRiveHyaArchive(result.packageBytes, converter.RIVE_CONVERSION_HARD_LIMITS);
  for (const artifact of artifacts) assert.ok(files.some(file => file.path === `sidecars/${artifact.capability}/${artifact.id}.json`), artifact.capability);
  assert.deepEqual(result.manifest.featureLedger.map(entry => entry.feature), featureLedger.map(entry => entry.feature));
});

test('G10 reports an exact source object/property context for uncovered neutral fields', async () => {
  const input = await fixture({ coverage: [{ objectId: 'object:00000000', propertyIds: [], capability: 'hya-core', representation: 'native-semantic' }] });
  await assert.rejects(converter.convertRiveToHya(input), error => {
    assert.equal(error.code, 'E_RIVE_CONVERT_UNSUPPORTED');
    assert.equal(error.context.objectIndex, 0);
    assert.equal(error.context.objectTypeKey, 42);
    assert.equal(error.context.propertyKey, 7);
    assert.match(error.path, /field:00000000:000000/u);
    return true;
  });
});

test('G10 adaptive sampling is deterministic when evaluator results resolve in different orders', async () => {
  const plan = {
    id: 'curve', node: 'node', property: 'position', duration: 1, tolerance: 0.005,
    valueQuantum: 0.00001, timeQuantum: 0.00001, maxDepth: 5, deterministicVisual: true,
    observables: allObservables(false),
  };
  const input = await fixture({ bakedTracks: [plan] });
  const forward = {
    async extrema(requests) { return requests.map(request => ({ ...request, times: [] })); },
    async sample(requests) { return requests.map(({ trackId, time }) => ({ trackId, time, value: [time * time, Math.sin(time)] })); },
  };
  const reverse = {
    async extrema(requests) { return [...requests].reverse().map(request => ({ ...request, times: [] })); },
    async sample(requests) { return [...requests].reverse().map(({ trackId, time }) => ({ trackId, time, value: [time * time, Math.sin(time)] })); },
  };
  const first = await converter.convertRiveToHya(input, { evaluator: forward });
  const second = await converter.convertRiveToHya(input, { evaluator: reverse });
  assert.deepEqual(first.packageBytes, second.packageBytes);
  const parsed = parseAnimation(first.hyaBytes.buffer.slice(first.hyaBytes.byteOffset, first.hyaBytes.byteOffset + first.hyaBytes.byteLength));
  assert.ok(parsed.tracks[0].times.length > 2);
});

test('G10 extrema oracle preserves a narrow off-grid visual peak', async () => {
  const input = await fixture({
    bakedTracks: [{
      id: 'peak', node: 'node', property: 'opacity', duration: 1, tolerance: 0.02,
      valueQuantum: 0.0001, timeQuantum: 0.000001, maxDepth: 8, deterministicVisual: true, observables: allObservables(false),
    }],
  });
  const peak = 0.123;
  const evaluator = {
    async extrema(requests) { return requests.map(request => ({ ...request, times: peak > request.start && peak < request.end ? [peak] : [] })); },
    async sample(requests) { return requests.map(({ trackId, time }) => ({ trackId, time, value: [Math.max(0, 1 - Math.abs(time - peak) * 100)] })); },
  };
  const result = await converter.convertRiveToHya(input, { evaluator });
  const parsed = parseAnimation(result.hyaBytes.buffer.slice(result.hyaBytes.byteOffset, result.hyaBytes.byteOffset + result.hyaBytes.byteLength));
  assert.ok(Math.max(...parsed.tracks[0].values) >= 0.9999);
});

test('G10 package hash is invariant across locale and timezone processes', () => {
  const west = runLocaleProcess({ LANG: 'en_US.UTF-8', TZ: 'America/Los_Angeles' });
  const east = runLocaleProcess({ LANG: 'tr_TR.UTF-8', TZ: 'Asia/Shanghai' });
  assert.equal(west, east);
});

test('G10 never bakes observable interaction/data/layout/event/audio/semantic/script behavior', async () => {
  const input = await fixture({
    bakedTracks: [{
      id: 'bad', node: 'node', property: 'opacity', duration: 1, tolerance: 0.01,
      valueQuantum: 0.001, timeQuantum: 0.001, maxDepth: 2, deterministicVisual: true,
      observables: { ...allObservables(false), input: true },
    }],
  });
  await assert.rejects(
    converter.convertRiveToHya(input, { evaluator: { async sample() { return []; } } }),
    error => error.code === 'E_RIVE_CONVERT_BAKING_INELIGIBLE' && /input/u.test(error.message),
  );
});

test('G10 waits for a late evaluator result, then returns an exact abort without output', async () => {
  const input = await fixture({
    bakedTracks: [{
      id: 'late', node: 'node', property: 'opacity', duration: 1, tolerance: 0.01,
      valueQuantum: 0.001, timeQuantum: 0.001, maxDepth: 1, deterministicVisual: true, observables: allObservables(false),
    }],
  });
  const controller = new AbortController(); let lateResolved = false;
  const evaluator = {
    async extrema(requests) {
      await new Promise(resolve => setTimeout(resolve, 10)); lateResolved = true;
      return requests.map(request => ({ ...request, times: [] }));
    },
    async sample(requests) { return requests.map(({ trackId, time }) => ({ trackId, time, value: [time] })); },
  };
  const pending = converter.convertRiveToHya(input, { evaluator, signal: controller.signal });
  setTimeout(() => controller.abort('late-result-test'), 0);
  await assert.rejects(pending, error => error.code === 'E_RIVE_CONVERT_ABORTED');
  assert.equal(lateResolved, true);
});

test('G10 aborts the atomic owner and never commits partial staged output', async () => {
  const input = await fixture();
  const controller = new AbortController();
  const calls = [];
  const sink = {
    async stage(path) { calls.push(`stage:${path}`); controller.abort('stop-after-stage'); },
    async commit() { calls.push('commit'); },
    async abort() { calls.push('abort'); },
  };
  await assert.rejects(converter.convertRiveToHya(input, { signal: controller.signal, sink }), error => error.code === 'E_RIVE_CONVERT_ABORTED');
  assert.deepEqual(calls, ['stage:animation.hyapkg', 'abort']);
});

test('G10 fails missing assets and rejects archive traversal', async () => {
  const input = await fixture({
    baseDocument: baseDocument({ resources: [{ id: 'image', type: 'image', uri: 'asset:missing' }] }),
  });
  await assert.rejects(converter.convertRiveToHya(input), error => error.code === 'E_RIVE_CONVERT_ASSET_MISSING');
  assert.throws(
    () => converter.encodeRiveHyaArchive([{ path: '../escape', mediaType: 'x/test', bytes: new Uint8Array() }]),
    error => error.code === 'E_RIVE_CONVERT_FORMAT',
  );
});

test('G10 binds embedded assets to G02 integrity and content-addressed package paths', async () => {
  const bytes = encoder.encode('asset-payload'), contentSha256 = await digest(bytes);
  const input = await fixture({
    baseDocument: baseDocument({ resources: [{ id: 'image', type: 'image', uri: 'asset:image-main' }] }),
    assets: [{
      id: 'image-main', neutralResourceObjectId: 'resource:0001', kind: 'embedded', mimeType: 'image/png', bytes,
      revision: 'fixture-r1', licenseId: 'CC0-1.0',
    }],
  }, {
    resolvedResources: [{ objectId: 'resource:0001', contentSha256, byteLength: bytes.byteLength, mimeType: 'image/png', revision: 'fixture-r1' }],
  });
  const result = await converter.convertRiveToHya(input);
  assert.equal(result.manifest.assets[0].path, `assets/${contentSha256}`);
  const files = converter.decodeRiveHyaArchive(result.packageBytes, converter.RIVE_CONVERSION_HARD_LIMITS);
  assert.deepEqual(files.find(file => file.path === `assets/${contentSha256}`).bytes, bytes);

  input.evaluation.assets[0].bytes = encoder.encode('asset-tampered');
  await assert.rejects(converter.convertRiveToHya(input), error => error.code === 'E_RIVE_CONVERT_ASSET_INTEGRITY');
});

test('G10 permits immutable external assets only through an exact HTTPS origin allowlist', async () => {
  const contentSha256 = 'a'.repeat(64);
  const input = await fixture({
    baseDocument: baseDocument({ resources: [{ id: 'blob', type: 'binary', uri: 'asset:external-main' }] }),
    assets: [{
      id: 'external-main', neutralResourceObjectId: 'resource:external', kind: 'external', mimeType: 'application/octet-stream',
      uri: 'https://assets.example.test/revision/blob.bin', sha256: contentSha256, byteLength: 12,
      revision: 'immutable-r1', licenseId: 'MIT',
    }],
  }, {
    resolvedResources: [{ objectId: 'resource:external', contentSha256, byteLength: 12, mimeType: 'application/octet-stream', revision: 'immutable-r1' }],
  });
  await assert.rejects(converter.convertRiveToHya(input), error => error.code === 'E_RIVE_CONVERT_ASSET_MISSING');
  const result = await converter.convertRiveToHya(input, { approvedExternalOrigins: ['https://assets.example.test'] });
  assert.equal(result.manifest.assets[0].uri, 'https://assets.example.test/revision/blob.bin');
});

test('G10 rejects unknown evaluation fields instead of silently classifying them', async () => {
  const input = await fixture();
  input.evaluation.futureRiveFeature = true;
  await assert.rejects(converter.convertRiveToHya(input), error => error.code === 'E_RIVE_CONVERT_UNCLASSIFIED' && /futureRiveFeature/u.test(error.path));
});

async function fixture(overrides = {}, irOverrides = {}) {
  const ir = {
    schema: 'NeutralAnimationIR', version: 1, coordinateSystem: 'screen-y-down', units: 'css-pixel-like', colorSpace: 'unpremultiplied-srgb',
    objects: [{ id: 'object:00000000', family: 'structure', properties: [{ id: 'field:00000000:000000', value: { type: 'number', value: 1 } }] }],
    artboards: [], instances: [], nodes: ['object:00000000'], drawables: [], resources: [], geometry: [], paints: [], rigs: [], constraints: [], layouts: [], text: [], timelines: [], stateMachines: [], dataModels: [], interactions: [], events: [], audioSchedules: [], semantics: [], sandboxPrograms: [], resolvedResources: [],
    ...irOverrides,
  };
  const irBytes = encoder.encode(`${JSON.stringify(ir)}\n`);
  const inputIrSha256 = await digest(irBytes);
  const report = {
    schema: 'haiyue-rive-neutral-import-report', version: 1, compatibility: {},
    input: { sha256: '1'.repeat(64), byteLength: 8, fingerprint: 'RIVE', major: 7, minor: 3, fileId: 1 },
    counts: { objects: 1, runtimeNullObjects: 0, propertyAssignments: 1, strings: 0, textBytes: 0, embeddedBytes: 0, listItems: 0, resolvedAssets: 0 },
    registryCoverage: { declaredObjectTypes: 288, declaredPropertyKeys: 618, encounteredObjectTypeKeys: [42], encounteredPropertyKeys: [7], notSerializedRegistryPropertyKeys: [], unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0 },
    toc: [],
    objects: [{ neutralObjectId: 'object:00000000', sourceObjectIndex: 0, sourceTypeKey: 42, sourceName: 'SecretRiveSourceType', sourceFamily: 'Core', properties: [{ sourcePropertyKey: 7, sourceName: 'secretRiveProperty', sourceOwner: 'SecretRiveSourceType', wireKind: 'double', status: 'consumed', neutralFieldIds: ['field:00000000:000000'] }] }],
    runtimeNullObjects: [],
    evaluator: { used: true, adapterId: 'fixture' }, diagnostics: [],
  };
  const evaluation = {
    format: 'haiyue-rive-neutral-capability-evaluation', version: 1, inputIrSha256,
    tuple: { adapterId: 'fixture-adapter', adapterRevisionSha256: zeroHash, evaluatorId: 'fixture-evaluator', evaluatorRevisionSha256: zeroHash, optionsRevision: 'strict-v1' },
    baseDocument: baseDocument(), artifacts: [],
    coverage: [{ objectId: 'object:00000000', propertyIds: ['field:00000000:000000'], capability: 'hya-core', representation: 'native-semantic' }],
    bakedTracks: [], assets: [], featureLedger: [{ feature: 'core.node', capability: 'hya-core', representation: 'native-semantic', count: 1 }],
    classification: { unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0 },
    ...overrides,
  };
  return { imported: { ir, report, irBytes, reportBytes: encoder.encode('{}\n') }, evaluation };
}

function baseDocument(overrides = {}) {
  return { format: 'haiyue-animation', version: '1.0', canvas: { width: 64, height: 64, coordinateSystem: 'screen-y-down' }, duration: 1, nodes: [{ id: 'node' }], ...overrides };
}

function allObservables(value) {
  return { input: value, data: value, layoutResize: value, event: value, audio: value, semantics: value, script: value, resourceReplacement: value, stateExposure: value };
}

function minimalRiv(withArtboard = true) {
  return new Uint8Array([82, 73, 86, 69, 7, 3, 0, 0, ...(withArtboard ? [1, 0] : [])]);
}

function capabilityDocuments() {
  return {
    'vector-visual': { format: 'haiyue-vector-visual', version: 1, width: 64, height: 64, nodes: [] },
    'deformable-rig': { format: 'haiyue-parameterized-rig-2d', version: 2, extension: 'org.haiyue.deformable-mesh-2d@2', width: 64, height: 64, parameters: [], rigs: [], instances: [] },
    'responsive-layout': {
      format: 'haiyue-responsive-layout-2d', version: 1, extension: 'org.haiyue.layout-2d@1',
      shaping: { stack: 'haiyue-text-shaping@1', backendRevision: 'fixture', unicodeVersion: 'unicode15', graphemeRevision: 'grapheme1', bidiRevision: 'bidi1' },
      assets: [], textStyles: [], textBlocks: [], artboards: [], instances: [],
    },
    'state-machine': { format: 'haiyue-animation-state-machine@2', extension: 'org.haiyue.animation-state-machine@2', channels: [], clips: [], stateMachines: [] },
    'data-binding': { format: 'haiyue-data-binding', version: 1, extension: 'org.haiyue.data-binding@1', enums: [], models: [], instances: [], converters: [], propertyGroups: [], bindings: [], components: [] },
    interaction: { format: 'haiyue-interaction', version: 1, extension: 'org.haiyue.interaction@1', dragThreshold: 3, targets: [], listeners: [] },
    semantics: { format: 'haiyue-semantics', version: 1, extension: 'org.haiyue.semantics@1', nodes: [], reducedMotion: { mode: 'ignore' } },
    'audio-events': {
      format: 'haiyue-audio-events', version: 1, extension: 'org.haiyue.audio-events@1', playbackProfile: 'sample-accurate',
      clock: { sampleRate: 48000, lookAheadFrames: 128, driftToleranceFrames: 16, driftPolicy: 'resync', lateDecodePolicy: 'catch-up', visibilityPolicy: 'continue', suspendedPolicy: 'queue-until-resume' },
      browser: { autoplay: 'require-user-gesture' }, limits: { maxVoices: 1, maxVoicesPerResource: 1, maxDecodeJobs: 1, maxEventTokens: 1, maxDecodedFrames: 1, maxDecodedBytes: 1 },
      voiceStealing: 'reject', resources: [], buses: [], cues: [], timelineEvents: [],
    },
    'sandbox-script': {
      extension: 'org.haiyue.sandboxed-animation-script@1', version: 1,
      language: {
        source: 'luau', sourcePolicy: 'build-time-only', sourceRevisionSha256: 'b99f06310ba0e09c3402dd2be37d8447dd63ee980e7d42dd7396e26117cea661',
        artifact: 'haiyue-portable-script@1', numericMode: 'ieee754-f64-canonical-nan', stringMode: 'utf8', tableMode: 'insertion-ordered-own-keys',
        modulePolicy: 'closed-manifest', clock: 'injected-integer-microseconds', random: 'injected-seeded-xoshiro128',
      },
      limits: { ...DEFAULT_SANDBOXED_ANIMATION_SCRIPT_LIMITS }, programs: [], shaders: [],
    },
  };
}

async function digest(bytes) {
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function addJsExtensions(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await addJsExtensions(path);
    else if (entry.name.endsWith('.js')) {
      const source = await readFile(path, 'utf8');
      const patched = source.replace(/(from\s+|import\s*)(['"])(\.\.?\/[^'"]+)\2/gu, (match, prefix, quote, specifier) => {
        return /\.(?:js|json|mjs|cjs)$/u.test(specifier) ? match : `${prefix}${quote}${specifier}.js${quote}`;
      });
      if (patched !== source) await writeFile(path, patched);
    }
  }
}

function runLocaleProcess(environment) {
  const source = `
    const c = await import(${JSON.stringify(converterModuleHref)});
    const e = new TextEncoder();
    const ir = { schema:'NeutralAnimationIR',version:1,coordinateSystem:'screen-y-down',units:'css-pixel-like',colorSpace:'unpremultiplied-srgb',objects:[],artboards:[],instances:[],nodes:[],drawables:[],resources:[],geometry:[],paints:[],rigs:[],constraints:[],layouts:[],text:[],timelines:[],stateMachines:[],dataModels:[],interactions:[],events:[],audioSchedules:[],semantics:[],sandboxPrograms:[],resolvedResources:[] };
    const irBytes=e.encode(JSON.stringify(ir)+'\\n');
    const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
    const inputIrSha256=await digest(irBytes), z='0'.repeat(64);
    const report={schema:'haiyue-rive-neutral-import-report',version:1,compatibility:{},input:{sha256:'1'.repeat(64),byteLength:8,fingerprint:'RIVE',major:7,minor:3,fileId:1},counts:{objects:0,runtimeNullObjects:0,propertyAssignments:0,strings:0,textBytes:0,embeddedBytes:0,listItems:0,resolvedAssets:0},registryCoverage:{declaredObjectTypes:288,declaredPropertyKeys:618,encounteredObjectTypeKeys:[],encounteredPropertyKeys:[],notSerializedRegistryPropertyKeys:[],unclassifiedObjects:0,unclassifiedProperties:0,unclassifiedAssets:0,unclassifiedScripts:0},toc:[],objects:[],runtimeNullObjects:[],evaluator:{used:true,adapterId:'fixture'},diagnostics:[]};
    const evaluation={format:'haiyue-rive-neutral-capability-evaluation',version:1,inputIrSha256,tuple:{adapterId:'locale-adapter',adapterRevisionSha256:z,evaluatorId:'locale-evaluator',evaluatorRevisionSha256:z,optionsRevision:'v1'},baseDocument:{format:'haiyue-animation',version:'1.0',canvas:{width:1,height:1,coordinateSystem:'screen-y-down'},duration:1,nodes:[]},artifacts:[],coverage:[],bakedTracks:[],assets:[],featureLedger:[],classification:{unclassifiedObjects:0,unclassifiedProperties:0,unclassifiedAssets:0,unclassifiedScripts:0}};
    const result=await c.convertRiveToHya({imported:{ir,report,irBytes,reportBytes:e.encode('{}\\n')},evaluation});
    process.stdout.write(result.report.output.packageSha256);
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, ...environment } }).trim();
}
