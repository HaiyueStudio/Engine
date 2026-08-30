import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  applyComponentListLayout,
  applySimpleLayoutTransforms,
  applySelectedAnimationOverrides,
  applySoloSelection,
  applyViewModelText,
  compileTextComponents,
  compileComponentListInteractionDocument,
  evaluate,
  finalizeComponentListMetrics,
  mapEmbeddedAssets,
  textWrapMode,
  vertexPath,
} from './rive-production-capability-provider.mjs';
import { FROZEN_PROPERTIES } from '../../animation-spec/dist-test/rive/import/generated/frozen-registry.js';
import { parseHyaStateMachineV2 } from '../../animation-spec/dist-test/state-machine-v2/parser.js';
import { parseHyaDataBinding } from '../../animation-spec/dist-test/data-binding/parser.js';
import { parseHyaInteraction } from '../../animation-spec/dist-test/interaction/parser.js';

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

test('component-list interaction sidecar carries hover, click, audio and four executable row states', () => {
  const root = 'list::idle::root';
  const hierarchy = {
    entries: [{ objectId: root, fields: { x: 140, y: 355, scaleX: 1, scaleY: 1 } }],
    parentNodeByObjectId: new Map(),
    componentLists: [{ host: 'list-host', rows: [{
      index: 0, sourceIndex: 0, baseX: 0, baseY: 0, collapsedHeight: 27, expandedHeight: 259, hitWidth: 272,
      nodes: { idle: root, hover: 'list::hover::root', open: 'list::open::root', openHover: 'list::openHover::root' },
    }] }],
  };
  const records = [
    { visit: { sourceName: 'AudioEvent' }, fields: { name: 'open_01', assetId: 1 } },
    { visit: { sourceName: 'AudioEvent' }, fields: { name: 'click_01', assetId: 2 } },
    { visit: { sourceName: 'AudioEvent' }, fields: { name: 'open_menu_02', assetId: 3 } },
    { visit: { sourceName: 'AudioEvent' }, fields: { name: 'close_menu_01', assetId: 4 } },
  ];
  const document = parseHyaInteraction(compileComponentListInteractionDocument(hierarchy, records, new Map([
    [1, { resourceId: 'resource-main-click' }], [2, { resourceId: 'resource-hover' }],
    [3, { resourceId: 'resource-open' }], [4, { resourceId: 'resource-close' }],
  ])));
  assert.deepEqual(document.targets[0].transform, [1, 0, 0, 1, 140, 355]);
  assert.deepEqual(document.listeners.map(listener => listener.event), ['pointer-enter', 'pointer-exit', 'click']);
  assert.equal(document.listeners[0].actions[0].arguments.openHoverNode, 'list::openHover::root');
  assert.equal(document.listeners[0].actions[1].target, 'resource-hover');
  assert.equal(document.listeners[2].actions[0].target, 'resource-main-click');
  assert.equal(document.listeners[2].actions[1].arguments.openAudio, 'resource-open');
  assert.equal(document.listeners[2].actions[1].arguments.closeAudio, 'resource-close');
});

test('component-list expanded metrics use the post-layout open variant height', () => {
  const root = { objectId: 'open-root', sourceName: 'Artboard', fields: { scaleY: 0.5 } };
  const content = { objectId: 'open-content', sourceName: 'LayoutComponent', fields: { height: 582 } };
  const row = { nodes: { open: root.objectId }, expandedHeight: 259 };
  const hierarchy = {
    entries: [root, content], componentLists: [{ rows: [row] }],
    parentNodeByObjectId: new Map([[content.objectId, root.objectId]]),
  };

  finalizeComponentListMetrics(hierarchy);

  assert.equal(row.expandedHeight, 291);
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

test('selected animation preserves omitted zero-valued Rive keyframes', async () => {
  const displayValue = FROZEN_PROPERTIES.find(value => value.name === 'displayValue')?.key;
  assert.equal(typeof displayValue, 'number');
  const rows = [
    { id: 'root', sourceName: 'Artboard', fields: { name: 'Main' } },
    { id: 'style', sourceName: 'LayoutComponentStyle', fields: { displayValue: 1 } },
    { id: 'animation', sourceName: 'LinearAnimation', fields: { name: 'open' } },
    { id: 'target', sourceName: 'KeyedObject', fields: { objectId: 1 } },
    { id: 'property', sourceName: 'KeyedProperty', fields: { propertyKey: displayValue } },
    { id: 'key', sourceName: 'KeyFrameUint', fields: {} },
  ];
  const objects = new Map(rows.map((row, index) => [row.id, {
    id: row.id, family: 'structure', properties: Object.entries(row.fields).map(([name, value], fieldIndex) => ({
      id: `field:${index}:${fieldIndex}`, value: { type: typeof value === 'string' ? 'string' : 'number', value }, name,
    })).map(({ name: _name, ...value }) => value),
  }]));
  const report = { objects: rows.map((row, index) => ({
    neutralObjectId: row.id, sourceName: row.sourceName, sourceTypeKey: index + 1,
    properties: Object.keys(row.fields).map((name, fieldIndex) => ({ sourceName: name, neutralFieldIds: [`field:${index}:${fieldIndex}`] })),
  })) };
  const hierarchy = { entries: rows.slice(0, 2).map((row, componentIndex) => ({ componentIndex, objectId: row.id, sourceName: row.sourceName, fields: { ...row.fields } })) };

  await applySelectedAnimationOverrides(hierarchy, report, objects, 'root', 'open');

  assert.equal(hierarchy.entries[1].fields.displayValue, 0);
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

test('responsive layout infers an authored horizontal-gap row and resolves hug height', () => {
  const scopeKey = 'host::list-000000::open::artboard';
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { width: 10, height: 10, styleId: 1 } },
    { componentIndex: 1, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 0, gapHorizontal: 10, paddingLeft: 5, paddingRight: 5, paddingTop: 2, paddingBottom: 2, intrinsicallySizedValue: true } },
    { componentIndex: 2, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 40, height: 30, styleId: 4 } },
    { componentIndex: 3, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 60, height: 20, styleId: 5 } },
    { componentIndex: 4, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 2 } },
    { componentIndex: 5, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 3 } },
  ] };

  applyComponentListLayout(hierarchy);
  applySimpleLayoutTransforms(hierarchy);

  assert.deepEqual([hierarchy.entries[0].fields.width, hierarchy.entries[0].fields.height], [120, 34]);
  assert.deepEqual([hierarchy.entries[2].fields.x, hierarchy.entries[2].fields.y], [5, 2]);
  assert.deepEqual([hierarchy.entries[3].fields.x, hierarchy.entries[3].fields.y], [55, 2]);
});

test('responsive layout distributes fill ratios inside the parent content box', () => {
  const scopeKey = 'host::list-000000::open::artboard';
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { width: 210, height: 40, styleId: 1 } },
    { componentIndex: 1, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 0, flexDirectionValue: 1, gapHorizontal: 10 } },
    { componentIndex: 2, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 1, height: 20, fractionalWidth: 1, styleId: 4 } },
    { componentIndex: 3, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 1, height: 20, fractionalWidth: 2, styleId: 5 } },
    { componentIndex: 4, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 2, layoutWidthScaleType: 1 } },
    { componentIndex: 5, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 3, layoutWidthScaleType: 1 } },
  ] };

  applySimpleLayoutTransforms(hierarchy);

  assert.ok(Math.abs(hierarchy.entries[2].fields.width - 200 / 3) < 1e-9);
  assert.ok(Math.abs(hierarchy.entries[3].fields.width - 400 / 3) < 1e-9);
  assert.ok(Math.abs(hierarchy.entries[3].fields.x - (200 / 3 + 10)) < 1e-9);
});

test('text compilation shrinks oversized type and clips it to its layout box', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', objectId: 'layout', sourceName: 'LayoutComponent', fields: { width: 90, height: 27 } },
    { componentIndex: 1, scopeKey: 'scope', objectId: 'text', sourceName: 'Text', fields: { parentId: 0, width: 300, height: 60 } },
    { componentIndex: 2, scopeKey: 'scope', objectId: 'run', sourceName: 'TextValueRun', fields: { parentId: 1, text: 'NAME:', styleId: 3 } },
    { componentIndex: 3, scopeKey: 'scope', objectId: 'style', sourceName: 'TextStylePaint', fields: { parentId: 1, fontSize: 50, lineHeight: 50 } },
  ] };

  const component = compileTextComponents(hierarchy, new Map()).get('text')[0];

  assert.deepEqual(component.size, [90, 27]);
  assert.equal(component.fontSize, 27);
  assert.equal(component.lineHeight, 27);
  assert.equal(component.fit, 'shrink');
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
