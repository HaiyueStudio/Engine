import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from './rive-production-capability-provider.mjs';

test('production capability provider preserves all neutral fields and maps core canvas/transform values', async () => {
  const descriptor = { adapterId: 'adapter', adapterRevisionSha256: 'a'.repeat(64), evaluatorId: 'evaluator', evaluatorRevisionSha256: 'b'.repeat(64), optionsRevision: 'v1' };
  const properties = [
    { id: 'field:00000000:000000', value: { type: 'number', value: 320 } },
    { id: 'field:00000000:000001', value: { type: 'number', value: 180 } },
    { id: 'field:00000000:000002', value: { type: 'string', value: 'Main' } },
  ];
  const object = { id: 'object:00000000', family: 'structure', properties };
  const visit = {
    neutralObjectId: object.id,
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
