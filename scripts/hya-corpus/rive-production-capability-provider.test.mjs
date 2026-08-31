import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  applyComponentListLayout,
  applyDossierSummaryLayout,
  applySimpleLayoutTransforms,
  applySelectedAnimationOverrides,
  applySoloSelection,
  applyViewModelText,
  applyViewModelSoloSelection,
  boundAnimationNames,
  clippedSpriteFrame,
  compileImageClipMasks,
  compileImageComponents,
  compileVectorComponents,
  compileTextComponents,
  compileComponentListInteractionDocument,
  defaultViewModelRuntime,
  evaluate,
  finalizeComponentListMetrics,
  finalizeComponentListHitWidths,
  lowerLayoutBackdropEffects,
  mapEmbeddedAssets,
  nestedLeafRootScale,
  numberStateMachineAnimationName,
  orderEntriesForRiveDrawStack,
  paintSource,
  resolveNestedLeafFitTransforms,
  scriptedListInitializers,
  textWrapMode,
  vectorPath,
  vertexPath,
  vectorPaint,
} from './rive-production-capability-provider.mjs';
import { FROZEN_PROPERTIES } from '../../animation-spec/dist-test/rive/import/generated/frozen-registry.js';
import { parseHyaStateMachineV2 } from '../../animation-spec/dist-test/state-machine-v2/parser.js';
import { parseHyaDataBinding } from '../../animation-spec/dist-test/data-binding/parser.js';
import { parseHyaInteraction } from '../../animation-spec/dist-test/interaction/parser.js';

test('embedded inventory scripts lower their deterministic initial component lists', () => {
  assert.deepEqual(scriptedListInitializers('Equipment', 'weaponList'), [
    { viewModelId: 12, viewModelInstanceId: 0 },
    { viewModelId: 12, viewModelInstanceId: 1 },
  ]);
  assert.equal(scriptedListInitializers('BackpackMedical', 'backpackList').length, 16);
  assert.equal(scriptedListInitializers('BackpackMedical', 'medicalList').length, 4);
  assert.equal(scriptedListInitializers('ItemGrid', 'itemList').length, 12);
  assert.deepEqual(scriptedListInitializers('Unscripted', 'items'), []);
});

test('view-model instance names select the matching nested Solo branch', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, sourceName: 'Solo', fields: { activeComponentId: 1 } },
    { componentIndex: 1, sourceName: 'NestedArtboard', fields: { parentId: 0, name: 'All' } },
    { componentIndex: 2, sourceName: 'NestedArtboard', fields: { parentId: 0, name: 'Shield' } },
  ] };
  applyViewModelSoloSelection(hierarchy, { instanceName: 'IconShield' });
  assert.equal(hierarchy.entries[0].fields.activeComponentId, 2);
});

test('nested artboards inherit the authored referenced view-model instance', () => {
  const row = (index, sourceName, fields = {}) => {
    const id = `object:${String(index).padStart(8, '0')}`;
    const properties = Object.entries(fields).map(([name, value], propertyIndex) => ({
      id: `field:${String(index).padStart(8, '0')}:${String(propertyIndex).padStart(6, '0')}`,
      value: { type: typeof value === 'string' ? 'string' : 'number', value },
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
    row(0, 'ViewModel', { name: 'Child' }),
    row(1, 'ViewModelPropertyString', { name: 'label' }),
    row(2, 'ViewModelInstance', { name: 'Player', viewModelId: 0 }),
    row(3, 'ViewModelInstanceString', { parentId: 0, viewModelPropertyId: 0, propertyValue: 'Player' }),
    row(4, 'ViewModelInstance', { name: 'Mission', viewModelId: 0 }),
    row(5, 'ViewModelInstanceString', { parentId: 1, viewModelPropertyId: 0, propertyValue: 'Mission' }),
    row(6, 'ViewModel', { name: 'Parent' }),
    row(7, 'ViewModelPropertyViewModel', { name: 'mission', viewModelReferenceId: 0 }),
    row(8, 'ViewModelPropertyViewModel', { name: 'player', viewModelReferenceId: 0 }),
    row(9, 'ViewModelInstance', { name: 'Default', viewModelId: 1 }),
    row(10, 'ViewModelInstanceViewModel', { parentId: 0, viewModelPropertyId: 0, propertyValue: 1 }),
    row(11, 'ViewModelInstanceViewModel', { parentId: 0, viewModelPropertyId: 1, propertyValue: 0 }),
    row(12, 'Artboard', { name: 'ChildArtboard', viewModelId: 0 }),
    row(13, 'Artboard', { name: 'ParentArtboard', viewModelId: 1 }),
  ];
  const objects = new Map(rows.map(value => [value.object.id, value.object]));
  const runtime = defaultViewModelRuntime(
    { objects: rows.map(value => value.visit) }, objects, [rows[12].object.id, rows[13].object.id],
  );
  const parent = runtime.contextForArtboard(rows[13].object.id);
  const first = runtime.nestedContextForArtboard(parent, rows[12].object.id, 0);
  const second = runtime.nestedContextForArtboard(parent, rows[12].object.id, 1);
  assert.equal(first.instanceName, 'Player');
  assert.equal(first.values.label, 'Player');
  assert.equal(second.instanceName, 'Mission');
  assert.equal(second.values.label, 'Mission');
});

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

test('component-list interaction sidecar carries hover, staged open, audio and six executable row states', () => {
  const root = 'list::idle::root';
  const hierarchy = {
    entries: [{ objectId: root, fields: { x: 140, y: 355, scaleX: 1, scaleY: 1 } }],
    parentNodeByObjectId: new Map(),
    componentLists: [{ host: 'list-host', rows: [{
      index: 0, sourceIndex: 0, baseX: 0, baseY: 0, collapsedHeight: 27, openHeight: 159, expandedHeight: 259, hitWidth: 272,
      nodes: {
        idle: root, hover: 'list::hover::root', open: 'list::open::root', openHover: 'list::openHover::root',
        expanded: 'list::expanded::root', expandedHover: 'list::expandedHover::root',
      },
    }] }],
  };
  const records = [
    { visit: { sourceName: 'AudioEvent' }, fields: { name: 'open_01', assetId: 1 } },
    { visit: { sourceName: 'AudioEvent' }, fields: { name: 'click_01', assetId: 2 } },
    { visit: { sourceName: 'AudioEvent' }, fields: { name: 'open_menu_02', assetId: 3 } },
    { visit: { sourceName: 'AudioEvent' }, fields: { name: 'close_menu_01', assetId: 4 } },
  ];
  const document = parseHyaInteraction(compileComponentListInteractionDocument(hierarchy, records, new Map([
    [1, { resourceId: 'resource-main-click', volume: 1.3 }], [2, { resourceId: 'resource-hover', volume: 0.9 }],
    [3, { resourceId: 'resource-open', volume: 0.8 }], [4, { resourceId: 'resource-close', volume: 0.7 }],
  ])));
  assert.deepEqual(document.targets[0].transform, [1, 0, 0, 1, 140, 355]);
  assert.deepEqual(document.listeners.map(listener => listener.event), ['pointer-enter', 'pointer-exit', 'click']);
  assert.equal(document.listeners[0].actions[0].arguments.openHoverNode, 'list::openHover::root');
  assert.equal(document.listeners[0].actions[0].arguments.expandedNode, 'list::expanded::root');
  assert.equal(document.listeners[0].actions[0].arguments.openHeight, 159);
  assert.deepEqual(document.targets[0].hitArea.rect, [0, 0, 272, 259]);
  assert.equal(document.listeners[0].actions[1].target, 'resource-hover');
  assert.equal(document.listeners[2].actions[0].port, 'advance-open');
  assert.equal(document.listeners[2].actions[0].arguments.openAudio, 'resource-open');
  assert.equal(document.listeners[2].actions[0].arguments.openGain, 0.8);
  assert.equal(document.listeners[2].actions[0].arguments.closeAudio, 'resource-close');
  assert.equal(document.listeners[2].actions[0].arguments.closeGain, 0.7);
  assert.equal(document.listeners[2].actions[0].arguments.clickGain, 1.3);
  assert.equal(document.listeners[2].actions[0].arguments.hoverGain, 0.9);
});

test('generic component-list hover rows emit pointer hover without dossier click or audio semantics', () => {
  const root = 'grid::idle::root';
  const parent = 'inventory-panel';
  const hierarchy = {
    entries: [
      { objectId: parent, fields: { x: 12, y: 20, scaleX: 0.5, scaleY: 0.25 } },
      { objectId: root, fields: { x: 24, y: 48, scaleX: 1, scaleY: 1 } },
    ],
    parentNodeByObjectId: new Map([[root, parent]]),
    componentLists: [{ host: 'inventory-grid', rows: [{
      index: 4, sourceIndex: 2, baseX: 24, baseY: 48,
      collapsedHeight: 42, openHeight: 42, expandedHeight: 42, hitWidth: 42,
      interactionKind: 'hover-only',
      nodes: {
        idle: root, hover: 'grid::hover::root', open: root, openHover: 'grid::hover::root',
        expanded: root, expandedHover: 'grid::hover::root',
      },
    }] }],
  };
  const records = [{ visit: { sourceName: 'AudioEvent' }, fields: { name: 'click_01', assetId: 2 } }];
  const document = parseHyaInteraction(compileComponentListInteractionDocument(
    hierarchy, records, new Map([[2, { resourceId: 'resource-hover', volume: 0.9 }]]),
  ));

  assert.deepEqual(document.targets[0].transform, [1, 0, 0, 1, 24, 32]);
  assert.deepEqual(document.targets[0].hitArea.rect, [0, 0, 21, 10.5]);
  assert.deepEqual(document.listeners.map(listener => listener.event), ['pointer-enter', 'pointer-exit']);
  assert.equal(document.listeners[0].actions.length, 1);
  assert.equal(document.listeners[0].actions[0].port, 'set-hover');
  assert.equal(document.listeners[0].actions[0].arguments.hoverAudio, undefined);
});

test('Rive isHover binding resolves the authored inventory animation aliases', () => {
  for (const authored of ['Selecttion on', 'Selected on', 'Selected', 'Hover']) {
    assert.deepEqual(boundAnimationNames([{ name: authored }], { isHover: true }), [authored]);
  }
  for (const authored of ['Selection off', 'Idle']) {
    assert.deepEqual(boundAnimationNames([{ name: authored }], { isHover: false }), [authored]);
  }
});

test('component-list expanded metrics use the post-layout open variant height', () => {
  const root = { objectId: 'open-root', sourceName: 'Artboard', fields: { scaleY: 0.5 } };
  const expandedRoot = { objectId: 'expanded-root', sourceName: 'Artboard', fields: { scaleY: 0.5 } };
  const content = { objectId: 'open-content', sourceName: 'LayoutComponent', fields: { height: 582 } };
  const expandedContent = { objectId: 'expanded-content', sourceName: 'LayoutComponent', fields: { height: 640 } };
  const row = { nodes: { open: root.objectId, expanded: expandedRoot.objectId }, openHeight: 27, expandedHeight: 259 };
  const hierarchy = {
    entries: [root, content, expandedRoot, expandedContent], componentLists: [{ rows: [row] }],
    parentNodeByObjectId: new Map([[content.objectId, root.objectId], [expandedContent.objectId, expandedRoot.objectId]]),
  };

  finalizeComponentListMetrics(hierarchy);

  assert.equal(row.openHeight, 291);
  assert.equal(row.expandedHeight, 320);
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

test('nested number input resolves the authored state-machine animation branch', () => {
  const record = (sourceName, fields = {}) => ({ visit: { sourceName }, fields });
  const records = [
    record('LinearAnimation', { name: 'Empty' }),
    record('LinearAnimation', { name: 'Pluto' }),
    record('LinearAnimation', { name: 'Neptune' }),
    record('StateMachine', { name: 'Planets' }),
    record('StateMachineNumber', { name: 'Planets', value: 1 }),
    record('StateMachineLayer', { name: 'Planet' }),
    record('AnimationState', { animationId: 1 }),
    record('EntryState'),
    record('AnimationState', { animationId: 2 }),
    record('AnyState'),
    record('StateTransition', { stateToId: 2 }),
    record('TransitionNumberCondition', { inputId: 0, value: 8 }),
  ];

  assert.equal(numberStateMachineAnimationName(
    records,
    [{ name: 'Empty' }, { name: 'Pluto' }, { name: 'Neptune' }],
    0,
    0,
    8,
  ), 'Neptune');
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

test('view-model binding paths replace summary text and risk color by property id', () => {
  const hierarchy = { entries: [
    { objectId: 'summary', sourceObjectId: 'summary', sourceName: 'TextValueRun', fields: { text: 'placeholder' } },
    { objectId: 'risk', sourceObjectId: 'risk', sourceName: 'SolidColor', fields: { colorValue: [0.5, 0.5, 0.5, 1] } },
  ] };
  const report = { objects: [
    { neutralObjectId: 'summary', sourceName: 'TextValueRun' },
    { neutralObjectId: 'summary-binding', sourceName: 'DataBindContext', properties: [{ sourceName: 'sourcePathIds', neutralFieldIds: ['summary-path'] }] },
    { neutralObjectId: 'risk', sourceName: 'SolidColor' },
    { neutralObjectId: 'risk-binding', sourceName: 'DataBindContext', properties: [{ sourceName: 'sourcePathIds', neutralFieldIds: ['risk-path'] }] },
  ] };
  const objects = new Map([
    ['summary-binding', { properties: [{ id: 'summary-path', value: { type: 'bytes', base64: 'AQo=', byteLength: 2 } }] }],
    ['risk-binding', { properties: [{ id: 'risk-path', value: { type: 'bytes', base64: 'AQc=', byteLength: 2 } }] }],
  ]);
  const propertyNames = Array.from({ length: 11 }); propertyNames[7] = 'risk_level_color'; propertyNames[10] = 'summary';

  applyViewModelText(hierarchy, {
    summary: 'Bound dossier summary', risk_level_color: [0.85, 0.004, 0.004, 1],
  }, report, objects, propertyNames);

  assert.equal(hierarchy.entries[0].fields.text, 'Bound dossier summary');
  assert.deepEqual(hierarchy.entries[1].fields.colorValue, [0.85, 0.004, 0.004, 1]);
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

test('component-list hug height retains authored type overflow for dossier name rows', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { width: 100, height: 27, styleId: 1 } },
    { componentIndex: 1, scopeKey: 'scope', sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 0, intrinsicallySizedValue: true } },
    { componentIndex: 2, scopeKey: 'scope', sourceName: 'Text', nodeEligible: true, transformTarget: true, fields: { parentId: 0 } },
    { componentIndex: 3, scopeKey: 'scope', sourceName: 'TextValueRun', nodeEligible: true, transformTarget: false, fields: { parentId: 2, text: 'KAZUYA HOSHINO', styleId: 4 } },
    { componentIndex: 4, scopeKey: 'scope', sourceName: 'TextStylePaint', nodeEligible: true, transformTarget: false, fields: { parentId: 2, fontSize: 50 } },
  ] };

  applyComponentListLayout(hierarchy);

  assert.equal(hierarchy.entries[0].fields.height, 60);
});

test('component-list infers a constrained overflow row for risk value and icon groups', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { width: 197, height: 54, styleId: 1 } },
    { componentIndex: 1, scopeKey: 'scope', sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 0, intrinsicallySizedValue: true } },
    { componentIndex: 2, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 193, height: 27 } },
    { componentIndex: 3, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 203, height: 46 } },
  ] };

  applyComponentListLayout(hierarchy);

  assert.equal(hierarchy.entries[1].fields.flexDirectionValue, 1);
});

test('component-list keeps dissimilar header and expanded detail heights in a column', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { width: 637, height: 159, styleId: 1 } },
    { componentIndex: 1, scopeKey: 'scope', sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 0, intrinsicallySizedValue: true } },
    { componentIndex: 2, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 197, height: 54 } },
    { componentIndex: 3, scopeKey: 'scope', sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 620, height: 264 } },
  ] };

  applyComponentListLayout(hierarchy);

  assert.equal(hierarchy.entries[1].fields.flexDirectionValue, undefined);
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

test('root layout fill sizing resolves authored percent units against the canvas', () => {
  const scopeKey = 'root:layout';
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey, sourceName: 'Artboard', nodeEligible: true, transformTarget: true, fields: { width: 791, height: 800 } },
    { componentIndex: 1, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 2502, height: 1859, styleId: 2 } },
    { componentIndex: 2, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 1, paddingLeft: 42, paddingRight: 42, paddingTop: 42, paddingBottom: 42, layoutWidthScaleType: 1, layoutHeightScaleType: 1 } },
    { componentIndex: 3, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 1, width: 100, height: 100, styleId: 4 } },
    { componentIndex: 4, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 3, layoutWidthScaleType: 1, layoutHeightScaleType: 1 } },
  ] };

  applySimpleLayoutTransforms(hierarchy);

  assert.deepEqual([hierarchy.entries[1].fields.width, hierarchy.entries[1].fields.height], [791, 800]);
  assert.deepEqual([hierarchy.entries[3].fields.width, hierarchy.entries[3].fields.height], [707, 716]);
  assert.deepEqual([hierarchy.entries[3].fields.x, hierarchy.entries[3].fields.y], [42, 42]);
});

test('root-aligned Rive layout layers overlap instead of accumulating off-canvas', () => {
  const scopeKey = 'root:inventory';
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { width: 1920, height: 1080, styleId: 1 } },
    { componentIndex: 1, scopeKey, sourceName: 'LayoutComponentStyle', nodeEligible: true, transformTarget: false, fields: { parentId: 0, layoutAlignmentType: 9 } },
    { componentIndex: 2, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 689, height: 838 } },
    { componentIndex: 3, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 464, height: 707 } },
    { componentIndex: 4, scopeKey, sourceName: 'LayoutComponent', nodeEligible: true, transformTarget: true, fields: { parentId: 0, width: 1231, height: 837 } },
  ] };

  applySimpleLayoutTransforms(hierarchy);

  assert.deepEqual(hierarchy.entries.slice(2).map(entry => [entry.fields.x, entry.fields.y]), [[0, 0], [0, 0], [0, 0]]);
});

test('Rive gradient opacity multiplies every authored stop alpha', () => {
  const source = paintSource(
    { sourceName: 'LinearGradient', fields: { startX: 0, startY: 0, endX: 0, endY: 100, opacity: 0.1 } },
    [
      { sourceName: 'GradientStop', fields: { position: 0, colorValue: [0, 1, 0.5, 0] } },
      { sourceName: 'GradientStop', fields: { position: 1, colorValue: [0, 1, 0.5, 0.5] } },
    ],
  );

  assert.deepEqual(source.stops, [0, 0, 1, 0.5, 0, 1, 0, 1, 0.5, 0.05]);
});

test('shape feather keeps a bounded translucent fill while layout feather remains an edge proxy', () => {
  const fill = { sourceName: 'Fill', fields: {} };
  const solid = { sourceName: 'SolidColor', fields: { colorValue: [0, 1, 0.5, 1] } };
  const feather = { sourceName: 'Feather', fields: { inner: true, strength: 6 } };
  assert.deepEqual(vectorPaint(fill, [solid, feather], new Map(), 'Shape'), {
    fill: { kind: 'solid', color: [0, 1, 0.5, 1], opacity: 0.165 }, fillRule: 'nonzero',
    stroke: { color: [0, 1, 0.5, 1], width: 2, lineCap: 'round', lineJoin: 'round', miterLimit: 4 },
  });
  const white = { sourceName: 'SolidColor', fields: { colorValue: [1, 1, 1, 0.6] } };
  assert.equal(vectorPaint(fill, [white, feather], new Map(), 'Shape').fill.opacity, 0.0495);
  assert.equal(vectorPaint(fill, [solid, feather], new Map(), 'LayoutComponent').stroke.width, 2);
});

test('Rive drawable stack preserves painter order inside each expanded artboard scope', () => {
  const entries = [
    { objectId: 'root-a', sourceObjectId: 'root-a', sourceName: 'Artboard', scopeKey: 'a' },
    { objectId: 'a-front', sourceObjectId: 'front', sourceName: 'Shape', scopeKey: 'a' },
    { objectId: 'a-layout', sourceObjectId: 'layout', sourceName: 'Text', scopeKey: 'a' },
    { objectId: 'a-back', sourceObjectId: 'back', sourceName: 'Shape', scopeKey: 'a' },
    { objectId: 'b-front', sourceObjectId: 'front', sourceName: 'Shape', scopeKey: 'b' },
    { objectId: 'b-back', sourceObjectId: 'back', sourceName: 'Shape', scopeKey: 'b' },
  ];
  const ordered = orderEntriesForRiveDrawStack(entries, new Map([['front', 1], ['back', 2]]));
  assert.deepEqual(ordered.map(value => value.objectId), [
    'root-a', 'a-front', 'a-layout', 'a-back', 'b-front', 'b-back',
  ]);
});

test('text compilation only shrinks oversized type for an authored fit overflow mode', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', objectId: 'layout', sourceName: 'LayoutComponent', fields: { width: 90, height: 27 } },
    { componentIndex: 1, scopeKey: 'scope', objectId: 'text', sourceName: 'Text', fields: { parentId: 0, width: 300, height: 60, overflowValue: 5 } },
    { componentIndex: 2, scopeKey: 'scope', objectId: 'run', sourceName: 'TextValueRun', fields: { parentId: 1, text: 'NAME:', styleId: 3 } },
    { componentIndex: 3, scopeKey: 'scope', objectId: 'style', sourceName: 'TextStylePaint', fields: { parentId: 1, fontSize: 50, lineHeight: 50 } },
  ] };

  const component = compileTextComponents(hierarchy, new Map()).get('text')[0];

  assert.deepEqual(component.size, [90, 27]);
  assert.equal(component.fontSize, 27);
  assert.equal(component.lineHeight, 27);
  assert.equal(component.fit, 'shrink');
});

test('text compilation preserves controlled Rive overflow without a second runtime shrink', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', objectId: 'layout', sourceName: 'LayoutComponent', fields: { width: 90, height: 27 } },
    { componentIndex: 1, scopeKey: 'scope', objectId: 'text', sourceName: 'Text', fields: { parentId: 0, width: 300, height: 60 } },
    { componentIndex: 2, scopeKey: 'scope', objectId: 'run', sourceName: 'TextValueRun', fields: { parentId: 1, text: 'NAME:', styleId: 3 } },
    { componentIndex: 3, scopeKey: 'scope', objectId: 'style', sourceName: 'TextStylePaint', fields: { parentId: 1, fontSize: 50, lineHeight: 50 } },
  ] };

  const component = compileTextComponents(hierarchy, new Map()).get('text')[0];

  assert.equal(component.fontSize, 40.5);
  assert.equal(component.lineHeight, 40.5);
  assert.equal(component.fit, undefined);
});

test('text compilation resolves Rive automatic line height to the HYA 1.2 em line box', () => {
  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', objectId: 'layout', sourceName: 'LayoutComponent', fields: { width: 200, height: 40 } },
    { componentIndex: 1, scopeKey: 'scope', objectId: 'text', sourceName: 'Text', fields: { parentId: 0, width: 200, height: 40 } },
    { componentIndex: 2, scopeKey: 'scope', objectId: 'run', sourceName: 'TextValueRun', fields: { parentId: 1, text: 'SUMMARY', styleId: 3 } },
    { componentIndex: 3, scopeKey: 'scope', objectId: 'style', sourceName: 'TextStylePaint', fields: { parentId: 1, fontSize: 12 } },
  ] };

  const component = compileTextComponents(hierarchy, new Map()).get('text')[0];

  assert.equal(component.lineHeight, 14.399999999999999);
});

test('clipped image preserves the authored off-center crop and sprite placement', () => {
  const frame = clippedSpriteFrame([400, 400], [120, 120], [51, 80], [0.4, 0.4]);
  assert.deepEqual(frame.size, [300, 300]);
  assert.deepEqual(frame.position, [22.5, -50]);
  assert.deepEqual(frame.uvRect, [0.18125, 0, 0.75, 0.75]);

  const hierarchy = { entries: [
    { componentIndex: 0, scopeKey: 'scope', objectId: 'artboard', sourceName: 'Artboard', fields: { width: 120, height: 120 } },
    { componentIndex: 1, scopeKey: 'scope', objectId: 'image', sourceName: 'Image', fields: { parentId: 0, assetId: 7, x: 51, y: 80, scaleX: 0.4, scaleY: 0.4 } },
    { componentIndex: 2, scopeKey: 'scope', objectId: 'clip', sourceName: 'ClippingShape', fields: { parentId: 1, sourceId: 3 } },
  ] };
  const component = compileImageComponents(hierarchy, new Map([[7, {
    resourceId: 'portrait', detectedMimeType: 'image/png', width: 400, height: 400,
  }]])).get('image')[0];
  assert.deepEqual(component.size, [300, 300]);
  assert.deepEqual(component.position, [22.5, -50]);
  assert.deepEqual(component.uvRect, [0.18125, 0, 0.75, 0.75]);
});

test('nested leaf scales its source artboard to the authored layout host', () => {
  const entries = [
    { objectId: 'host', componentIndex: 4, fields: { width: 134, height: 134 } },
    { objectId: 'leaf', componentIndex: 5, fields: { parentId: 4 } },
  ];
  assert.equal(nestedLeafRootScale(entries, 'leaf', { width: 120, height: 120 }), 134 / 120);
});

test('nested leaf refits after flex layout resolves the final host box', () => {
  const hierarchy = {
    entries: [
      { objectId: 'host', sourceName: 'LayoutComponent', fields: { width: 707, height: 716 } },
      { objectId: 'leaf', sourceName: 'NestedArtboardLeaf', fields: { fit: 1 } },
      { objectId: 'nested-root', sourceName: 'Artboard', instanceDepth: 2, fields: { width: 500, height: 500, scaleX: 1.62, scaleY: 1.62 } },
    ],
    parentNodeByObjectId: new Map([['leaf', 'host'], ['nested-root', 'leaf']]),
  };
  resolveNestedLeafFitTransforms(hierarchy);
  assert.equal(hierarchy.entries[2].fields.scaleX, 707 / 500);
  assert.equal(hierarchy.entries[2].fields.scaleY, 707 / 500);
  assert.equal(hierarchy.entries[2].fields.x, 0);
  assert.equal(hierarchy.entries[2].fields.y, 4.5);
});

test('Rive image clipping produces a rounded executable alpha mask', () => {
  const scopeKey = 'avatar';
  const entries = [
    { objectId: 'artboard', componentIndex: 0, sourceName: 'Artboard', scopeKey, fields: {} },
    { objectId: 'image', componentIndex: 1, sourceName: 'Image', scopeKey, fields: { parentId: 0 } },
    { objectId: 'clip', componentIndex: 2, sourceName: 'ClippingShape', scopeKey, fields: { parentId: 1, sourceId: 3 } },
    { objectId: 'shape', componentIndex: 3, sourceName: 'Shape', scopeKey, fields: { parentId: 0, x: 60, y: 60, opacity: 0 } },
    { objectId: 'rectangle', componentIndex: 4, sourceName: 'Rectangle', scopeKey, fields: { parentId: 3, width: 120, height: 120, cornerRadiusTL: 10 } },
  ];
  const result = compileImageClipMasks({
    entries,
    parentNodeByObjectId: new Map([['shape', 'artboard']]),
  });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].parent, 'artboard');
  assert.deepEqual(result.nodes[0].transform.position, [60, 60]);
  assert.equal(result.nodes[0].components[0].commands, 'MLCLCLCLCZ');
  assert.deepEqual(result.compositeByTarget.get('image'), {
    kind: 'mask', source: 'image::rive-clip-mask-0002', mode: 'alpha', operation: 'intersect',
  });
});

test('Rive vector clipping produces an executable alpha mask', () => {
  const scopeKey = 'planet';
  const entries = [
    { objectId: 'artboard', componentIndex: 0, sourceName: 'Artboard', scopeKey, fields: {} },
    { objectId: 'surface', componentIndex: 1, sourceName: 'Shape', scopeKey, fields: { parentId: 0 } },
    { objectId: 'clip', componentIndex: 2, sourceName: 'ClippingShape', scopeKey, fields: { parentId: 1, sourceId: 3 } },
    { objectId: 'silhouette', componentIndex: 3, sourceName: 'Shape', scopeKey, fields: { parentId: 0, x: 50, y: 50 } },
    { objectId: 'ellipse', componentIndex: 4, sourceName: 'Ellipse', scopeKey, fields: { parentId: 3, width: 100, height: 100 } },
  ];
  const result = compileImageClipMasks({
    entries,
    parentNodeByObjectId: new Map([['silhouette', 'artboard']]),
  });

  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].parent, 'artboard');
  assert.equal(result.nodes[0].components[0].commands, 'MCCCCZ');
  assert.deepEqual(result.compositeByTarget.get('surface'), {
    kind: 'mask', source: 'surface::rive-clip-mask-0002', mode: 'alpha', operation: 'intersect',
  });
});

test('Rive container clipping applies an inherited alpha mask to its subtree', () => {
  const scopeKey = 'planet';
  const entries = [
    { objectId: 'artboard', componentIndex: 0, sourceName: 'Artboard', scopeKey, fields: {} },
    { objectId: 'face', componentIndex: 1, sourceName: 'Node', scopeKey, fields: { parentId: 0 } },
    { objectId: 'clip', componentIndex: 2, sourceName: 'ClippingShape', scopeKey, fields: { parentId: 1, sourceId: 3 } },
    { objectId: 'silhouette', componentIndex: 3, sourceName: 'Shape', scopeKey, fields: { parentId: 0 } },
    { objectId: 'ellipse', componentIndex: 4, sourceName: 'Ellipse', scopeKey, fields: { parentId: 3, width: 100, height: 100 } },
    { objectId: 'eye', componentIndex: 5, sourceName: 'Shape', scopeKey, fields: { parentId: 1 } },
    { objectId: 'eye-clip', componentIndex: 6, sourceName: 'ClippingShape', scopeKey, fields: { parentId: 5, sourceId: 7 } },
    { objectId: 'eye-silhouette', componentIndex: 7, sourceName: 'Shape', scopeKey, fields: { parentId: 1 } },
    { objectId: 'eye-ellipse', componentIndex: 8, sourceName: 'Ellipse', scopeKey, fields: { parentId: 7, width: 20, height: 20 } },
  ];
  const result = compileImageClipMasks({
    entries,
    parentNodeByObjectId: new Map([
      ['face', 'artboard'], ['silhouette', 'artboard'], ['eye', 'face'], ['eye-silhouette', 'face'],
    ]),
  });

  assert.deepEqual(result.compositeByTarget.get('face'), {
    kind: 'mask', source: 'face::rive-clip-mask-0002', mode: 'alpha', operation: 'intersect',
  });
  assert.deepEqual(result.compositeByTarget.get('eye'), { layers: [
    { kind: 'mask', source: 'face::rive-clip-mask-0002', mode: 'alpha', operation: 'intersect' },
    { kind: 'mask', source: 'eye::rive-clip-mask-0006', mode: 'alpha', operation: 'intersect' },
  ] });
});

test('layout backing paint lowers to a visible drop shadow behind the opaque surface', () => {
  const components = new Map([['panel', [
    { commands: 'MLLLZ', values: [0, 0, 786, 0, 786, 264, 0, 264], fill: { kind: 'solid', color: [0, 0, 0, 0.1] } },
    { commands: 'MLLLZ', values: [0, 0, 786, 0, 786, 264, 0, 264], fill: { kind: 'solid', color: [1, 1, 1, 1] } },
    { commands: 'MLLLZ', values: [0, 0, 786, 0, 786, 264, 0, 264], stroke: { color: [0, 0, 0, 1], width: 0.5 } },
  ]] ]);
  const effects = lowerLayoutBackdropEffects({
    entries: [
      { objectId: 'panel', componentIndex: 1, scopeKey: 'sheet', sourceName: 'LayoutComponent', fields: { styleId: 2 } },
      { objectId: 'panel-style', componentIndex: 2, scopeKey: 'sheet', sourceName: 'LayoutComponentStyle', fields: { paddingLeft: 20, paddingRight: 20 } },
      { objectId: 'item', sourceName: 'Artboard', fields: { width: 800, height: 259 } },
    ],
    parentNodeByObjectId: new Map([['panel', 'item']]),
  }, components);
  assert.equal(components.get('panel').length, 2);
  assert.deepEqual(components.get('panel')[0].values, [0, 0, 826, 0, 826, 259, 0, 259]);
  assert.deepEqual(effects.get('panel'), [{
    kind: 'drop-shadow', color: [0, 0, 0, 1], opacity: 0.05, offset: [8, 8], blur: 8,
  }]);
});

test('rounded layout backing paint retains its executable shadow fitting', () => {
  const path = vectorPath({ sourceName: 'Rectangle', fields: {
    x: 393, y: 132, width: 786, height: 264, cornerRadiusTL: 16,
  } }, []);
  const components = new Map([['panel', [
    { ...path, fill: { kind: 'solid', color: [0, 0, 0, 0.1] } },
    { ...path, fill: { kind: 'solid', color: [1, 1, 1, 1] } },
    { ...path, stroke: { color: [0, 0, 0, 1], width: 0.5 } },
  ]] ]);
  const effects = lowerLayoutBackdropEffects({
    entries: [
      { objectId: 'panel', componentIndex: 1, scopeKey: 'sheet', sourceName: 'LayoutComponent', fields: { styleId: 2 } },
      { objectId: 'panel-style', componentIndex: 2, scopeKey: 'sheet', sourceName: 'LayoutComponentStyle', fields: { paddingLeft: 20, paddingRight: 20 } },
      { objectId: 'item', sourceName: 'Artboard', fields: { width: 800, height: 259 } },
    ],
    parentNodeByObjectId: new Map([['panel', 'item']]),
  }, components);
  const fitted = components.get('panel');
  assert.equal(fitted[0].commands, 'MLCLCLCLCZ');
  assert.equal(Math.max(...fitted[0].values.filter((_, index) => index % 2 === 0)), 826);
  assert.equal(Math.max(...fitted[0].values.filter((_, index) => index % 2 === 1)), 259);
  assert.ok(effects.has('panel'));
});

test('dossier summary stacks label above body and shrinks the black panel to authored text bounds', () => {
  const scopeKey = 'expanded-row';
  const bodyObject = {
    id: 'body-text', family: 'structure', properties: [
      { id: 'body-width', value: { type: 'number', value: 695 } },
      { id: 'body-height', value: { type: 'number', value: 50.13168716430664 } },
    ],
  };
  const bodyVisit = {
    neutralObjectId: bodyObject.id, sourceName: 'Text', properties: [
      { sourceName: 'width', neutralFieldIds: ['body-width'] },
      { sourceName: 'height', neutralFieldIds: ['body-height'] },
    ],
  };
  const entries = [
    { objectId: 'outer', componentIndex: 1, scopeKey, sourceName: 'LayoutComponent', fields: { height: 300 } },
    { objectId: 'summary', componentIndex: 2, scopeKey, sourceName: 'LayoutComponent', fields: { parentId: 1, width: 792.6, height: 134.13168716430664 } },
    { objectId: 'label-layout', componentIndex: 3, scopeKey, sourceName: 'LayoutComponent', fields: { parentId: 2, x: 20, y: 10, width: 589, height: 64 } },
    { objectId: 'label-text', componentIndex: 4, scopeKey, sourceName: 'Text', fields: { parentId: 3, width: 589, height: 64 } },
    { objectId: 'label-run', componentIndex: 5, scopeKey, sourceName: 'TextValueRun', fields: { parentId: 4, styleId: 6, text: 'SUMMARY:' } },
    { objectId: 'label-style', componentIndex: 6, scopeKey, sourceName: 'TextStylePaint', fields: { fontSize: 12 } },
    { objectId: 'body-layout', componentIndex: 7, scopeKey, sourceName: 'LayoutComponent', fields: { parentId: 2, x: 77.6, y: 10, width: 921.6, height: 64 } },
    { objectId: bodyObject.id, componentIndex: 8, scopeKey, sourceName: 'Text', object: bodyObject, visit: bodyVisit, fields: { parentId: 7, width: 921.6, height: 50.13168716430664 } },
    { objectId: 'body-run', componentIndex: 9, scopeKey, sourceName: 'TextValueRun', fields: { parentId: 8, styleId: 10, text: 'Long dossier body' } },
    { objectId: 'body-style', componentIndex: 10, scopeKey, sourceName: 'TextStylePaint', fields: { fontSize: 12 } },
  ];
  const hierarchy = {
    entries,
    parentNodeByObjectId: new Map([['summary', 'outer'], ['label-layout', 'summary'], ['label-text', 'label-layout'], ['body-layout', 'summary'], [bodyObject.id, 'body-layout']]),
  };

  applyDossierSummaryLayout(hierarchy);

  assert.equal(entries[1].fields.width, 715);
  assert.equal(entries[1].fields.height, 74.53168716430664);
  assert.deepEqual([entries[2].fields.x, entries[2].fields.y, entries[2].fields.height], [20, 10, 14.399999999999999]);
  assert.deepEqual([entries[6].fields.x, entries[6].fields.y, entries[6].fields.width], [20, 24.4, 695]);
  assert.equal(entries[0].fields.height, 240.4);
});

test('component-list hit area grows to the complete expanded sheet width', () => {
  const root = { objectId: 'expanded-root', scopeKey: 'expanded', sourceName: 'Artboard', fields: {} };
  const sheet = { objectId: 'sheet', scopeKey: 'expanded', sourceName: 'LayoutComponent', fields: {} };
  const row = { nodes: { expanded: root.objectId }, hitWidth: 642 };
  const components = new Map([[sheet.objectId, [{ commands: 'MLLLZ', values: [0, 0, 826, 0, 826, 249, 0, 249] }]]]);

  finalizeComponentListHitWidths({ entries: [root, sheet], componentLists: [{ rows: [row] }] }, components);

  assert.equal(row.hitWidth, 826);
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

test('vector geometry retains its authored local translation, rotation and scale', () => {
  const path = vectorPath({
    sourceName: 'PointsPath', fields: { x: 100, y: 50, rotation: Math.PI / 2, scaleX: 2, scaleY: 3, isClosed: false },
  }, [
    { sourceName: 'StraightVertex', fields: { x: 1, y: 2 } },
    { sourceName: 'StraightVertex', fields: { x: 4, y: 6 } },
  ]);
  assert.equal(path.commands, 'ML');
  assert.deepEqual(path.values.map(value => Math.round(value * 1e9) / 1e9), [94, 52, 82, 58]);
});

test('layout paint uses the authored linked corner radius', () => {
  const hierarchy = { entries: [
    { objectId: 'layout', componentIndex: 0, scopeKey: 'scope', sourceName: 'LayoutComponent', fields: { width: 100, height: 80, styleId: 1 } },
    { objectId: 'style', componentIndex: 1, scopeKey: 'scope', sourceName: 'LayoutComponentStyle', fields: { parentId: 0, cornerRadiusTL: 10 } },
    { objectId: 'fill', componentIndex: 2, scopeKey: 'scope', sourceName: 'Fill', fields: { parentId: 0 } },
    { objectId: 'color', componentIndex: 3, scopeKey: 'scope', sourceName: 'SolidColor', fields: { parentId: 2, colorValue: [1, 1, 1, 1] } },
  ] };

  const component = compileVectorComponents(hierarchy).get('layout')[0];

  assert.equal(component.commands, 'MLCLCLCLCZ');
  assert.deepEqual([Math.min(...component.values), Math.max(...component.values)], [0, 100]);
});
