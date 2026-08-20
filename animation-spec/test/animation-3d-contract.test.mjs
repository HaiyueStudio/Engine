import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AnimationExtensionRegistry,
  AnimationFormatError,
  encodeAnimationBinary,
  parseAnimation,
} from '../dist/index.js';
import * as native3d from '../dist/native3d.js';

const SCHEMA_ROOT = new URL('../schema/', import.meta.url);
const CONTRACT = await readJson(new URL('animation-3d.contract.json', SCHEMA_ROOT));
const EXTENSION_SCHEMA = await readJson(new URL('animation-3d-extension.schema.json', SCHEMA_ROOT));
const CARRIER_SCHEMA = await readJson(new URL('animation-3d-carrier.schema.json', SCHEMA_ROOT));
const VALID = await readJson(new URL('fixtures/native-3d-valid.hya.json', SCHEMA_ROOT));
const MIXED = await readJson(new URL('fixtures/native-3d-mixed-invalid.hya.json', SCHEMA_ROOT));

test('native 3D focused facade exposes only the reviewed parser contract', async () => {
  const packageJson = await readJson(new URL('../package.json', import.meta.url));
  assert.deepEqual(packageJson.exports['./native3d'], {
    types: './dist/native3d.d.ts',
    import: './dist/native3d.js',
  });
  assert.deepEqual(Object.keys(native3d).sort(), [
    'NATIVE_3D_ANIMATION_EXTENSION_ID',
    'NATIVE_3D_ANIMATION_FORMAT',
    'NATIVE_3D_CLIP_FORMAT',
    'NATIVE_3D_STATE_MACHINE_FORMAT',
    'Native3DAnimationFormatError',
    'createNative3DAnimationExtensionHandler',
    'parseNative3DAnimation',
    'parseNative3DAnimationPayload',
  ]);
});

test('native 3D contract freezes extension, coordinates, owners, resources and diagnostics', () => {
  assert.equal(CONTRACT.extension.id, 'org.haiyue.animation-3d@1');
  assert.equal(CONTRACT.extension.carrierVersion, '1.0');
  assert.deepEqual(CONTRACT.extension.binaryReadVersions, [1, 2]);
  assert.equal(CONTRACT.projects['2d'].format, 'haiyue-animation-editor-project@1');
  assert.equal(CONTRACT.projects['3d'].format, 'haiyue-animation-editor-project-3d@1');
  assert.equal(CONTRACT.projects.mixedComposition.policy, 'reject');
  assert.deepEqual(CONTRACT.coordinates, {
    handedness: 'right',
    upAxis: '+y',
    forwardAxis: '-z',
    linearUnit: 'meter',
    angles: 'radian',
    rotationStorage: 'normalized-xyzw-quaternion',
    timeUnit: 'second',
  });
  assert.equal(CONTRACT.runtime.ownerPackage, '@haiyue/extensions/animation3d');
  assert.equal(CONTRACT.runtime.modelAdapter, '@haiyue/extensions/gltf');
  assert.equal(CONTRACT.runtime.particleComponent, '@haiyue/engine ParticleEmitter3D');
  assert.equal(CONTRACT.runtime.engineRootExportChange, false);
  assert.ok(CONTRACT.degradation.some(entry => entry.feature === 'pseudo-3d-projection-fallback' && entry.action === 'forbidden'));

  const diagnosticCodes = CONTRACT.diagnostics.map(entry => entry.code);
  assert.equal(new Set(diagnosticCodes).size, diagnosticCodes.length);
  for (const code of [
    'E_ANIMATION_MISSING_EXTENSION',
    'E_ANIMATION_3D_MIXED_DIMENSIONS',
    'E_ANIMATION_3D_UNSUPPORTED_FEATURE',
    'E_ANIMATION_3D_UNKNOWN_RESOURCE',
    'E_ANIMATION_3D_BINDING_MISMATCH',
    'E_PROJECT_MIXED_DIMENSIONS',
  ]) assert.ok(diagnosticCodes.includes(code), `Missing frozen diagnostic ${code}`);
});

test('native 3D schemas have resolvable references and require an empty 2D core carrier', () => {
  verifyLocalReferences(EXTENSION_SCHEMA);
  verifyLocalReferences(CARRIER_SCHEMA);
  const extensionReference = CARRIER_SCHEMA.properties.extensions.properties[CONTRACT.extension.id].$ref;
  assert.equal(extensionReference, EXTENSION_SCHEMA.$id);
  assert.equal(CARRIER_SCHEMA.properties.nodes.maxItems, 0);
  assert.equal(CARRIER_SCHEMA.properties.tracks.maxItems, 0);
  assert.equal(CARRIER_SCHEMA.properties.extensionsUsed.contains.const, CONTRACT.extension.id);
  assert.equal(CARRIER_SCHEMA.properties.extensionsRequired.contains.const, CONTRACT.extension.id);
  assert.equal(EXTENSION_SCHEMA.properties.format.const, CONTRACT.extension.payloadFormat);
  assert.equal(EXTENSION_SCHEMA.$defs.clip.properties.format.const, CONTRACT.runtime.clipFormat);
  assert.equal(EXTENSION_SCHEMA.$defs.stateMachine.properties.format.const, CONTRACT.runtime.stateMachineFormat);
});

test('native 3D fixture validates, binary-round-trips, and still requires explicit runtime registration', () => {
  verifyCarrier(VALID, CONTRACT);
  const registry = createRegistry(CONTRACT);

  const parsedJson = parseAnimation(VALID, { extensions: registry });
  assert.equal(parsedJson.nodes.length, 0);
  assert.equal(parsedJson.tracks.length, 0);
  assert.equal(parsedJson.extensions[CONTRACT.extension.id].clips[0].tracks.length, 5);

  const binary = encodeAnimationBinary(VALID, { extensions: registry });
  assert.equal(new DataView(binary).getUint16(4, true), CONTRACT.extension.binaryWriteVersion);
  const parsedBinary = parseAnimation(binary, { extensions: registry });
  assert.deepEqual(parsedBinary.extensions[CONTRACT.extension.id], parsedJson.extensions[CONTRACT.extension.id]);

  assert.throws(
    () => parseAnimation(VALID),
    error => error instanceof AnimationFormatError
      && error.code === 'E_ANIMATION_MISSING_EXTENSION'
      && error.path === '$.extensionsRequired',
  );
});

test('unknown native 3D major and mixed 2D/3D content follow stable rejection paths', () => {
  const unknownMajor = structuredClone(VALID);
  const payload = unknownMajor.extensions[CONTRACT.extension.id];
  unknownMajor.extensionsUsed = ['org.haiyue.animation-3d@2'];
  unknownMajor.extensionsRequired = ['org.haiyue.animation-3d@2'];
  unknownMajor.extensions = { 'org.haiyue.animation-3d@2': payload };
  assert.throws(
    () => parseAnimation(unknownMajor, { extensions: createRegistry(CONTRACT) }),
    error => error instanceof AnimationFormatError
      && error.code === 'E_ANIMATION_MISSING_EXTENSION'
      && error.path === '$.extensionsRequired',
  );

  assert.throws(
    () => verifyCarrier(MIXED.document, CONTRACT),
    error => error?.code === MIXED.expectedDiagnostic.code
      && error?.path === MIXED.expectedDiagnostic.path,
  );
});

test('legacy 2D HYA remains independent from the native 3D extension contract', () => {
  const legacy2d = {
    format: 'haiyue-animation',
    version: '1.0',
    name: '2D compatibility',
    canvas: { width: 16, height: 16, coordinateSystem: 'screen-y-down' },
    duration: 1,
    nodes: [],
    tracks: [],
  };
  const parsed = parseAnimation(legacy2d);
  assert.equal(parsed.version, '1.0');
  assert.deepEqual(parsed.extensionsRequired, []);
  assert.equal(parsed.canvas.coordinateSystem, 'screen-y-down');
});

function createRegistry(contract) {
  const registry = new AnimationExtensionRegistry();
  registry.register({
    id: contract.extension.id,
    validateDocument(payload, context) {
      try {
        verifyPayload(payload, contract);
      } catch (error) {
        context.fail(error instanceof Error ? error.message : String(error), error?.path ?? context.path);
      }
    },
  });
  return registry;
}

function verifyCarrier(document, contract) {
  if (document.format !== contract.extension.carrierFormat || document.version !== contract.extension.carrierVersion) {
    failContract('E_ANIMATION_UNSUPPORTED_VERSION', '$.version', 'Native 3D carrier must use the frozen HYA core version.');
  }
  if (document.nodes.length !== 0) {
    failContract('E_ANIMATION_3D_MIXED_DIMENSIONS', '$.nodes', 'Native 3D carrier cannot contain 2D core nodes.');
  }
  if (document.tracks.length !== 0) {
    failContract('E_ANIMATION_3D_MIXED_DIMENSIONS', '$.tracks', 'Native 3D carrier cannot contain 2D core tracks.');
  }
  assert.ok(document.extensionsUsed.includes(contract.extension.id));
  assert.ok(document.extensionsRequired.includes(contract.extension.id));
  const payload = document.extensions[contract.extension.id];
  assert.ok(payload, 'Native 3D payload is required');
  assert.equal(document.canvas.width, payload.viewport.width);
  assert.equal(document.canvas.height, payload.viewport.height);
  verifyPayload(payload, contract, document);
}

function verifyPayload(payload, contract, document) {
  assert.equal(payload.format, contract.extension.payloadFormat);
  assert.equal(payload.mode, 'native-3d');
  assert.deepEqual(payload.coordinateSystem, {
    handedness: contract.coordinates.handedness,
    upAxis: contract.coordinates.upAxis,
    forwardAxis: contract.coordinates.forwardAxis,
    unit: contract.coordinates.linearUnit,
    angles: contract.coordinates.angles,
    rotationStorage: contract.coordinates.rotationStorage,
  });

  const resources = document === undefined
    ? undefined
    : new Map(document.resources.map(resource => [resource.id, resource]));
  const materials = uniqueMap(payload.materials, 'material');
  const nodes = uniqueMap(payload.nodes, 'node');
  for (const node of nodes.values()) {
    assert.equal(node.transform.translation.length, 3);
    assert.equal(node.transform.rotation.length, 4);
    assert.ok(Math.abs(Math.hypot(...node.transform.rotation) - 1) <= 1e-5);
    assert.equal(node.transform.scale.length, 3);
    if (node.parent !== undefined) assert.ok(nodes.has(node.parent), `Unknown parent ${node.parent}`);
    const components = uniqueMap(node.components, `component on ${node.id}`);
    for (const component of components.values()) {
      if (component.kind === 'primitive3d') assert.ok(materials.has(component.materialId));
      if (component.kind === 'model3d' && resources !== undefined) {
        const resource = resources.get(component.resource);
        assert.equal(resource?.type, contract.resources.modelCoreType);
        assert.ok(contract.resources.modelMimeTypes.includes(resource?.mimeType));
      }
      if (component.kind === 'particle3d' && component.descriptor.textureResource !== undefined && resources !== undefined) {
        assert.equal(resources.get(component.descriptor.textureResource)?.type, 'image');
      }
    }
  }

  const bindingIds = new Set();
  const clips = uniqueMap(payload.clips, 'clip');
  for (const clip of clips.values()) {
    assert.equal(clip.format, contract.runtime.clipFormat);
    const tracks = uniqueMap(clip.tracks, `track in ${clip.id}`);
    for (const track of tracks.values()) {
      const binding = track.binding;
      assert.ok(!bindingIds.has(binding.id), `Duplicate binding ${binding.id}`);
      bindingIds.add(binding.id);
      assert.ok(contract.bindings.paths.includes(binding.path));
      assert.ok(contract.bindings.interpolations.includes(track.interpolation));
      assertStrictlyIncreasing(track.times, `${track.id}.times`);
      assert.ok(track.times.at(-1) <= clip.duration);
      const multiplier = track.interpolation === 'cubic-spline' ? 3 : 1;
      assert.equal(track.values.length, track.times.length * binding.valueSize * multiplier);
      if (binding.path === 'property') {
        const table = binding.component === contract.bindings.materialComponent
          ? contract.bindings.materialProperties
          : binding.component === contract.bindings.cameraComponent
            ? contract.bindings.cameraProperties
            : undefined;
        assert.deepEqual(
          { valueType: binding.valueType, valueSize: binding.valueSize },
          table?.[binding.property],
          `Unknown or mismatched property binding ${binding.component}.${binding.property}`,
        );
      }
    }
  }
  if (payload.stateMachine) {
    assert.equal(payload.stateMachine.format, contract.runtime.stateMachineFormat);
    for (const layer of payload.stateMachine.layers) {
      for (const bindingId of [...(layer.mask?.include ?? []), ...(layer.mask?.exclude ?? [])]) {
        assert.ok(bindingIds.has(bindingId), `Unknown state-machine binding ${bindingId}`);
      }
    }
  }
}

function verifyLocalReferences(schema) {
  visit(schema, (entry, path) => {
    if (typeof entry?.$ref !== 'string' || !entry.$ref.startsWith('#/$defs/')) return;
    const name = entry.$ref.slice('#/$defs/'.length);
    assert.ok(schema.$defs[name], `Unknown local reference ${entry.$ref} at ${path}`);
  });
}

function uniqueMap(values, label) {
  assert.ok(Array.isArray(values), `${label} table must be an array`);
  const result = new Map();
  for (const value of values) {
    assert.ok(typeof value?.id === 'string' && value.id.length > 0, `${label} requires a stable id`);
    assert.ok(!result.has(value.id), `Duplicate ${label} id ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

function assertStrictlyIncreasing(values, path) {
  let previous = -Infinity;
  for (const value of values) {
    assert.ok(Number.isFinite(value) && value > previous, `${path} must be finite and strictly increasing`);
    previous = value;
  }
}

function failContract(code, path, message) {
  const error = new Error(`${message} (${path})`);
  error.code = code;
  error.path = path;
  throw error;
}

function visit(value, callback, path = '$') {
  callback(value, path);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, callback, `${path}[${index}]`));
  else for (const [key, entry] of Object.entries(value)) visit(entry, callback, `${path}.${key}`);
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}
