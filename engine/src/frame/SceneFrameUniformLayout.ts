import type { Camera3DFrameData } from './FrameData';
import type { Fog } from '../lighting/Fog';

export interface UniformAbiFieldDefinition {
  readonly name: string;
  readonly wgslType: string;
  readonly alignment: number;
  readonly size: number;
}

export interface UniformAbiFieldLayout extends UniformAbiFieldDefinition {
  readonly offset: number;
}

export interface UniformAbiLayout {
  readonly name: string;
  readonly alignment: number;
  readonly size: number;
  readonly fields: readonly UniformAbiFieldLayout[];
}

export interface SceneFrameUniformSnapshot {
  readonly frameId: number;
  readonly phaseRevision: number;
  readonly cameraEntityId: number;
  readonly data: Float32Array;
}

interface MutableSceneFrameUniformSnapshot {
  frameId: number;
  phaseRevision: number;
  cameraEntityId: number;
  readonly data: Float32Array;
}

interface SceneFrameUniformStream {
  readonly snapshots: readonly MutableSceneFrameUniformSnapshot[];
  readonly metadata: readonly SceneFrameUniformSnapshotMetadata[];
  readonly width: number;
  readonly height: number;
  readonly reverseZ: boolean;
  revision: number;
  current: MutableSceneFrameUniformSnapshot | null;
}

interface SceneFrameUniformSnapshotMetadata {
  readonly stream: SceneFrameUniformStream;
  revision: number;
}

interface SceneFrameUniformCameraCache {
  readonly streams: SceneFrameUniformStream[];
}

const FLOAT_BYTES = 4;

export const FogUniformLayout = defineUniformAbiLayout('FogUniforms', [
  { name: 'color', wgslType: 'vec4<f32>', alignment: 16, size: 16 },
  { name: 'distanceParams', wgslType: 'vec4<f32>', alignment: 16, size: 16 },
  { name: 'heightParams', wgslType: 'vec4<f32>', alignment: 16, size: 16 },
]);

export const SceneFrameUniformLayout = defineUniformAbiLayout('SceneFrameUniforms', [
  { name: 'viewProjection', wgslType: 'mat4x4<f32>', alignment: 16, size: 64 },
  { name: 'view', wgslType: 'mat4x4<f32>', alignment: 16, size: 64 },
  { name: 'inverseViewProjection', wgslType: 'mat4x4<f32>', alignment: 16, size: 64 },
  { name: 'eyePosition', wgslType: 'vec4<f32>', alignment: 16, size: 16 },
  { name: 'viewport', wgslType: 'vec4<f32>', alignment: 16, size: 16 },
  {
    name: 'fog',
    wgslType: FogUniformLayout.name,
    alignment: FogUniformLayout.alignment,
    size: FogUniformLayout.size,
  },
]);

export const FOG_UNIFORM_WGSL = generateWgslUniformStruct(FogUniformLayout);
export const SCENE_FRAME_UNIFORM_WGSL = generateWgslUniformStruct(SceneFrameUniformLayout);
export const SCENE_FRAME_UNIFORM_FLOATS = SceneFrameUniformLayout.size / FLOAT_BYTES;

const VIEW_PROJECTION_FLOAT_OFFSET = floatOffset(SceneFrameUniformLayout, 'viewProjection');
const VIEW_FLOAT_OFFSET = floatOffset(SceneFrameUniformLayout, 'view');
const INVERSE_VIEW_PROJECTION_FLOAT_OFFSET = floatOffset(SceneFrameUniformLayout, 'inverseViewProjection');
const EYE_POSITION_FLOAT_OFFSET = floatOffset(SceneFrameUniformLayout, 'eyePosition');
const VIEWPORT_FLOAT_OFFSET = floatOffset(SceneFrameUniformLayout, 'viewport');
const FOG_FLOAT_OFFSET = floatOffset(SceneFrameUniformLayout, 'fog');
const FOG_COLOR_FLOAT_OFFSET = FOG_FLOAT_OFFSET + floatOffset(FogUniformLayout, 'color');
const FOG_DISTANCE_FLOAT_OFFSET = FOG_FLOAT_OFFSET + floatOffset(FogUniformLayout, 'distanceParams');
const FOG_HEIGHT_FLOAT_OFFSET = FOG_FLOAT_OFFSET + floatOffset(FogUniformLayout, 'heightParams');
const SNAPSHOT_RING_SIZE = 3;
const snapshots = new WeakMap<Camera3DFrameData, SceneFrameUniformCameraCache>();
const snapshotMetadata = new WeakMap<SceneFrameUniformSnapshot, SceneFrameUniformSnapshotMetadata>();

export function getSceneFrameUniformSnapshot(
  cameraFrame: Camera3DFrameData,
  fog: Fog | null,
): SceneFrameUniformSnapshot {
  let cameraCache = snapshots.get(cameraFrame);
  if (!cameraCache) {
    cameraCache = { streams: [] };
    snapshots.set(cameraFrame, cameraCache);
  }
  let stream: SceneFrameUniformStream | undefined;
  for (const candidate of cameraCache.streams) {
    if (
      candidate.width === cameraFrame.width
      && candidate.height === cameraFrame.height
      && candidate.reverseZ === cameraFrame.reverseZ
    ) {
      stream = candidate;
      break;
    }
  }
  if (!stream) {
    stream = createSnapshotStream(cameraFrame.width, cameraFrame.height, cameraFrame.reverseZ);
    cameraCache.streams.push(stream);
  }
  const current = stream.current;
  if (
    current?.frameId === cameraFrame.frameId
    && current.phaseRevision === cameraFrame.phaseRevision
    && current.cameraEntityId === cameraFrame.entity.id
  ) return current;

  stream.revision = nextSnapshotRevision(stream.revision);
  const ringIndex = (stream.revision - 1) % SNAPSHOT_RING_SIZE;
  const snapshot = stream.snapshots[ringIndex]!;
  snapshot.frameId = cameraFrame.frameId;
  snapshot.phaseRevision = cameraFrame.phaseRevision;
  snapshot.cameraEntityId = cameraFrame.entity.id;
  writeSceneFrameUniforms(snapshot.data, cameraFrame, fog);
  stream.metadata[ringIndex]!.revision = stream.revision;
  stream.current = snapshot;
  return snapshot;
}

/** @internal Stable stream identity and revision used by the device-level GPU arena. */
export function getSceneFrameUniformSnapshotMetadata(snapshot: SceneFrameUniformSnapshot): Readonly<SceneFrameUniformSnapshotMetadata> | undefined {
  return snapshotMetadata.get(snapshot);
}

export function writeSceneFrameUniforms(
  out: Float32Array,
  cameraFrame: Pick<Camera3DFrameData,
    'viewProjectionMatrix' | 'viewMatrix' | 'inverseViewProjectionMatrix' | 'position' | 'width' | 'height'>,
  fog: Fog | null,
): Float32Array {
  if (out.length < SCENE_FRAME_UNIFORM_FLOATS) {
    throw new RangeError(`Scene frame uniform output requires ${SCENE_FRAME_UNIFORM_FLOATS} floats, received ${out.length}`);
  }
  const { viewProjectionMatrix, viewMatrix, inverseViewProjectionMatrix, position, width, height } = cameraFrame;
  if (viewProjectionMatrix.length < 16) throw new RangeError('Scene frame viewProjection requires 16 values');
  if (viewMatrix.length < 16) throw new RangeError('Scene frame view requires 16 values');
  if (inverseViewProjectionMatrix.length < 16) throw new RangeError('Scene frame inverseViewProjection requires 16 values');
  if (position.length < 3) throw new RangeError('Scene frame eyePosition requires 3 values');
  out.fill(0, 0, SCENE_FRAME_UNIFORM_FLOATS);
  for (let i = 0; i < 16; i++) {
    out[VIEW_PROJECTION_FLOAT_OFFSET + i] = viewProjectionMatrix[i]!;
    out[VIEW_FLOAT_OFFSET + i] = viewMatrix[i]!;
    out[INVERSE_VIEW_PROJECTION_FLOAT_OFFSET + i] = inverseViewProjectionMatrix[i]!;
  }
  out[EYE_POSITION_FLOAT_OFFSET] = position[0]!;
  out[EYE_POSITION_FLOAT_OFFSET + 1] = position[1]!;
  out[EYE_POSITION_FLOAT_OFFSET + 2] = position[2]!;
  const viewportWidth = Math.max(1, width);
  const viewportHeight = Math.max(1, height);
  out[VIEWPORT_FLOAT_OFFSET] = viewportWidth;
  out[VIEWPORT_FLOAT_OFFSET + 1] = viewportHeight;
  out[VIEWPORT_FLOAT_OFFSET + 2] = 1 / viewportWidth;
  out[VIEWPORT_FLOAT_OFFSET + 3] = 1 / viewportHeight;
  writeFogFields(out, fog);
  return out;
}

export function generateWgslUniformStruct(layout: UniformAbiLayout): string {
  const fields = layout.fields.map(field => `  ${field.name} : ${field.wgslType},`).join('\n');
  return `struct ${layout.name} {\n${fields}\n}`;
}

function defineUniformAbiLayout(name: string, definitions: readonly UniformAbiFieldDefinition[]): UniformAbiLayout {
  let offset = 0;
  let structAlignment = 1;
  const fields = definitions.map(definition => {
    validatePowerOfTwo(definition.alignment, `${name}.${definition.name} alignment`);
    if (!Number.isInteger(definition.size) || definition.size < 1) {
      throw new Error(`${name}.${definition.name} size must be a positive integer`);
    }
    offset = alignTo(offset, definition.alignment);
    structAlignment = Math.max(structAlignment, definition.alignment);
    const field = Object.freeze({ ...definition, offset });
    offset += definition.size;
    return field;
  });
  return Object.freeze({
    name,
    alignment: structAlignment,
    size: alignTo(offset, structAlignment),
    fields: Object.freeze(fields),
  });
}

function writeFogFields(out: Float32Array, fog: Fog | null): void {
  if (!fog || fog.disabled) return;
  fog.color.writeSRGB(out, FOG_COLOR_FLOAT_OFFSET);
  out[FOG_DISTANCE_FLOAT_OFFSET] = fog.mode === 'distance' ? 1 : 2;
  out[FOG_DISTANCE_FLOAT_OFFSET + 1] = fog.distanceStart;
  out[FOG_DISTANCE_FLOAT_OFFSET + 2] = Math.max(fog.distanceEnd, fog.distanceStart + 0.0001);
  out[FOG_DISTANCE_FLOAT_OFFSET + 3] = fog.maxOpacity;
  out[FOG_HEIGHT_FLOAT_OFFSET] = fog.baseHeight;
  out[FOG_HEIGHT_FLOAT_OFFSET + 1] = fog.density;
  out[FOG_HEIGHT_FLOAT_OFFSET + 2] = fog.heightFalloff;
}

function floatOffset(layout: UniformAbiLayout, fieldName: string): number {
  const field = layout.fields.find(candidate => candidate.name === fieldName);
  if (!field) throw new Error(`Unknown ${layout.name} field: ${fieldName}`);
  if (field.offset % FLOAT_BYTES !== 0) throw new Error(`${layout.name}.${fieldName} is not float aligned`);
  return field.offset / FLOAT_BYTES;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function validatePowerOfTwo(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || (value & (value - 1)) !== 0) {
    throw new Error(`${label} must be a positive power of two`);
  }
}

function createSnapshotStream(width: number, height: number, reverseZ: boolean): SceneFrameUniformStream {
  const mutableSnapshots: MutableSceneFrameUniformSnapshot[] = [];
  const metadata: SceneFrameUniformSnapshotMetadata[] = [];
  const stream = {
    snapshots: mutableSnapshots,
    metadata,
    width,
    height,
    reverseZ,
    revision: 0,
    current: null,
  } satisfies SceneFrameUniformStream;
  for (let i = 0; i < SNAPSHOT_RING_SIZE; i++) {
    const snapshot: MutableSceneFrameUniformSnapshot = {
      frameId: 0,
      phaseRevision: 0,
      cameraEntityId: 0,
      data: new Float32Array(SCENE_FRAME_UNIFORM_FLOATS),
    };
    const entry = { stream, revision: 0 };
    mutableSnapshots.push(snapshot);
    metadata.push(entry);
    snapshotMetadata.set(snapshot, entry);
  }
  return stream;
}

function nextSnapshotRevision(revision: number): number {
  return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
}
