import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { evaluate, mapEmbeddedAssets } from './rive-production-capability-provider.mjs';

test('production capability provider preserves all neutral fields and maps core canvas/transform values', async () => {
  const descriptor = { adapterId: 'adapter', adapterRevisionSha256: 'a'.repeat(64), evaluatorId: 'evaluator', evaluatorRevisionSha256: 'b'.repeat(64), optionsRevision: 'v1' };
  const properties = [
    { id: 'field:00000000:000000', value: { type: 'number', value: 320 } },
    { id: 'field:00000000:000001', value: { type: 'number', value: 180 } },
    { id: 'field:00000000:000002', value: { type: 'string', value: 'Main' } },
  ];
  const object = { id: 'object:00000000', family: 'structure', properties };
  const visit = {
    neutralObjectId: object.id, sourceName: 'Artboard', sourceTypeKey: 1,
    properties: [
      { sourceName: 'width', neutralFieldIds: [properties[0].id] },
      { sourceName: 'height', neutralFieldIds: [properties[1].id] },
      { sourceName: 'name', neutralFieldIds: [properties[2].id] },
    ],
  };
  const result = await evaluate({
    inputIrSha256: 'c'.repeat(64),
    imported: { ir: { objects: [object], artboards: [object.id], nodes: [object.id] }, report: { objects: [visit] } },
  }, { descriptor });
  assert.deepEqual(result.baseDocument.canvas, { width: 320, height: 180, coordinateSystem: 'screen-y-down' });
  assert.equal(result.baseDocument.nodes[0].name, 'Main');
  assert.deepEqual(result.baseDocument.nodes[0].extensions.neutralFields, Object.fromEntries(properties.map(value => [value.id, value.value])));
  assert.equal(result.coverage[0].propertyIds.length, 3);
  assert.equal(result.tuple, descriptor);
});

test('production capability provider maps resolved resources to byte-exact embedded assets', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assets = mapEmbeddedAssets([
    { objectId: 'object:00000001', contentSha256: sha256, byteLength: 3, mimeType: 'image/png', revision: `embedded:${sha256}` },
  ], [{ assetId: 7, bytes, mimeType: 'image/png' }]);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].neutralResourceObjectId, 'object:00000001');
  assert.deepEqual(assets[0].bytes, bytes);
  assert.match(assets[0].licenseId, /Apache-2.0/u);
});
