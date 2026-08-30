import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  applyComponentListLayout,
  applySimpleLayoutTransforms,
  applySelectedAnimationOverrides,
  applySoloSelection,
  applyViewModelText,
  evaluate,
  mapEmbeddedAssets,
  textWrapMode,
  vertexPath,
} from './rive-production-capability-provider.mjs';
import { FROZEN_PROPERTIES } from '../../animation-spec/dist-test/rive/import/generated/frozen-registry.js';
import { parseHyaStateMachineV2 } from '../../animation-spec/dist-test/state-machine-v2/parser.js';
import { parseHyaDataBinding } from '../../animation-spec/dist-test/data-binding/parser.js';

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

test('production capability provider binds the requested artboard before compiling the HYA canvas', async () => {
  const descriptor = { adapterId: 'adapter', adapterRevisionSha256: 'a'.repeat(64), evaluatorId: 'evaluator', evaluatorRevisionSha256: 'b'.repeat(64), optionsRevision: 'selection-v1' };
  const artboard = (index, name, width) => {
    const id = `object:${String(index).padStart(8, '0')}`;
    const properties = [
      { id: `field:${String(index).padStart(8, '0')}:000000`, value: { type: 'string', value: name } },
      { id: `field:${String(index).padStart(8, '0')}:000001`, value: { type: 'number', value: width } },
      { id: `field:${String(index).padStart(8, '0')}:000002`, value: { type: 'number', value: 100 } },
    ];
    return {
      object: { id, family: 'structure', properties },
      visit: {
        neutralObjectId: id, sourceName: 'Artboard', sourceTypeKey: 1,
        properties: [
          { sourceName: 'name', neutralFieldIds: [properties[0].id] },
          { sourceName: 'width', neutralFieldIds: [properties[1].id] },
          { sourceName: 'height', neutralFieldIds: [properties[2].id] },
        ],
      },
    };
  };
  const first = artboard(0, 'First', 100); const selected = artboard(1, 'Selected', 640);
  const result = await evaluate({
    inputIrSha256: 'c'.repeat(64), selection: { artboard: 'Selected' },
    imported: {
      ir: { objects: [first.object, selected.object], artboards: [first.object.id, selected.object.id], nodes: [first.object.id, selected.object.id] },
      report: { objects: [first.visit, selected.visit] },
    },
  }, { descriptor });
  assert.equal(result.baseDocument.name, 'Selected');
  assert.deepEqual(result.baseDocument.canvas, { width: 640, height: 100, coordinateSystem: 'screen-y-down' });
  assert.deepEqual(result.baseDocument.nodes.map(node => node.id), [selected.object.id]);
});

test('production capability provider emits parser-valid executable state-machine and data-binding artifacts', async () => {
  const descriptor = { adapterId: 'adapter', adapterRevisionSha256: 'a'.repeat(64), evaluatorId: 'evaluator', evaluatorRevisionSha256: 'b'.repeat(64), optionsRevision: 'capability-sidecars-v1' };
  const row = (index, sourceName, fields = {}) => {
    const id = `object:${String(index).padStart(8, '0')}`;
    const properties = Object.entries(fields).map(([name, value], propertyIndex) => ({
      id: `field:${String(index).padStart(8, '0')}:${String(propertyIndex).padStart(6, '0')}`,
      value: { type: typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : 'number', value },
      name,
    }));
    return {
      object: { id, family: 'structure', properties: properties.map(({ name: _name, ...property }) => property) },
      visit: {
        neutralObjectId: id, sourceName, sourceTypeKey: index + 1,
        properties: properties.map(property => ({ sourceName: property.name, neutralFieldIds: [property.id] })),
      },
    };
  };
  const rows = [
    row(0, 'Artboard', { name: 'Main', width: 320, height: 180 }),
    row(1, 'ViewModel', { name: 'Model' }),
    row(2, 'ViewModelInstanceString', { propertyValue: 'bound text' }),
    row(3, 'StateMachine', { name: 'Machine' }),
    row(4, 'StateMachineBool', { name: 'Enabled', value: true }),
  ];
  const result = await evaluate({
    inputIrSha256: 'c'.repeat(64),
    imported: {
      ir: { objects: rows.map(value => value.object), artboards: [rows[0].object.id], nodes: [rows[0].object.id] },
      report: { objects: rows.map(value => value.visit) },
    },
  }, { descriptor });
  const state = result.artifacts.find(value => value.capability === 'state-machine');
  const data = result.artifacts.find(value => value.capability === 'data-binding');
  assert.equal(parseHyaStateMachineV2(state.document).stateMachines[0].inputs[0].defaultValue, true);
  assert.equal(parseHyaDataBinding(data.document).instances[0].values['neutral-000001'], 'bound text');
  assert.equal(result.coverage.find(value => value.objectId === rows[3].object.id).artifactId, state.id);
  assert.equal(result.coverage.find(value => value.objectId === rows[1].object.id).artifactId, data.id);
});

test('selected animation initializes Solo activeComponentId before inactive subtrees are removed', async () => {
  const activeComponentId = FROZEN_PROPERTIES.find(value => value.name === 'activeComponentId')?.key;
  assert.equal(typeof activeComponentId, 'number');
  const row = (index, sourceName, fields = {}) => {
    const id = `object:${String(index).padStart(8, '0')}`;
    const properties = Object.entries(fields).map(([name, value], fieldIndex) => ({
      id: `field:${String(index).padStart(8, '0')}:${String(fieldIndex).padStart(6, '0')}`,
      value: { type: typeof value === 'string' ? 'string' : 'number', value }, name,
    }));
    return {
      id,
      object: { id, family: 'structure', properties: properties.map(({ name: _name, ...property }) => property) },
      visit: { neutralObjectId: id, sourceName, sourceTypeKey: index + 1, properties: properties.map(property => ({ sourceName: property.name, neutralFieldIds: [property.id] })) },
    };
  };
  const rows = [
    row(0, 'Artboard', { name: 'Main' }),
    row(1, 'Solo', { activeComponentId: 2 }),
    row(2, 'NestedArtboard', { parentId: 1, name: 'first' }),
    row(3, 'NestedArtboard', { parentId: 1, name: 'selected' }),
    row(4, 'LinearAnimation', { name: 'Select second' }),
    row(5, 'KeyedObject', { objectId: 1 }),
    row(6, 'KeyedProperty', { propertyKey: activeComponentId }),
    row(7, 'KeyFrameId', { value: 3 }),
  ];
  const hierarchy = {
    entries: rows.slice(0, 4).map((rowValue, componentIndex) => ({
      componentIndex, objectId: rowValue.id, sourceName: rowValue.visit.sourceName,
      fields: Object.fromEntries(rowValue.visit.properties.map(property => {
        const field = rowValue.object.properties.find(value => value.id === property.neutralFieldIds[0]);
        return [property.sourceName, field.value.value];
      })), nodeEligible: true,
    })),
  };
  const objects = new Map(rows.map(value => [value.id, value.object]));
  const report = { objects: rows.map(value => value.visit) };

  await applySelectedAnimationOverrides(hierarchy, report, objects, rows[0].id, 'Select second');
  applySoloSelection(hierarchy);

  assert.equal(hierarchy.entries[1].fields.activeComponentId, 3);
  assert.equal(hierarchy.entries[2].nodeEligible, false);
  assert.equal(hierarchy.entries[3].nodeEligible, true);
  assert.deepEqual(hierarchy.selectedAnimationsApplied, ['Select second']);
});

test('view-model text replacement only changes runs with an authored data binding', () => {
  const hierarchy = { entries: [
    { objectId: 'label', sourceObjectId: 'label', sourceName: 'TextValueRun', fields: { text: 'CASE ID:' } },
    { objectId: 'value', sourceObjectId: 'value', sourceName: 'TextValueRun', fields: { text: '--000' } },
  ] };
  const report = { objects: [
    { neutralObjectId: 'label', sourceName: 'TextValueRun' },
    { neutralObjectId: 'value', sourceName: 'TextValueRun' },
    { neutralObjectId: 'binding', sourceName: 'DataBindContext' },
  ] };

  applyViewModelText(hierarchy, { case_id: '--001' }, report);

  assert.equal(hierarchy.entries[0].fields.text, 'CASE ID:');
  assert.equal(hierarchy.entries[1].fields.text, '--001');
});

test('component-list rows use intrinsic text widths before flex placement', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { width: 200, height: 20, styleId: 1 } },
    { componentIndex: 1, scopeKey: 'scope', sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 0, intrinsicallySizedValue: true } },
    { componentIndex: 2, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 100, height: 20, styleId: 4 } },
    { componentIndex: 3, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 100, height: 20, styleId: 5 } },
    { componentIndex: 4, scopeKey: 'scope', sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 2, intrinsicallySizedValue: true } },
    { componentIndex: 5, scopeKey: 'scope', sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 3, intrinsicallySizedValue: true } },
    { componentIndex: 6, scopeKey: 'scope', sourceName: 'Text', nodeEligible: true, transformTarget: true, fields: { parentId: 2 } },
    { componentIndex: 7, scopeKey: 'scope', sourceName: 'TextValueRun', nodeEligible: true, transformTarget: false, fields: { parentId: 6, text: 'NEW', styleId: 8 } },
    { componentIndex: 8, scopeKey: 'scope', sourceName: 'TextStylePaint', nodeEligible: true, transformTarget: false, fields: { parentId: 6, fontSize: 20 } },
    { componentIndex: 9, scopeKey: 'scope', sourceName: 'Text', nodeEligible: true, transformTarget: true, fields: { parentId: 3 } },
    { componentIndex: 10, scopeKey: 'scope', sourceName: 'TextValueRun', nodeEligible: true, transformTarget: false, fields: { parentId: 9, text: '--001', styleId: 11 } },
    { componentIndex: 11, scopeKey: 'scope', sourceName: 'TextStylePaint', nodeEligible: true, transformTarget: false, fields: { parentId: 9, fontSize: 20 } },
  ] };

  applyComponentListLayout(hierarchy);
  applySimpleLayoutTransforms(hierarchy);

  assert.equal(hierarchy.entries[1].fields.flexDirectionValue, 1);
  assert.equal(hierarchy.entries[2].fields.width, 36);
  assert.equal(hierarchy.entries[3].fields.width, 60);
  assert.deepEqual([hierarchy.entries[2].fields.x, hierarchy.entries[2].fields.y], [0, 0]);
  assert.deepEqual([hierarchy.entries[3].fields.x, hierarchy.entries[3].fields.y], [36, 0]);
});

test('text wider than its authored box receives deterministic word wrapping', () => {
  assert.equal(textWrapMode('short', 100, 12), undefined);
  assert.equal(textWrapMode('A long dossier description that exceeds its box', 100, 12), 'word');
  assert.equal(textWrapMode('forced', 1000, 12, 1), 'word');
});

test('Rive cubic vertices retain incoming and outgoing handles in HYA path commands', () => {
  const path = vertexPath([
    { sourceName: 'CubicDetachedVertex', fields: { x: 0, y: 0, outRotation: 0, outDistance: 10 } },
    { sourceName: 'CubicDetachedVertex', fields: { x: 100, y: 0, inRotation: Math.PI, inDistance: 20 } },
  ], false);
  assert.equal(path.commands, 'MC');
  assert.deepEqual(path.values.map(value => Math.round(value)), [0, 0, 10, 0, 80, 0, 100, 0]);
});
