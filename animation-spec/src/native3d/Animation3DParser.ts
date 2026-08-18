import { AnimationExtensionRegistry } from '../extensions';
import type { AnimationExtensionHandler } from '../extensions';
import { parseAnimation } from '../parser';
import type { AnimationParseOptions, AnimationResource, ParsedAnimation } from '../types';
import { Native3DAnimationFormatError } from './Animation3DError';
import {
  NATIVE_3D_ANIMATION_EXTENSION_ID,
  NATIVE_3D_ANIMATION_FORMAT,
  NATIVE_3D_CLIP_FORMAT,
  NATIVE_3D_STATE_MACHINE_FORMAT,
  type Native3DAnimationParseOptions,
  type Native3DAnimationPayload,
  type Native3DAnimationSource,
  type Native3DBinding,
  type Native3DBindingTarget,
  type Native3DCameraProjection,
  type Native3DClip,
  type Native3DComponent,
  type Native3DCoordinateSystem,
  type Native3DEvent,
  type Native3DMaterial,
  type Native3DNode,
  type Native3DParticleDescriptor,
  type Native3DScalarRange,
  type Native3DStateMachine,
  type Native3DStateMachineCondition,
  type Native3DStateMachineLayer,
  type Native3DStateMachineMotion,
  type Native3DStateMachineParameter,
  type Native3DStateMachineState,
  type Native3DStateMachineTransition,
  type Native3DTrack,
  type Native3DTransform,
  type Native3DVec2,
  type Native3DVec3,
  type Native3DVec4,
  type Native3DViewport,
  type ParsedNative3DAnimation,
} from './Animation3DTypes';

const EXTENSION_PATH = `$.extensions.${NATIVE_3D_ANIMATION_EXTENSION_ID}`;
const MODEL_MIME_TYPES = new Set(['model/gltf-binary', 'model/gltf+json']);
const FORBIDDEN_URI_SCHEMES = new Set(['blob', 'file', 'javascript']);
const DEFAULT_LIMITS = Object.freeze({
  maxMaterials: 10_000,
  maxNodes: 100_000,
  maxComponents: 200_000,
  maxClips: 10_000,
  maxTracks: 200_000,
  maxKeyframes: 5_000_000,
  maxParticleCapacity: 2_000_000,
  maxStateMachineDepth: 64,
});

interface Limits {
  readonly maxMaterials: number;
  readonly maxNodes: number;
  readonly maxComponents: number;
  readonly maxClips: number;
  readonly maxTracks: number;
  readonly maxKeyframes: number;
  readonly maxParticleCapacity: number;
  readonly maxStateMachineDepth: number;
}

export function createNative3DAnimationExtensionHandler(
  options: Native3DAnimationParseOptions = {},
  onValidated?: (payload: Native3DAnimationPayload) => void,
): AnimationExtensionHandler {
  return Object.freeze({
    id: NATIVE_3D_ANIMATION_EXTENSION_ID,
    validateDocument(value: unknown): void {
      onValidated?.(parseNative3DAnimationPayload(value, options));
    },
  });
}

/** Parses the required 3D extension and rejects mixed 2D/3D carriers. */
export function parseNative3DAnimation(
  source: Native3DAnimationSource,
  options: Native3DAnimationParseOptions = {},
): ParsedNative3DAnimation {
  const extensions = new AnimationExtensionRegistry();
  let payload: Native3DAnimationPayload | undefined;
  extensions.register(createNative3DAnimationExtensionHandler(options, value => { payload = value; }));
  const coreOptions: AnimationParseOptions = {
    ...pickCoreLimits(options),
    extensions,
    ...(options.copyFloatData === undefined ? {} : { copyFloatData: options.copyFloatData }),
  };
  const document = parseAnimation(source, coreOptions);
  if (!payload) {
    throw new Native3DAnimationFormatError(
      'E_ANIMATION_3D_INVALID_PAYLOAD',
      `Required extension "${NATIVE_3D_ANIMATION_EXTENSION_ID}" has no document payload.`,
      EXTENSION_PATH,
    );
  }
  validateCarrier(document, payload);
  validateResourceReferences(document.resources, payload);
  return Object.freeze({ document, payload, resources: document.resources });
}

/** Validates and canonicalizes the extension before any runtime allocation. */
export function parseNative3DAnimationPayload(
  value: unknown,
  options: Native3DAnimationParseOptions = {},
): Native3DAnimationPayload {
  const limits = resolveLimits(options);
  const root = object(value, EXTENSION_PATH, [
    'format', 'mode', 'coordinateSystem', 'viewport', 'materials', 'nodes', 'clips',
  ], ['format', 'mode', 'coordinateSystem', 'viewport', 'materials', 'nodes', 'clips', 'stateMachine']);
  exact(root.format, NATIVE_3D_ANIMATION_FORMAT, `${EXTENSION_PATH}.format`);
  exact(root.mode, 'native-3d', `${EXTENSION_PATH}.mode`);
  const coordinateSystem = parseCoordinateSystem(root.coordinateSystem, `${EXTENSION_PATH}.coordinateSystem`);
  const viewport = parseViewport(root.viewport, `${EXTENSION_PATH}.viewport`);

  const materialValues = array(root.materials, `${EXTENSION_PATH}.materials`);
  budget(materialValues.length, limits.maxMaterials, 'materials', `${EXTENSION_PATH}.materials`);
  const materialIds = new Set<string>();
  const materials = materialValues.map((entry, index) => {
    const material = parseMaterial(entry, `${EXTENSION_PATH}.materials[${index}]`);
    unique(materialIds, material.id, `${EXTENSION_PATH}.materials[${index}].id`, 'material');
    return material;
  });

  const nodeValues = array(root.nodes, `${EXTENSION_PATH}.nodes`);
  budget(nodeValues.length, limits.maxNodes, 'nodes', `${EXTENSION_PATH}.nodes`);
  const nodeIds = new Set<string>();
  const componentIds = new Set<string>();
  let componentCount = 0;
  let particleCapacity = 0;
  const nodes = nodeValues.map((entry, index) => {
    const path = `${EXTENSION_PATH}.nodes[${index}]`;
    const node = parseNode(entry, path);
    unique(nodeIds, node.id, `${path}.id`, 'node');
    for (let componentIndex = 0; componentIndex < node.components.length; componentIndex++) {
      const component = node.components[componentIndex]!;
      unique(componentIds, component.id, `${path}.components[${componentIndex}].id`, 'component');
      componentCount++;
      if (component.kind === 'particle3d') particleCapacity += component.descriptor.maxParticles;
    }
    budget(componentCount, limits.maxComponents, 'components', `${path}.components`);
    budget(particleCapacity, limits.maxParticleCapacity, 'particle capacity', `${path}.components`);
    return node;
  });
  validateNodeSemantics(nodes, nodeIds, materialIds);

  const clipValues = array(root.clips, `${EXTENSION_PATH}.clips`);
  budget(clipValues.length, limits.maxClips, 'clips', `${EXTENSION_PATH}.clips`);
  const clipIds = new Set<string>();
  const bindingIds = new Set<string>();
  let trackCount = 0;
  let keyframeCount = 0;
  const clips = clipValues.map((entry, index) => {
    const path = `${EXTENSION_PATH}.clips[${index}]`;
    const clip = parseClip(entry, path);
    unique(clipIds, clip.id, `${path}.id`, 'clip');
    trackCount += clip.tracks.length;
    keyframeCount += clip.tracks.reduce((sum, track) => sum + track.times.length, 0);
    budget(trackCount, limits.maxTracks, 'tracks', `${path}.tracks`);
    budget(keyframeCount, limits.maxKeyframes, 'keyframes', `${path}.tracks`);
    const clipBindingIds = new Set<string>();
    for (let trackIndex = 0; trackIndex < clip.tracks.length; trackIndex++) {
      const track = clip.tracks[trackIndex]!;
      unique(clipBindingIds, track.binding.id, `${path}.tracks[${trackIndex}].binding.id`, 'binding');
      bindingIds.add(track.binding.id);
      validateBindingTarget(track.binding, nodes, materialIds, `${path}.tracks[${trackIndex}].binding`);
    }
    return clip;
  });

  const stateMachine = root.stateMachine === undefined || root.stateMachine === null
    ? root.stateMachine as undefined | null
    : parseStateMachine(root.stateMachine, `${EXTENSION_PATH}.stateMachine`, limits.maxStateMachineDepth);
  if (stateMachine) validateStateMachineReferences(stateMachine, clipIds, bindingIds, `${EXTENSION_PATH}.stateMachine`);

  return deepFreeze({
    format: NATIVE_3D_ANIMATION_FORMAT,
    mode: 'native-3d',
    coordinateSystem,
    viewport,
    materials,
    nodes,
    clips,
    ...(root.stateMachine === undefined ? {} : { stateMachine: stateMachine ?? null }),
  });
}

function parseCoordinateSystem(value: unknown, path: string): Native3DCoordinateSystem {
  const item = object(value, path,
    ['handedness', 'upAxis', 'forwardAxis', 'unit', 'angles', 'rotationStorage'],
    ['handedness', 'upAxis', 'forwardAxis', 'unit', 'angles', 'rotationStorage']);
  exact(item.handedness, 'right', `${path}.handedness`);
  exact(item.upAxis, '+y', `${path}.upAxis`);
  exact(item.forwardAxis, '-z', `${path}.forwardAxis`);
  exact(item.unit, 'meter', `${path}.unit`);
  exact(item.angles, 'radian', `${path}.angles`);
  exact(item.rotationStorage, 'normalized-xyzw-quaternion', `${path}.rotationStorage`);
  return Object.freeze({
    handedness: 'right', upAxis: '+y', forwardAxis: '-z', unit: 'meter', angles: 'radian',
    rotationStorage: 'normalized-xyzw-quaternion',
  });
}

function parseViewport(value: unknown, path: string): Native3DViewport {
  const item = object(value, path, ['width', 'height'], ['width', 'height']);
  return Object.freeze({ width: positive(item.width, `${path}.width`), height: positive(item.height, `${path}.height`) });
}

function parseMaterial(value: unknown, path: string): Native3DMaterial {
  const item = object(value, path,
    ['id', 'name', 'baseColorFactor', 'metallicFactor', 'roughnessFactor', 'emissiveFactor', 'alphaMode', 'doubleSided'],
    ['id', 'name', 'baseColorFactor', 'metallicFactor', 'roughnessFactor', 'emissiveFactor', 'alphaMode', 'alphaCutoff', 'doubleSided', 'baseColorTexture', 'normalTexture', 'metallicRoughnessTexture', 'emissiveTexture']);
  return Object.freeze({
    id: nonEmpty(item.id, `${path}.id`),
    name: string(item.name, `${path}.name`),
    baseColorFactor: vec4(item.baseColorFactor, `${path}.baseColorFactor`, 0, 1),
    metallicFactor: bounded(item.metallicFactor, `${path}.metallicFactor`, 0, 1),
    roughnessFactor: bounded(item.roughnessFactor, `${path}.roughnessFactor`, 0, 1),
    emissiveFactor: vec3(item.emissiveFactor, `${path}.emissiveFactor`, 0),
    alphaMode: enumeration(item.alphaMode, ['opaque', 'mask', 'blend'] as const, `${path}.alphaMode`),
    ...(item.alphaCutoff === undefined ? {} : { alphaCutoff: bounded(item.alphaCutoff, `${path}.alphaCutoff`, 0, 1) }),
    doubleSided: boolean(item.doubleSided, `${path}.doubleSided`),
    ...optionalStrings(item, path, ['baseColorTexture', 'normalTexture', 'metallicRoughnessTexture', 'emissiveTexture']),
  });
}

function parseNode(value: unknown, path: string): Native3DNode {
  const item = object(value, path, ['id', 'name', 'transform', 'components'],
    ['id', 'name', 'parent', 'start', 'duration', 'transform', 'components']);
  const components = array(item.components, `${path}.components`).map((entry, index) => (
    parseComponent(entry, `${path}.components[${index}]`)
  ));
  return Object.freeze({
    id: nonEmpty(item.id, `${path}.id`),
    name: string(item.name, `${path}.name`),
    ...(item.parent === undefined ? {} : { parent: nonEmpty(item.parent, `${path}.parent`) }),
    ...(item.start === undefined ? {} : { start: nonNegative(item.start, `${path}.start`) }),
    ...(item.duration === undefined ? {} : { duration: positive(item.duration, `${path}.duration`) }),
    transform: parseTransform(item.transform, `${path}.transform`),
    components: Object.freeze(components),
  });
}

function parseTransform(value: unknown, path: string): Native3DTransform {
  const item = object(value, path, ['translation', 'rotation', 'scale'], ['translation', 'rotation', 'scale']);
  const rotation = vec4(item.rotation, `${path}.rotation`);
  assertNormalizedQuaternion(rotation, `${path}.rotation`);
  return Object.freeze({
    translation: vec3(item.translation, `${path}.translation`),
    rotation,
    scale: vec3(item.scale, `${path}.scale`),
  });
}

function parseComponent(value: unknown, path: string): Native3DComponent {
  const kind = object(value, path).kind;
  if (kind === 'camera3d') {
    const item = object(value, path, ['id', 'kind', 'projection'], ['id', 'kind', 'projection']);
    return Object.freeze({ id: nonEmpty(item.id, `${path}.id`), kind, projection: parseCamera(item.projection, `${path}.projection`) });
  }
  if (kind === 'primitive3d') {
    const item = object(value, path, ['id', 'kind', 'primitive', 'materialId'], ['id', 'kind', 'primitive', 'materialId']);
    return Object.freeze({
      id: nonEmpty(item.id, `${path}.id`), kind,
      primitive: enumeration(item.primitive, ['box', 'sphere', 'plane', 'cylinder', 'cone'] as const, `${path}.primitive`),
      materialId: nonEmpty(item.materialId, `${path}.materialId`),
    });
  }
  if (kind === 'model3d') {
    const item = object(value, path, ['id', 'kind', 'resource'], ['id', 'kind', 'resource', 'materialOverrides']);
    const materialOverrides = item.materialOverrides === undefined ? undefined : array(item.materialOverrides, `${path}.materialOverrides`).map((entry, index) => {
      const overridePath = `${path}.materialOverrides[${index}]`;
      const override = object(entry, overridePath, ['slot', 'materialId'], ['slot', 'materialId']);
      return Object.freeze({ slot: nonEmpty(override.slot, `${overridePath}.slot`), materialId: nonEmpty(override.materialId, `${overridePath}.materialId`) });
    });
    return Object.freeze({
      id: nonEmpty(item.id, `${path}.id`), kind, resource: nonEmpty(item.resource, `${path}.resource`),
      ...(materialOverrides ? { materialOverrides: Object.freeze(materialOverrides) } : {}),
    });
  }
  if (kind === 'particle3d') {
    const item = object(value, path, ['id', 'kind', 'descriptor'], ['id', 'kind', 'descriptor']);
    return Object.freeze({
      id: nonEmpty(item.id, `${path}.id`), kind,
      descriptor: parseParticle(item.descriptor, `${path}.descriptor`),
    });
  }
  invalid(`Unsupported component kind "${String(kind)}".`, `${path}.kind`, 'E_ANIMATION_3D_UNSUPPORTED_FEATURE');
}

function parseCamera(value: unknown, path: string): Native3DCameraProjection {
  const kind = object(value, path).kind;
  if (kind === 'perspective') {
    const item = object(value, path, ['kind', 'fovYRadians', 'near', 'far'], ['kind', 'fovYRadians', 'near', 'far']);
    const near = positive(item.near, `${path}.near`);
    const far = positive(item.far, `${path}.far`);
    if (far <= near) invalid('Camera far must be greater than near.', `${path}.far`);
    return Object.freeze({
      kind, fovYRadians: bounded(item.fovYRadians, `${path}.fovYRadians`, Number.MIN_VALUE, Math.PI, false), near, far,
    });
  }
  if (kind === 'orthographic') {
    const item = object(value, path, ['kind', 'orthoHeight', 'near', 'far'], ['kind', 'orthoHeight', 'near', 'far']);
    const near = nonNegative(item.near, `${path}.near`);
    const far = positive(item.far, `${path}.far`);
    if (far <= near) invalid('Camera far must be greater than near.', `${path}.far`);
    return Object.freeze({ kind, orthoHeight: positive(item.orthoHeight, `${path}.orthoHeight`), near, far });
  }
  invalid(`Unsupported camera projection "${String(kind)}".`, `${path}.kind`, 'E_ANIMATION_3D_UNSUPPORTED_FEATURE');
}

function parseParticle(value: unknown, path: string): Native3DParticleDescriptor {
  const required = ['maxParticles', 'emissionRate', 'burst', 'duration', 'loop', 'seed', 'lifetime', 'speed', 'direction', 'spread', 'gravity', 'startSize', 'endSize', 'rotation', 'angularVelocity', 'startColor', 'endColor', 'shape', 'blendMode', 'radial', 'opacity', 'depthTest', 'depthWrite', 'sortMode'];
  const item = object(value, path, required, [...required, 'shapeSize', 'shapeRadius', 'textureResource']);
  return Object.freeze({
    maxParticles: integer(item.maxParticles, `${path}.maxParticles`, 1, 1_000_000),
    emissionRate: nonNegative(item.emissionRate, `${path}.emissionRate`),
    burst: integer(item.burst, `${path}.burst`, 0, 1_000_000),
    duration: positive(item.duration, `${path}.duration`),
    loop: boolean(item.loop, `${path}.loop`),
    seed: integer(item.seed, `${path}.seed`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    lifetime: range(item.lifetime, `${path}.lifetime`, 0),
    speed: range(item.speed, `${path}.speed`),
    direction: vec3(item.direction, `${path}.direction`),
    spread: bounded(item.spread, `${path}.spread`, 0, Math.PI),
    gravity: vec3(item.gravity, `${path}.gravity`),
    startSize: range(item.startSize, `${path}.startSize`, 0),
    endSize: range(item.endSize, `${path}.endSize`, 0),
    rotation: range(item.rotation, `${path}.rotation`),
    angularVelocity: range(item.angularVelocity, `${path}.angularVelocity`),
    startColor: vec4(item.startColor, `${path}.startColor`, 0, 1),
    endColor: vec4(item.endColor, `${path}.endColor`, 0, 1),
    shape: enumeration(item.shape, ['point', 'box', 'sphere'] as const, `${path}.shape`),
    ...(item.shapeSize === undefined ? {} : { shapeSize: vec3(item.shapeSize, `${path}.shapeSize`, 0) }),
    ...(item.shapeRadius === undefined ? {} : { shapeRadius: nonNegative(item.shapeRadius, `${path}.shapeRadius`) }),
    blendMode: enumeration(item.blendMode, ['normal', 'additive'] as const, `${path}.blendMode`),
    ...(item.textureResource === undefined ? {} : { textureResource: nonEmpty(item.textureResource, `${path}.textureResource`) }),
    radial: boolean(item.radial, `${path}.radial`),
    opacity: bounded(item.opacity, `${path}.opacity`, 0, 1),
    depthTest: boolean(item.depthTest, `${path}.depthTest`),
    depthWrite: boolean(item.depthWrite, `${path}.depthWrite`),
    sortMode: enumeration(item.sortMode, ['none', 'back-to-front'] as const, `${path}.sortMode`),
  });
}

function parseClip(value: unknown, path: string): Native3DClip {
  const item = object(value, path, ['format', 'id', 'name', 'duration', 'tracks', 'events'], ['format', 'id', 'name', 'duration', 'tracks', 'events']);
  exact(item.format, NATIVE_3D_CLIP_FORMAT, `${path}.format`);
  const duration = positive(item.duration, `${path}.duration`);
  const trackIds = new Set<string>();
  const tracks = array(item.tracks, `${path}.tracks`).map((entry, index) => {
    const trackPath = `${path}.tracks[${index}]`;
    const track = parseTrack(entry, trackPath, duration);
    unique(trackIds, track.id, `${trackPath}.id`, 'track');
    return track;
  });
  const eventIds = new Set<string>();
  const events = array(item.events, `${path}.events`).map((entry, index) => {
    const eventPath = `${path}.events[${index}]`;
    const event = parseEvent(entry, eventPath, duration);
    unique(eventIds, event.id, `${eventPath}.id`, 'event');
    return event;
  });
  return Object.freeze({
    format: NATIVE_3D_CLIP_FORMAT,
    id: nonEmpty(item.id, `${path}.id`),
    name: string(item.name, `${path}.name`),
    duration,
    tracks: Object.freeze(tracks),
    events: Object.freeze(events),
  });
}

function parseTrack(value: unknown, path: string, duration: number): Native3DTrack {
  const item = object(value, path, ['id', 'binding', 'interpolation', 'times', 'values'], ['id', 'binding', 'interpolation', 'times', 'values']);
  const binding = parseBinding(item.binding, `${path}.binding`);
  const interpolation = enumeration(item.interpolation, ['step', 'linear', 'cubic-spline'] as const, `${path}.interpolation`);
  const times = numericArray(item.times, `${path}.times`, 1);
  for (let index = 0; index < times.length; index++) {
    const time = times[index]!;
    if (time < 0 || time > duration) invalid('Track time must lie within clip duration.', `${path}.times[${index}]`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    if (index > 0 && time <= times[index - 1]!) invalid('Track times must be strictly increasing.', `${path}.times[${index}]`, 'E_ANIMATION_3D_BINDING_MISMATCH');
  }
  const values = numericArray(item.values, `${path}.values`, 1);
  const expected = times.length * binding.valueSize * (interpolation === 'cubic-spline' ? 3 : 1);
  if (values.length !== expected) {
    invalid(`Track values length ${values.length} does not match expected ${expected}.`, `${path}.values`, 'E_ANIMATION_3D_BINDING_MISMATCH');
  }
  if (binding.path === 'transform.rotation') validateTrackQuaternions(values, times.length, interpolation, `${path}.values`);
  return Object.freeze({ id: nonEmpty(item.id, `${path}.id`), binding, interpolation, times, values });
}

function parseBinding(value: unknown, path: string): Native3DBinding {
  const base = object(value, path);
  const target = parseBindingTarget(base.target, `${path}.target`);
  const id = nonEmpty(base.id, `${path}.id`);
  if (base.path === 'transform.translation' || base.path === 'transform.scale') {
    const item = object(value, path, ['id', 'target', 'path', 'valueType', 'valueSize'], ['id', 'target', 'path', 'valueType', 'valueSize']);
    exact(item.valueType, 'vec3', `${path}.valueType`);
    exact(item.valueSize, 3, `${path}.valueSize`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    return Object.freeze({ id, target, path: base.path, valueType: 'vec3', valueSize: 3 });
  }
  if (base.path === 'transform.rotation') {
    const item = object(value, path, ['id', 'target', 'path', 'valueType', 'valueSize'], ['id', 'target', 'path', 'valueType', 'valueSize']);
    exact(item.valueType, 'quaternion', `${path}.valueType`);
    exact(item.valueSize, 4, `${path}.valueSize`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    return Object.freeze({ id, target, path: base.path, valueType: 'quaternion', valueSize: 4 });
  }
  if (base.path === 'morph.weights') {
    const item = object(value, path, ['id', 'target', 'path', 'valueType', 'valueSize'], ['id', 'target', 'path', 'valueType', 'valueSize']);
    exact(item.valueType, 'weights', `${path}.valueType`);
    return Object.freeze({ id, target, path: base.path, valueType: 'weights', valueSize: integer(item.valueSize, `${path}.valueSize`, 1, 65_536) });
  }
  if (base.path === 'property') {
    const item = object(value, path, ['id', 'target', 'path', 'component', 'property', 'valueType', 'valueSize'], ['id', 'target', 'path', 'component', 'property', 'valueType', 'valueSize']);
    const component = enumeration(item.component, ['material3d', 'camera3d'] as const, `${path}.component`);
    const property = enumeration(item.property, ['baseColorFactor', 'metallicFactor', 'roughnessFactor', 'emissiveFactor', 'alphaCutoff', 'fovYRadians', 'near', 'far', 'orthoHeight'] as const, `${path}.property`);
    const contract = propertyContract(component, property, `${path}.property`);
    exact(item.valueType, contract.valueType, `${path}.valueType`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    exact(item.valueSize, contract.valueSize, `${path}.valueSize`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    return Object.freeze({ id, target, path: 'property', component, property, ...contract });
  }
  invalid(`Unsupported binding path "${String(base.path)}".`, `${path}.path`, 'E_ANIMATION_3D_UNSUPPORTED_FEATURE');
}

function parseBindingTarget(value: unknown, path: string): Native3DBindingTarget {
  const kind = object(value, path).kind;
  if (kind === 'node-id') {
    const item = object(value, path, ['kind', 'nodeId'], ['kind', 'nodeId']);
    return Object.freeze({ kind, nodeId: nonEmpty(item.nodeId, `${path}.nodeId`) });
  }
  if (kind === 'node-path') {
    const item = object(value, path, ['kind', 'segments'], ['kind', 'segments']);
    const segments = array(item.segments, `${path}.segments`);
    if (segments.length === 0) invalid('Node path must contain at least one segment.', `${path}.segments`);
    return Object.freeze({ kind, segments: Object.freeze(segments.map((segment, index) => nonEmpty(segment, `${path}.segments[${index}]`))) });
  }
  if (kind === 'slot') {
    const item = object(value, path, ['kind', 'slot'], ['kind', 'slot']);
    return Object.freeze({ kind, slot: nonEmpty(item.slot, `${path}.slot`) });
  }
  invalid(`Unsupported binding target "${String(kind)}".`, `${path}.kind`, 'E_ANIMATION_3D_UNSUPPORTED_FEATURE');
}

function parseEvent(value: unknown, path: string, duration: number): Native3DEvent {
  const item = object(value, path, ['id', 'time', 'name'], ['id', 'time', 'name', 'payload']);
  const time = nonNegative(item.time, `${path}.time`);
  if (time > duration) invalid('Event time must lie within clip duration.', `${path}.time`);
  return Object.freeze({
    id: nonEmpty(item.id, `${path}.id`), time, name: nonEmpty(item.name, `${path}.name`),
    ...(item.payload === undefined ? {} : { payload: parseJsonObject(item.payload, `${path}.payload`) }),
  });
}

function parseStateMachine(value: unknown, path: string, maxDepth: number): Native3DStateMachine {
  const item = object(value, path, ['format', 'id', 'name', 'parameters', 'layers'], ['format', 'id', 'name', 'parameters', 'layers']);
  exact(item.format, NATIVE_3D_STATE_MACHINE_FORMAT, `${path}.format`);
  const parameterNames = new Set<string>();
  const parameters = array(item.parameters, `${path}.parameters`).map((entry, index) => {
    const parameterPath = `${path}.parameters[${index}]`;
    const parameter = parseParameter(entry, parameterPath);
    unique(parameterNames, parameter.name, `${parameterPath}.name`, 'state-machine parameter');
    return parameter;
  });
  const layerIds = new Set<string>();
  const layers = array(item.layers, `${path}.layers`).map((entry, index) => {
    const layerPath = `${path}.layers[${index}]`;
    const layer = parseLayer(entry, layerPath, maxDepth);
    unique(layerIds, layer.id, `${layerPath}.id`, 'state-machine layer');
    return layer;
  });
  return Object.freeze({
    format: NATIVE_3D_STATE_MACHINE_FORMAT,
    id: nonEmpty(item.id, `${path}.id`), name: string(item.name, `${path}.name`),
    parameters: Object.freeze(parameters), layers: Object.freeze(layers),
  });
}

function parseParameter(value: unknown, path: string): Native3DStateMachineParameter {
  const base = object(value, path);
  const name = nonEmpty(base.name, `${path}.name`);
  if (base.type === 'trigger') {
    object(value, path, ['name', 'type'], ['name', 'type']);
    return Object.freeze({ name, type: 'trigger' });
  }
  object(value, path, ['name', 'type', 'defaultValue'], ['name', 'type', 'defaultValue']);
  if (base.type === 'float') return Object.freeze({ name, type: 'float', defaultValue: finite(base.defaultValue, `${path}.defaultValue`) });
  if (base.type === 'integer') return Object.freeze({ name, type: 'integer', defaultValue: integer(base.defaultValue, `${path}.defaultValue`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) });
  if (base.type === 'boolean') return Object.freeze({ name, type: 'boolean', defaultValue: boolean(base.defaultValue, `${path}.defaultValue`) });
  invalid(`Unsupported parameter type "${String(base.type)}".`, `${path}.type`, 'E_ANIMATION_3D_UNSUPPORTED_FEATURE');
}

function parseLayer(value: unknown, path: string, maxDepth: number): Native3DStateMachineLayer {
  const item = object(value, path, ['id', 'name', 'initialStateId', 'states', 'transitions'],
    ['id', 'name', 'initialStateId', 'states', 'transitions', 'blendMode', 'weight', 'mask']);
  const stateIds = new Set<string>();
  const states = array(item.states, `${path}.states`).map((entry, index) => {
    const statePath = `${path}.states[${index}]`;
    const state = parseState(entry, statePath, maxDepth);
    unique(stateIds, state.id, `${statePath}.id`, 'state');
    return state;
  });
  const transitionIds = new Set<string>();
  const transitions = array(item.transitions, `${path}.transitions`).map((entry, index) => {
    const transitionPath = `${path}.transitions[${index}]`;
    const transition = parseTransition(entry, transitionPath);
    unique(transitionIds, transition.id, `${transitionPath}.id`, 'transition');
    return transition;
  });
  const mask = item.mask === undefined ? undefined : parseMask(item.mask, `${path}.mask`);
  return Object.freeze({
    id: nonEmpty(item.id, `${path}.id`), name: string(item.name, `${path}.name`),
    initialStateId: nonEmpty(item.initialStateId, `${path}.initialStateId`),
    states: Object.freeze(states), transitions: Object.freeze(transitions),
    ...(item.blendMode === undefined ? {} : { blendMode: enumeration(item.blendMode, ['override', 'additive'] as const, `${path}.blendMode`) }),
    ...(item.weight === undefined ? {} : { weight: bounded(item.weight, `${path}.weight`, 0, 1) }),
    ...(mask ? { mask } : {}),
  });
}

function parseState(value: unknown, path: string, maxDepth: number): Native3DStateMachineState {
  const item = object(value, path, ['id', 'name', 'motion'], ['id', 'name', 'motion', 'speed', 'speedParameter', 'loop']);
  return Object.freeze({
    id: nonEmpty(item.id, `${path}.id`), name: string(item.name, `${path}.name`),
    motion: parseMotion(item.motion, `${path}.motion`, 0, maxDepth),
    ...(item.speed === undefined ? {} : { speed: finite(item.speed, `${path}.speed`) }),
    ...(item.speedParameter === undefined ? {} : { speedParameter: nonEmpty(item.speedParameter, `${path}.speedParameter`) }),
    ...(item.loop === undefined ? {} : { loop: enumeration(item.loop, ['once', 'repeat', 'ping-pong'] as const, `${path}.loop`) }),
  });
}

function parseMotion(value: unknown, path: string, depth: number, maxDepth: number): Native3DStateMachineMotion {
  if (depth >= maxDepth) budget(depth + 1, maxDepth, 'state-machine motion depth', path);
  const base = object(value, path);
  if (base.kind === 'clip') {
    const item = object(value, path, ['kind', 'clipId'], ['kind', 'clipId']);
    return Object.freeze({ kind: 'clip', clipId: nonEmpty(item.clipId, `${path}.clipId`) });
  }
  if (base.kind === 'blend-1d') {
    const item = object(value, path, ['kind', 'parameter', 'children'], ['kind', 'parameter', 'children']);
    const children = nonEmptyArray(item.children, `${path}.children`).map((entry, index) => {
      const childPath = `${path}.children[${index}]`;
      const child = object(entry, childPath, ['threshold', 'motion'], ['threshold', 'motion']);
      return Object.freeze({ threshold: finite(child.threshold, `${childPath}.threshold`), motion: parseMotion(child.motion, `${childPath}.motion`, depth + 1, maxDepth) });
    });
    return Object.freeze({ kind: 'blend-1d', parameter: nonEmpty(item.parameter, `${path}.parameter`), children: Object.freeze(children) });
  }
  if (base.kind === 'blend-2d') {
    const item = object(value, path, ['kind', 'algorithm', 'parameterX', 'parameterY', 'children'], ['kind', 'algorithm', 'parameterX', 'parameterY', 'children']);
    const children = nonEmptyArray(item.children, `${path}.children`).map((entry, index) => {
      const childPath = `${path}.children[${index}]`;
      const child = object(entry, childPath, ['position', 'motion'], ['position', 'motion']);
      return Object.freeze({ position: vec2(child.position, `${childPath}.position`), motion: parseMotion(child.motion, `${childPath}.motion`, depth + 1, maxDepth) });
    });
    return Object.freeze({
      kind: 'blend-2d', algorithm: enumeration(item.algorithm, ['cartesian', 'directional'] as const, `${path}.algorithm`),
      parameterX: nonEmpty(item.parameterX, `${path}.parameterX`), parameterY: nonEmpty(item.parameterY, `${path}.parameterY`),
      children: Object.freeze(children),
    });
  }
  invalid(`Unsupported motion kind "${String(base.kind)}".`, `${path}.kind`, 'E_ANIMATION_3D_UNSUPPORTED_FEATURE');
}

function parseTransition(value: unknown, path: string): Native3DStateMachineTransition {
  const item = object(value, path, ['id', 'from', 'to', 'conditions', 'duration'],
    ['id', 'from', 'to', 'conditions', 'duration', 'hasExitTime', 'exitTime', 'destinationOffset', 'interruption']);
  const conditions = array(item.conditions, `${path}.conditions`).map((entry, index) => parseCondition(entry, `${path}.conditions[${index}]`));
  return Object.freeze({
    id: nonEmpty(item.id, `${path}.id`), from: nonEmpty(item.from, `${path}.from`), to: nonEmpty(item.to, `${path}.to`),
    conditions: Object.freeze(conditions), duration: nonNegative(item.duration, `${path}.duration`),
    ...(item.hasExitTime === undefined ? {} : { hasExitTime: boolean(item.hasExitTime, `${path}.hasExitTime`) }),
    ...(item.exitTime === undefined ? {} : { exitTime: nonNegative(item.exitTime, `${path}.exitTime`) }),
    ...(item.destinationOffset === undefined ? {} : { destinationOffset: nonNegative(item.destinationOffset, `${path}.destinationOffset`) }),
    ...(item.interruption === undefined ? {} : { interruption: enumeration(item.interruption, ['none', 'source', 'destination', 'source-then-destination', 'destination-then-source'] as const, `${path}.interruption`) }),
  });
}

function parseCondition(value: unknown, path: string): Native3DStateMachineCondition {
  const item = object(value, path, ['parameter', 'operator'], ['parameter', 'operator', 'value']);
  const operator = enumeration(item.operator, ['greater', 'greater-or-equal', 'less', 'less-or-equal', 'equal', 'not-equal', 'is-true', 'is-false', 'triggered'] as const, `${path}.operator`);
  return Object.freeze({
    parameter: nonEmpty(item.parameter, `${path}.parameter`), operator,
    ...(item.value === undefined ? {} : { value: typeof item.value === 'boolean' ? item.value : finite(item.value, `${path}.value`) }),
  });
}

function parseMask(value: unknown, path: string): Readonly<{ include?: readonly string[]; exclude?: readonly string[] }> {
  const item = object(value, path, [], ['include', 'exclude']);
  const parseList = (entry: unknown, entryPath: string): readonly string[] => {
    const seen = new Set<string>();
    return Object.freeze(array(entry, entryPath).map((value, index) => {
      const result = nonEmpty(value, `${entryPath}[${index}]`);
      unique(seen, result, `${entryPath}[${index}]`, 'mask binding');
      return result;
    }));
  };
  return Object.freeze({
    ...(item.include === undefined ? {} : { include: parseList(item.include, `${path}.include`) }),
    ...(item.exclude === undefined ? {} : { exclude: parseList(item.exclude, `${path}.exclude`) }),
  });
}

function validateCarrier(document: ParsedAnimation, payload: Native3DAnimationPayload): void {
  if (document.extensionsUsed.length !== 1 || document.extensionsUsed[0] !== NATIVE_3D_ANIMATION_EXTENSION_ID
    || document.extensionsRequired.length !== 1 || document.extensionsRequired[0] !== NATIVE_3D_ANIMATION_EXTENSION_ID) {
    invalid(`Native 3D carrier must use and require only "${NATIVE_3D_ANIMATION_EXTENSION_ID}".`, '$.extensionsRequired');
  }
  if (document.nodes.length > 0) {
    invalid('Native 3D carrier cannot contain core 2D nodes.', '$.nodes', 'E_ANIMATION_3D_MIXED_DIMENSIONS');
  }
  if (document.tracks.length > 0) {
    invalid('Native 3D carrier cannot contain core 2D tracks.', '$.tracks', 'E_ANIMATION_3D_MIXED_DIMENSIONS');
  }
  if (document.canvas.width !== payload.viewport.width || document.canvas.height !== payload.viewport.height) {
    invalid('Core canvas and native 3D viewport dimensions must match.', `${EXTENSION_PATH}.viewport`);
  }
  for (let index = 0; index < payload.nodes.length; index++) {
    const node = payload.nodes[index]!;
    const start = node.start ?? 0;
    if (start > document.duration || start + (node.duration ?? document.duration - start) > document.duration + 1e-6) {
      invalid('Node time range must fit inside composition duration.', `${EXTENSION_PATH}.nodes[${index}]`);
    }
  }
  for (let index = 0; index < payload.clips.length; index++) {
    if (payload.clips[index]!.duration > document.duration + 1e-6) {
      invalid('Clip duration must fit inside composition duration.', `${EXTENSION_PATH}.clips[${index}].duration`);
    }
  }
}

function validateNodeSemantics(nodes: readonly Native3DNode[], nodeIds: Set<string>, materialIds: Set<string>): void {
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.parent !== undefined && !nodeIds.has(node.parent)) {
      invalid(`Node parent "${node.parent}" does not exist.`, `${EXTENSION_PATH}.nodes[${index}].parent`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    }
    if (node.parent === node.id) invalid('Node cannot parent itself.', `${EXTENSION_PATH}.nodes[${index}].parent`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    for (let componentIndex = 0; componentIndex < node.components.length; componentIndex++) {
      const component = node.components[componentIndex]!;
      const path = `${EXTENSION_PATH}.nodes[${index}].components[${componentIndex}]`;
      if (component.kind === 'primitive3d' && !materialIds.has(component.materialId)) {
        invalid(`Primitive material "${component.materialId}" does not exist.`, `${path}.materialId`, 'E_ANIMATION_3D_UNKNOWN_RESOURCE');
      }
      if (component.kind === 'model3d') {
        for (let overrideIndex = 0; overrideIndex < (component.materialOverrides?.length ?? 0); overrideIndex++) {
          const materialId = component.materialOverrides![overrideIndex]!.materialId;
          if (!materialIds.has(materialId)) invalid(`Material override "${materialId}" does not exist.`, `${path}.materialOverrides[${overrideIndex}].materialId`, 'E_ANIMATION_3D_UNKNOWN_RESOURCE');
        }
      }
    }
  }
  for (const node of nodes) {
    const visited = new Set<string>();
    let current: Native3DNode | undefined = node;
    while (current?.parent) {
      if (visited.has(current.id)) invalid('Node hierarchy contains a cycle.', `${EXTENSION_PATH}.nodes`, 'E_ANIMATION_3D_BINDING_MISMATCH');
      visited.add(current.id);
      current = byId.get(current.parent);
    }
  }
}

function validateResourceReferences(resources: readonly Readonly<AnimationResource>[], payload: Native3DAnimationPayload): void {
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  for (let index = 0; index < resources.length; index++) {
    const resource = resources[index]!;
    const scheme = uriScheme(resource.uri);
    if (scheme && FORBIDDEN_URI_SCHEMES.has(scheme)) {
      invalid(`Delivery URI scheme "${scheme}:" is forbidden.`, `$.resources[${index}].uri`, 'E_ANIMATION_3D_UNKNOWN_RESOURCE');
    }
  }
  for (let materialIndex = 0; materialIndex < payload.materials.length; materialIndex++) {
    const material = payload.materials[materialIndex]!;
    for (const key of ['baseColorTexture', 'normalTexture', 'metallicRoughnessTexture', 'emissiveTexture'] as const) {
      const id = material[key];
      if (id === undefined) continue;
      const resource = byId.get(id);
      if (!resource || resource.type !== 'image') invalid(`Material texture "${id}" must reference an image resource.`, `${EXTENSION_PATH}.materials[${materialIndex}].${key}`, 'E_ANIMATION_3D_UNKNOWN_RESOURCE');
    }
  }
  for (let nodeIndex = 0; nodeIndex < payload.nodes.length; nodeIndex++) {
    const node = payload.nodes[nodeIndex]!;
    for (let componentIndex = 0; componentIndex < node.components.length; componentIndex++) {
      const component = node.components[componentIndex]!;
      const path = `${EXTENSION_PATH}.nodes[${nodeIndex}].components[${componentIndex}]`;
      if (component.kind === 'model3d') {
        const resource = byId.get(component.resource);
        if (!resource || resource.type !== 'binary' || !resource.mimeType || !MODEL_MIME_TYPES.has(resource.mimeType)) {
          invalid(`Model "${component.resource}" must reference a binary glTF/GLB resource.`, `${path}.resource`, 'E_ANIMATION_3D_UNKNOWN_RESOURCE');
        }
      }
      if (component.kind === 'particle3d' && component.descriptor.textureResource !== undefined) {
        const resource = byId.get(component.descriptor.textureResource);
        if (!resource || resource.type !== 'image') invalid(`Particle texture "${component.descriptor.textureResource}" must reference an image resource.`, `${path}.descriptor.textureResource`, 'E_ANIMATION_3D_UNKNOWN_RESOURCE');
      }
    }
  }
}

function validateBindingTarget(binding: Native3DBinding, nodes: readonly Native3DNode[], materialIds: Set<string>, path: string): void {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const target = binding.target;
  if (target.kind === 'node-id' && !byId.has(target.nodeId)) {
    invalid(`Binding node "${target.nodeId}" does not exist.`, `${path}.target.nodeId`, 'E_ANIMATION_3D_BINDING_MISMATCH');
  }
  if (target.kind === 'node-path' && !byId.has(target.segments[0]!)) {
    invalid(`Binding node path root "${target.segments[0]}" does not exist.`, `${path}.target.segments[0]`, 'E_ANIMATION_3D_BINDING_MISMATCH');
  }
  if (binding.path === 'property' && binding.component === 'material3d') {
    if (target.kind !== 'slot' || !materialIds.has(target.slot)) invalid('Material property bindings require a material-id slot target.', `${path}.target`, 'E_ANIMATION_3D_BINDING_MISMATCH');
  }
  if (binding.path === 'property' && binding.component === 'camera3d') {
    if (target.kind !== 'node-id' || !byId.get(target.nodeId)?.components.some(component => component.kind === 'camera3d')) {
      invalid('Camera property bindings require a node-id target with Camera3D.', `${path}.target`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    }
  }
}

function validateStateMachineReferences(machine: Native3DStateMachine, clipIds: Set<string>, bindingIds: Set<string>, path: string): void {
  const parameterNames = new Set(machine.parameters.map(parameter => parameter.name));
  const visitMotion = (motion: Native3DStateMachineMotion, motionPath: string): void => {
    if (motion.kind === 'clip') {
      if (!clipIds.has(motion.clipId)) invalid(`Motion clip "${motion.clipId}" does not exist.`, `${motionPath}.clipId`, 'E_ANIMATION_3D_BINDING_MISMATCH');
      return;
    }
    for (let index = 0; index < motion.children.length; index++) visitMotion(motion.children[index]!.motion, `${motionPath}.children[${index}].motion`);
  };
  for (let layerIndex = 0; layerIndex < machine.layers.length; layerIndex++) {
    const layer = machine.layers[layerIndex]!;
    const layerPath = `${path}.layers[${layerIndex}]`;
    const stateIds = new Set(layer.states.map(state => state.id));
    if (!stateIds.has(layer.initialStateId)) invalid(`Initial state "${layer.initialStateId}" does not exist.`, `${layerPath}.initialStateId`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    for (let stateIndex = 0; stateIndex < layer.states.length; stateIndex++) {
      const state = layer.states[stateIndex]!;
      visitMotion(state.motion, `${layerPath}.states[${stateIndex}].motion`);
      if (state.speedParameter && !parameterNames.has(state.speedParameter)) invalid(`Speed parameter "${state.speedParameter}" does not exist.`, `${layerPath}.states[${stateIndex}].speedParameter`, 'E_ANIMATION_3D_BINDING_MISMATCH');
    }
    for (let transitionIndex = 0; transitionIndex < layer.transitions.length; transitionIndex++) {
      const transition = layer.transitions[transitionIndex]!;
      const transitionPath = `${layerPath}.transitions[${transitionIndex}]`;
      if (transition.from !== '*' && !stateIds.has(transition.from)) invalid(`Transition source "${transition.from}" does not exist.`, `${transitionPath}.from`, 'E_ANIMATION_3D_BINDING_MISMATCH');
      if (!stateIds.has(transition.to)) invalid(`Transition destination "${transition.to}" does not exist.`, `${transitionPath}.to`, 'E_ANIMATION_3D_BINDING_MISMATCH');
      for (let conditionIndex = 0; conditionIndex < transition.conditions.length; conditionIndex++) {
        if (!parameterNames.has(transition.conditions[conditionIndex]!.parameter)) invalid(`Condition parameter "${transition.conditions[conditionIndex]!.parameter}" does not exist.`, `${transitionPath}.conditions[${conditionIndex}].parameter`, 'E_ANIMATION_3D_BINDING_MISMATCH');
      }
    }
    for (const [kind, values] of [['include', layer.mask?.include], ['exclude', layer.mask?.exclude]] as const) {
      for (let index = 0; index < (values?.length ?? 0); index++) {
        if (!bindingIds.has(values![index]!)) invalid(`Mask binding "${values![index]}" does not exist.`, `${layerPath}.mask.${kind}[${index}]`, 'E_ANIMATION_3D_BINDING_MISMATCH');
      }
    }
  }
}

function propertyContract(component: 'material3d' | 'camera3d', property: string, path: string): { valueType: 'scalar' | 'vec3' | 'vec4'; valueSize: 1 | 3 | 4 } {
  const material = { baseColorFactor: ['vec4', 4], metallicFactor: ['scalar', 1], roughnessFactor: ['scalar', 1], emissiveFactor: ['vec3', 3], alphaCutoff: ['scalar', 1] } as const;
  const camera = { fovYRadians: ['scalar', 1], near: ['scalar', 1], far: ['scalar', 1], orthoHeight: ['scalar', 1] } as const;
  const contract = component === 'material3d'
    ? material[property as keyof typeof material]
    : camera[property as keyof typeof camera];
  if (!contract) invalid(`Property "${property}" is not valid for ${component}.`, path, 'E_ANIMATION_3D_BINDING_MISMATCH');
  return { valueType: contract[0], valueSize: contract[1] };
}

function validateTrackQuaternions(values: readonly number[], keyCount: number, interpolation: Native3DTrack['interpolation'], path: string): void {
  const stride = interpolation === 'cubic-spline' ? 12 : 4;
  const valueOffset = interpolation === 'cubic-spline' ? 4 : 0;
  for (let index = 0; index < keyCount; index++) {
    assertNormalizedQuaternion(values.slice(index * stride + valueOffset, index * stride + valueOffset + 4) as unknown as Native3DVec4, `${path}[${index * stride + valueOffset}]`);
  }
}

function assertNormalizedQuaternion(value: Native3DVec4, path: string): void {
  const length = Math.hypot(...value);
  if (Math.abs(length - 1) > 1e-4) invalid('Quaternion must be normalized XYZW.', path, 'E_ANIMATION_3D_BINDING_MISMATCH');
}

function pickCoreLimits(options: Native3DAnimationParseOptions): AnimationParseOptions {
  const keys = ['maxInputBytes', 'maxMetadataBytes', 'maxNodes', 'maxComponents', 'maxTracks', 'maxKeyframes', 'maxResources', 'maxPathValues', 'maxTextCharacters', 'maxParticleCapacity'] as const;
  const result: Record<string, number> = {};
  for (const key of keys) if (options[key] !== undefined) result[key] = options[key]!;
  return result;
}

function resolveLimits(options: Native3DAnimationParseOptions): Limits {
  return Object.freeze({
    maxMaterials: positiveLimit(options.maxMaterials, DEFAULT_LIMITS.maxMaterials, 'maxMaterials'),
    maxNodes: positiveLimit(options.maxNodes, DEFAULT_LIMITS.maxNodes, 'maxNodes'),
    maxComponents: positiveLimit(options.maxComponents, DEFAULT_LIMITS.maxComponents, 'maxComponents'),
    maxClips: positiveLimit(options.maxClips, DEFAULT_LIMITS.maxClips, 'maxClips'),
    maxTracks: positiveLimit(options.maxTracks, DEFAULT_LIMITS.maxTracks, 'maxTracks'),
    maxKeyframes: positiveLimit(options.maxKeyframes, DEFAULT_LIMITS.maxKeyframes, 'maxKeyframes'),
    maxParticleCapacity: positiveLimit(options.maxParticleCapacity, DEFAULT_LIMITS.maxParticleCapacity, 'maxParticleCapacity'),
    maxStateMachineDepth: positiveLimit(options.maxStateMachineDepth, DEFAULT_LIMITS.maxStateMachineDepth, 'maxStateMachineDepth'),
  });
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
  return value;
}

function object(value: unknown, path: string, required: readonly string[] = [], allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object.', path);
  const result = value as Record<string, unknown>;
  for (const key of required) if (!(key in result)) invalid(`Missing required property "${key}".`, `${path}.${key}`);
  if (allowed) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(result)) if (!allowedSet.has(key)) invalid(`Unknown property "${key}".`, `${path}.${key}`, 'E_ANIMATION_3D_UNSUPPORTED_FEATURE');
  }
  return result;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid('Expected an array.', path);
  return value;
}

function nonEmptyArray(value: unknown, path: string): unknown[] {
  const result = array(value, path);
  if (result.length === 0) invalid('Expected at least one item.', path);
  return result;
}

function numericArray(value: unknown, path: string, minimumLength = 0): readonly number[] {
  const result = array(value, path);
  if (result.length < minimumLength) invalid(`Expected at least ${minimumLength} numeric value(s).`, path);
  return Object.freeze(result.map((entry, index) => finite(entry, `${path}[${index}]`)));
}

function vec2(value: unknown, path: string): Native3DVec2 {
  return tuple(value, path, 2) as Native3DVec2;
}

function vec3(value: unknown, path: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): Native3DVec3 {
  return tuple(value, path, 3, minimum, maximum) as Native3DVec3;
}

function vec4(value: unknown, path: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): Native3DVec4 {
  return tuple(value, path, 4, minimum, maximum) as Native3DVec4;
}

function tuple(value: unknown, path: string, size: number, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): readonly number[] {
  const result = array(value, path);
  if (result.length !== size) invalid(`Expected exactly ${size} numbers.`, path);
  return Object.freeze(result.map((entry, index) => bounded(entry, `${path}[${index}]`, minimum, maximum)));
}

function range(value: unknown, path: string, minimum = -Number.MAX_VALUE): Native3DScalarRange {
  if (Array.isArray(value)) {
    const result = tuple(value, path, 2, minimum) as readonly [number, number];
    if (result[0] > result[1]) invalid('Range minimum cannot exceed maximum.', path);
    return result;
  }
  return bounded(value, path, minimum);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid('Expected a finite number.', path);
  return value;
}

function positive(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result <= 0) invalid('Expected a positive number.', path);
  return result;
}

function nonNegative(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result < 0) invalid('Expected a non-negative number.', path);
  return result;
}

function bounded(value: unknown, path: string, minimum: number, maximum = Number.MAX_VALUE, inclusiveMaximum = true): number {
  const result = finite(value, path);
  if (result < minimum || (inclusiveMaximum ? result > maximum : result >= maximum)) invalid(`Expected a number in ${inclusiveMaximum ? '[' : '('}${minimum}, ${maximum}${inclusiveMaximum ? ']' : ')'}.`, path);
  return result;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`Expected a safe integer in [${minimum}, ${maximum}].`, path);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid('Expected a string.', path);
  return value;
}

function nonEmpty(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.length === 0) invalid('Expected a non-empty string.', path);
  return result;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid('Expected a boolean.', path);
  return value;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(`Expected one of ${values.join(', ')}.`, path);
  return value as T;
}

function exact(value: unknown, expected: unknown, path: string, code: ConstructorParameters<typeof Native3DAnimationFormatError>[0] = 'E_ANIMATION_3D_INVALID_PAYLOAD'): void {
  if (value !== expected) invalid(`Expected ${JSON.stringify(expected)}.`, path, code);
}

function unique(seen: Set<string>, value: string, path: string, label: string): void {
  if (seen.has(value)) invalid(`Duplicate ${label} id "${value}".`, path, 'E_ANIMATION_3D_BINDING_MISMATCH');
  seen.add(value);
}

function budget(actual: number, maximum: number, label: string, path: string): void {
  if (actual > maximum) invalid(`${label} count ${actual} exceeds limit ${maximum}.`, path, 'E_ANIMATION_3D_LIMIT_EXCEEDED');
}

function optionalStrings(item: Record<string, unknown>, path: string, keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) if (item[key] !== undefined) result[key] = nonEmpty(item[key], `${path}.${key}`);
  return result;
}

function parseJsonObject(value: unknown, path: string, depth = 0): Readonly<Record<string, unknown>> {
  if (depth > 64) budget(depth, 64, 'event payload depth', path);
  const item = object(value, path);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(item)) result[key] = parseJsonValue(child, `${path}.${key}`, depth + 1);
  return Object.freeze(result);
}

function parseJsonValue(value: unknown, path: string, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finite(value, path);
  if (Array.isArray(value)) return Object.freeze(value.map((child, index) => parseJsonValue(child, `${path}[${index}]`, depth + 1)));
  return parseJsonObject(value, path, depth);
}

function uriScheme(uri: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(uri);
  return match?.[1]?.toLowerCase() ?? null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function invalid(
  message: string,
  path: string,
  code: ConstructorParameters<typeof Native3DAnimationFormatError>[0] = 'E_ANIMATION_3D_INVALID_PAYLOAD',
): never {
  throw new Native3DAnimationFormatError(code, message, path);
}
