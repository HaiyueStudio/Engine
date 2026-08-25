import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  FROZEN_OBJECTS,
  FROZEN_PROPERTIES,
  FROZEN_REGISTRY_IDENTITY,
  FROZEN_RIVE_BUILD_INTEGRATION,
  FROZEN_RIVE_REGISTRY_COUNTS,
  RiveImportError,
  importFrozenRiv,
} from '../dist-test/conversion/rive-ir/index.js';

const vu = value => {
  let remaining = BigInt(value >>> 0);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return bytes;
};
const utf8 = value => [...new TextEncoder().encode(value)];
const str = value => [...vu(utf8(value).length), ...utf8(value)];
const blob = value => [...vu(value.length), ...value];
const f32 = value => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value, true); return [...b]; };
const u32 = value => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, true); return [...b]; };
const object = (typeKey, fields = []) => [...vu(typeKey), ...fields.flat(), 0];
const riv = (objects = [], { major = 7, minor = 3, toc = [] } = {}) => {
  const header = [...utf8('RIVE'), ...vu(major), ...vu(minor), 0, ...toc.flatMap(entry => vu(entry.key)), 0];
  for (let index = 0; index < toc.length; index += 4) {
    let packed = 0;
    for (let slot = 0; slot < 4 && index + slot < toc.length; slot++) packed |= toc[index + slot].type << (slot * 2);
    header.push(...u32(packed));
  }
  return new Uint8Array([...header, ...objects.flat()]);
};
const field = (key, payload) => [...vu(key), ...payload];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const evaluatorDescriptor = {
  adapterId: 'fixture-oracle', package: '@rive-app/webgl2', version: '2.40.0',
  riveJsSha256: 'd25d57588f63382b662a00b54b73164f7dcda65759dfcfa1009931d3a1ae1714',
  riveWasmSha256: '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32',
  enforcesDecodedBudgets: true,
  buildFlags: { WITH_RIVE_TEXT: true, WITH_RIVE_LAYOUT: true, WITH_RIVE_AUDIO: true, WITH_RIVE_SCRIPTING: true, RIVE_DECODERS: true, RIVE_PNG: true, RIVE_JPEG: true, RIVE_WEBP: true, RIVE_WEBGL: true },
};

function assertCode(error, code) {
  assert.ok(error instanceof RiveImportError);
  assert.equal(error.code, code);
  return true;
}

test('frozen registry is complete, unique, immutable, and reverse-covered', () => {
  assert.deepEqual(FROZEN_RIVE_REGISTRY_COUNTS, { objects: 288, properties: 618 });
  assert.equal(new Set(FROZEN_OBJECTS.map(item => item.typeKey)).size, 288);
  assert.equal(new Set(FROZEN_PROPERTIES.map(item => item.key)).size, 618);
  assert.deepEqual(
    [565, 677, 856, 861, 862, 863, 978].filter(key => FROZEN_PROPERTIES.some(property => property.key === key)),
    [565, 677, 856, 861, 862, 863, 978],
  );
  for (const property of FROZEN_PROPERTIES) {
    assert.ok(!property.serialized || FROZEN_OBJECTS.some(object => object.lineage.includes(property.owner)), `${property.owner}.${property.name}`);
  }
  assert.equal(FROZEN_REGISTRY_IDENTITY.coreRegistrySha256, '1927c7c1edaa020f17cd5a0c900562e955c550b9019a6bcb03a7feb0705aa675');
  assert.equal(FROZEN_RIVE_BUILD_INTEGRATION.isolation, 'build-time-only');
  assert.deepEqual(FROZEN_RIVE_BUILD_INTEGRATION.runtimeSource.patches, []);
  assert.throws(() => { FROZEN_OBJECTS[0].name = 'mutated'; }, TypeError);
  assert.throws(() => { FROZEN_PROPERTIES[0].wireKind = 'bytes'; }, TypeError);
});

test('reader consumes every wire kind and emits immutable neutral IR plus exhaustive ledger', async () => {
  const bytes = riv([
    object(1, [field(4, str('Main')), field(7, f32(640))]),
    object(30, [field(70, f32(1.25))]),
    object(37, [field(88, u32(0x80402010))]),
    object(84, [field(181, [1])]),
    object(1067, [field(1068, vu(3))]),
    object(643, [field(920, blob([1, 2, 3]))]),
  ]);
  const result = await importFrozenRiv(bytes);
  assert.equal(result.ir.schema, 'NeutralAnimationIR');
  assert.equal(result.ir.version, 1);
  assert.equal(result.ir.artboards.length, 1);
  assert.equal(result.report.counts.objects, 6);
  assert.equal(result.report.counts.runtimeNullObjects, 0);
  assert.equal(result.report.counts.propertyAssignments, 7);
  assert.equal(result.report.counts.listItems, 3);
  assert.deepEqual(result.report.diagnostics, []);
  const artboardVisit = result.report.objects[0];
  assert.equal(artboardVisit.properties.find(item => item.sourcePropertyKey === 4).status, 'consumed');
  assert.equal(artboardVisit.properties.find(item => item.sourcePropertyKey === 8).status, 'not-serialized');
  assert.ok(artboardVisit.properties.every(item => ['consumed', 'not-serialized', 'explicit-default'].includes(item.status)));
  assert.throws(() => { result.ir.objects.push('x'); }, TypeError);
  assert.equal(new TextDecoder().decode(result.irBytes).endsWith('\n'), true);
  assert.equal(new TextDecoder().decode(result.reportBytes).endsWith('\n'), true);
});

test('same bytes and async asset completion in different orders produce byte-exact outputs', async () => {
  const bytes = riv([
    object(105, [field(203, str('one.png')), field(204, vu(1)), field(359, blob([1])), field(362, str('https://assets.example/rive'))]),
    object(105, [field(203, str('two.png')), field(204, vu(2)), field(359, blob([2])), field(362, str('https://assets.example/rive'))]),
  ]);
  const assetBytes = new Map([[1, new Uint8Array([1, 2, 3])], [2, new Uint8Array([4, 5])]]);
  const manifest = [...assetBytes].map(([assetId, content]) => ({
    assetId, revision: `rev-${assetId}`, sha256: digest(content), byteLength: content.length,
    mimeType: 'image/png', licenseId: 'fixture-mit', allowedUse: 'test',
  }));
  const run = reverse => importFrozenRiv(bytes, {
    concurrency: reverse ? 8 : 1,
    allowedHostedOrigins: ['https://assets.example'],
    assetManifest: manifest,
    assetResolver: { async resolve(request) { await delay(reverse ? (3 - request.assetId) * 8 : request.assetId * 8); return { bytes: assetBytes.get(request.assetId), mimeType: 'image/png' }; } },
  });
  const [forward, reverse] = await Promise.all([run(false), run(true)]);
  assert.deepEqual(forward.irBytes, reverse.irBytes);
  assert.deepEqual(forward.reportBytes, reverse.reportBytes);
});

test('embedded resource is hashed and associated without a resolver', async () => {
  const bytes = riv([
    object(105, [field(203, str('embedded.png')), field(204, vu(7))]),
    object(106, [field(212, blob([9, 8, 7]))]),
  ]);
  const result = await importFrozenRiv(bytes);
  assert.equal(result.ir.resolvedResources.length, 1);
  assert.equal(result.ir.resolvedResources[0].contentSha256, digest(new Uint8Array([9, 8, 7])));
});

test('duplicate file asset ids use the frozen official importer recovery in file order', async () => {
  const bytes = riv([
    object(105, [field(203, str('first.png')), field(204, vu(0))]),
    object(106, [field(212, blob([1]))]),
    object(105, [field(203, str('second.png')), field(204, vu(0))]),
    object(106, [field(212, blob([2]))]),
  ]);
  const evaluatorAssetIds = [];
  const result = await importFrozenRiv(bytes, {
    evaluator: {
      descriptor: evaluatorDescriptor,
      async evaluate(_bytes, assets) {
        evaluatorAssetIds.push(...assets.map(asset => asset.assetId));
        return { evidence: { recovered: true } };
      },
    },
  });
  assert.deepEqual(evaluatorAssetIds, [0, 1]);
  assert.equal(result.ir.resolvedResources.length, 2);
});

test('asset missing, hosted policy, and hash mismatch are exact failures with no result', async () => {
  const bytes = riv([object(105, [field(203, str('remote.png')), field(204, vu(4)), field(362, str('https://assets.example/rive'))])]);
  const expected = new Uint8Array([1]);
  const manifest = [{ assetId: 4, revision: 'rev', sha256: digest(expected), byteLength: 1, mimeType: 'image/png', licenseId: 'fixture', allowedUse: 'test' }];
  await assert.rejects(importFrozenRiv(bytes, { assetManifest: manifest, allowedHostedOrigins: ['https://assets.example'] }), error => assertCode(error, 'E_RIVE_ASSET_MISSING'));
  await assert.rejects(importFrozenRiv(bytes, { assetManifest: manifest, assetResolver: { async resolve() { return { bytes: expected, mimeType: 'image/png' }; } } }), error => assertCode(error, 'E_RIVE_ASSET_URL_POLICY'));
  await assert.rejects(importFrozenRiv(bytes, {
    assetManifest: manifest, allowedHostedOrigins: ['https://assets.example'],
    assetResolver: { async resolve() { return { bytes: new Uint8Array([2]), mimeType: 'image/png' }; } },
  }), error => assertCode(error, 'E_RIVE_ASSET_INTEGRITY'));
});

test('abort and timeout wait for late resolver cleanup and never return a partial result', async () => {
  const bytes = riv([object(105, [field(204, vu(4)), field(362, str('https://assets.example/rive'))])]);
  const content = new Uint8Array([1]);
  const manifest = [{ assetId: 4, revision: 'rev', sha256: digest(content), byteLength: 1, mimeType: 'image/png', licenseId: 'fixture', allowedUse: 'test' }];
  let active = 0;
  const resolver = { async resolve() { active++; try { await delay(15); return { bytes: content, mimeType: 'image/png' }; } finally { active--; } } };
  const controller = new AbortController();
  const pending = importFrozenRiv(bytes, { signal: controller.signal, assetManifest: manifest, allowedHostedOrigins: ['https://assets.example'], assetResolver: resolver });
  controller.abort();
  await assert.rejects(pending, error => assertCode(error, 'E_RIVE_ABORTED'));
  assert.equal(active, 0);
  await assert.rejects(importFrozenRiv(bytes, {
    limits: { importWallMs: 1 }, assetManifest: manifest, allowedHostedOrigins: ['https://assets.example'], assetResolver: resolver,
  }), error => assertCode(error, 'E_RIVE_LIMIT_EXCEEDED'));
  assert.equal(active, 0);
});

test('official evaluator is injected, pinned, plain-data hashed, and absent from package dependencies', async () => {
  const bytes = riv([object(105, [field(204, vu(9))]), object(106, [field(212, blob([4, 2]))])]);
  const descriptor = evaluatorDescriptor;
  let handoff;
  const result = await importFrozenRiv(bytes, { evaluator: { descriptor, async evaluate(_bytes, assets, limits, signal) { handoff = { assets, limits, signal }; return { evidence: { b: 2, a: 1 } }; } } });
  assert.equal(result.report.evaluator.used, true);
  assert.equal(result.report.evaluator.adapterId, 'fixture-oracle');
  assert.equal(handoff.assets.length, 1);
  assert.deepEqual(handoff.assets[0].bytes, new Uint8Array([4, 2]));
  assert.equal(handoff.limits.decodedWorkingSetBytes, 512 * 1024 * 1024);
  assert.equal(handoff.signal.aborted, false);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.dependencies?.['@rive-app/webgl2'], undefined);
  assert.equal(packageJson.devDependencies?.['@rive-app/webgl2'], undefined);
});
