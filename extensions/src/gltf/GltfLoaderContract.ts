import type { AssetHandle, AssetManager } from '@haiyue/engine/assets';
import type { Entity, Geometry3D } from '@haiyue/engine';
import type { Transform3D } from '@haiyue/engine/components';
import {
  isGltfAsset,
  isRecord,
  type GltfAnimationInterpolation,
  type GltfAsset,
} from './GltfSchema';
import {
  DEFAULT_GLTF_EXTENSION_ADAPTERS,
  createGltfExtensionCapabilities,
  type GltfExtensionAdapter,
  type GltfExtensionCapability,
} from './GltfExtensionAdapter';
import type {
  GltfCompatibilityExtensionEntry,
  GltfCompatibilityReport,
  GltfPrimitiveCompatibilityInput,
} from './GltfCompatibilityReport';

export type {
  GltfCompatibilityExtensionEntry,
  GltfCompatibilityIssue,
  GltfCompatibilityPerformanceSummary,
  GltfCompatibilityReport,
  GltfCompatibilityStatus,
  GltfPrimitiveBoundsCompatibilityEntry,
  GltfPrimitiveBoundsSupport,
  GltfPrimitiveUvSemanticCompatibilityEntry,
  GltfTextureCompatibilityEntry,
  GltfTextureMipmapSource,
} from './GltfCompatibilityReport';
export type { GltfAnimationInterpolation } from './GltfSchema';
export type {
  GltfExtensionAdapter,
  GltfExtensionCapability,
  GltfExtensionSupport,
} from './GltfExtensionAdapter';

export interface LoadedGltfModel {
  root: Entity;
  animations: GltfAnimationInfo[];
  animationClips: GltfAnimationClip[];
  assetStats: GltfAssetStats;
  loadMetrics: GltfLoadMetrics;
  objectUrls: string[];
  assetHandles: AssetHandle<unknown>[];
  materialVariants: readonly string[];
  warnings: readonly GltfLoadWarning[];
  extensionReport: GltfExtensionReport;
  compatibilityReport: GltfCompatibilityReport;
}

export type GltfExtensionReportEntry = GltfCompatibilityExtensionEntry;

export interface GltfExtensionReport {
  readonly fullySupported: boolean;
  readonly entries: readonly GltfExtensionReportEntry[];
}

export const GLTF_EXTENSION_CAPABILITIES: Readonly<Record<string, GltfExtensionCapability>> =
  createGltfExtensionCapabilities(DEFAULT_GLTF_EXTENSION_ADAPTERS);

export interface GltfLoadWarning {
  readonly code: 'W_GLTF_PARTIAL_OPTIONAL_EXTENSION' | 'W_GLTF_UNSUPPORTED_OPTIONAL_EXTENSION';
  readonly message: string;
  readonly extension: string;
  readonly path: string;
}

export interface GltfAnimationInfo {
  name: string;
  duration: number;
  channelCount: number;
}

export type GltfAnimationPath = 'translation' | 'rotation' | 'scale' | 'weights';

export interface GltfAnimationTarget {
  entity: Entity;
  transform: Transform3D;
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  weights: number[];
  morphPrimitives: GltfMorphPrimitiveRuntime[];
}

export interface GltfMorphPrimitiveRuntime {
  geometry: Geometry3D;
  basePositions: Float32Array;
  baseNormals: Float32Array | null;
  positionTargets: Float32Array[];
  normalTargets: Float32Array[];
}

export interface GltfAnimationChannelRuntime {
  target: GltfAnimationTarget;
  path: GltfAnimationPath;
  interpolation: GltfAnimationInterpolation;
  valueSize: number;
  input: Float32Array;
  output: Float32Array;
  sampleA: Float32Array;
  sampleB: Float32Array;
  sampleOut: Float32Array;
  quatScratch: Float32Array;
}

export interface GltfAnimationClip {
  name: string;
  duration: number;
  channels: GltfAnimationChannelRuntime[];
  skinnedPrimitives: GltfSkinnedPrimitiveRuntime[];
  stateCache: Map<GltfAnimationTarget, GltfAnimationTargetState>;
  activeStates: GltfAnimationTargetState[];
}

export interface GltfAnimationTargetState {
  target: GltfAnimationTarget;
  translation: Float32Array;
  rotation: Float32Array;
  scale: Float32Array;
  matrix: Float32Array<ArrayBuffer>;
  active: boolean;
}

export interface GltfAssetStats {
  meshCount: number;
  primitiveCount: number;
  materialCount: number;
  textureCount: number;
  imageCount: number;
  animationCount: number;
}

export interface GltfLoadPhaseTimings {
  readonly fetchMs: number;
  readonly workerParseMs: number;
  readonly dracoDecodeMs: number;
  readonly geometryPreparationMs: number;
  readonly instantiateMs: number;
  readonly textureDecodeTranscodeUploadMs: number;
  readonly totalMs: number;
}

export interface GltfLoadMetrics {
  readonly timings: GltfLoadPhaseTimings;
  readonly sourceBytes: number;
  readonly decodedGeometryBytes: number;
  readonly workerTransferBytes: number;
  readonly workerTransferBufferCount: number;
}

export interface GltfLoadDiagnostics {
  onDracoDecode?(durationMs: number, decodedBytes: number): void;
}

export interface LoadGltfOptions {
  scene?: number | null;
  baseColorFactor?: [number, number, number, number];
  dracoDecoder?: DracoDecoderModule | Promise<DracoDecoderModule> | DracoDecoderFactory | null;
  dracoDecoderConfig?: DracoDecoderConfig;
  assetManager?: AssetManager | null;
  assetWorker?: GltfAssetWorker | null;
  signal?: AbortSignal;
  onWarning?: (warning: GltfLoadWarning) => void;
  diagnostics?: GltfLoadDiagnostics;
  extensionAdapters?: readonly GltfExtensionAdapter[];
}

export interface GltfAssetWorker {
  loadParsedAsset(src: string, options?: { signal?: AbortSignal; dracoDecoderConfig?: DracoDecoderConfig }): Promise<GltfParsedAsset>;
}

export interface GltfParsedAsset {
  gltf: GltfAsset;
  binaryChunk: ArrayBuffer | null;
  buffers: ArrayBuffer[];
  baseUrl: string;
  geometryPayloads?: GltfGeometryPayloadMatrix;
  metrics?: GltfParsedAssetMetrics;
}

export interface GltfParsedAssetMetrics {
  readonly fetchMs: number;
  readonly parseMs: number;
  readonly workerParseMs: number;
  readonly dracoDecodeMs: number;
  readonly geometryPreparationMs: number;
  readonly sourceBytes: number;
  readonly workerTransferBytes: number;
  readonly workerTransferBufferCount: number;
}

export function isGltfParsedAsset(value: unknown): value is GltfParsedAsset {
  if (!isRecord(value)) return false;
  if (!isGltfAsset(value.gltf)) return false;
  if (!(value.binaryChunk === null || value.binaryChunk instanceof ArrayBuffer)) return false;
  if (!Array.isArray(value.buffers) || !value.buffers.every(buffer => buffer instanceof ArrayBuffer)) return false;
  if (typeof value.baseUrl !== 'string') return false;
  if (value.geometryPayloads !== undefined && !isGeometryPayloadMatrix(value.geometryPayloads)) return false;
  return value.metrics === undefined || isParsedAssetMetrics(value.metrics);
}

export type GltfGeometryPayloadMatrix = Array<Array<GltfPrimitiveGeometryPayload | null>>;

export interface GltfPrimitiveGeometryPayload {
  positions: Float32Array;
  indices?: Uint16Array | Uint32Array;
  normals?: Float32Array;
  textureCoordinates: Array<{ set: number; data: Float32Array }>;
  joints?: Uint16Array | Uint32Array;
  weights?: Float32Array;
  positionTargets: Float32Array[];
  normalTargets: Float32Array[];
}

export interface DracoDecoderConfig {
  scriptUrl?: string;
  locateFile?: (path: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer | Uint8Array;
}

export interface DracoDecoderArray {
  GetValue(index: number): number;
  size(): number;
}

export interface DracoPointAttribute { size(): number; }
export interface DracoStatus { ok(): boolean; error_msg(): string; }
export interface DracoMesh { num_faces(): number; num_points(): number; }

export interface DracoDecoder {
  DecodeBufferToMesh(buffer: unknown, mesh: DracoMesh): DracoStatus;
  GetAttributeByUniqueId(mesh: DracoMesh, uniqueId: number): DracoPointAttribute;
  GetAttributeFloatForAllPoints(mesh: DracoMesh, attribute: DracoPointAttribute, out: DracoDecoderArray): boolean;
  GetAttributeUInt16ForAllPoints?(mesh: DracoMesh, attribute: DracoPointAttribute, out: DracoDecoderArray): boolean;
  GetAttributeUInt32ForAllPoints?(mesh: DracoMesh, attribute: DracoPointAttribute, out: DracoDecoderArray): boolean;
  GetFaceFromMesh(mesh: DracoMesh, faceIndex: number, out: DracoDecoderArray): boolean;
}

export interface DracoDecoderModule {
  Decoder: new () => DracoDecoder;
  DecoderBuffer: new () => { Init(data: Uint8Array, byteLength: number): void };
  Mesh: new () => DracoMesh;
  DracoFloat32Array: new () => DracoDecoderArray;
  DracoUInt16Array?: new () => DracoDecoderArray;
  DracoUInt32Array?: new () => DracoDecoderArray;
  DracoInt32Array: new () => DracoDecoderArray;
  destroy(object: unknown): void;
}

export type DracoDecoderFactory = (config?: DracoDecoderConfig) => Promise<DracoDecoderModule> | DracoDecoderModule;

export interface DracoPrimitiveGeometry {
  positions: Float32Array;
  normals?: Float32Array;
  textureCoordinates: Array<{ set: number; data: Float32Array }>;
  joints?: Uint16Array | Uint32Array;
  weights?: Float32Array;
  indices: Uint16Array | Uint32Array;
}

export interface GltfLoadContext {
  baseUrl: string;
  assetIdentity: string;
  objectUrls: string[];
  imageSources: Map<number, string>;
  sharedImageSources: boolean;
  preloadedTextures: Map<string, GPUTexture>;
  animationTargets: Map<number, GltfAnimationTarget>;
  skinnedPrimitives: GltfSkinnedPrimitiveRuntime[];
  pendingSkinnedPrimitives: GltfPendingSkinnedPrimitive[];
  assetHandles: AssetHandle<unknown>[];
  geometryPayloads?: GltfGeometryPayloadMatrix;
  compatibilityPrimitives: GltfPrimitiveCompatibilityInput[];
  extensionAdapters: readonly GltfExtensionAdapter[];
}

export interface GltfPendingSkinnedPrimitive {
  skinIndex: number;
  geometry: Geometry3D;
  meshEntity: Entity;
  joints: Uint16Array | Uint32Array;
  weights: Float32Array;
}

export interface GltfSkinnedPrimitiveRuntime {
  geometry: Geometry3D;
  meshEntity: Entity;
  jointTargets: Array<GltfAnimationTarget | null>;
  inverseBindMatrices: Float32Array[];
  jointMatrices: Float32Array;
  inverseMeshWorldScratch: Float32Array;
  jointMatrixScratch: Float32Array;
  skinMatrixScratch: Float32Array;
  lastMeshWorldVersion: number;
  lastGeometryVersion: number;
  lastJointWorldVersions: Int32Array;
}

function isGeometryPayloadMatrix(value: unknown): value is GltfGeometryPayloadMatrix {
  return Array.isArray(value) && value.every(mesh => Array.isArray(mesh) && mesh.every(payload => {
    if (payload === null) return true;
    if (!isRecord(payload) || !(payload.positions instanceof Float32Array)) return false;
    if (payload.indices !== undefined && !(payload.indices instanceof Uint16Array) && !(payload.indices instanceof Uint32Array)) return false;
    if (payload.normals !== undefined && !(payload.normals instanceof Float32Array)) return false;
    if (!Array.isArray(payload.textureCoordinates)
      || !payload.textureCoordinates.every(entry => isRecord(entry)
        && typeof entry.set === 'number'
        && Number.isInteger(entry.set)
        && entry.set >= 0
        && entry.data instanceof Float32Array)) return false;
    if (!Array.isArray(payload.positionTargets) || !payload.positionTargets.every(target => target instanceof Float32Array)) return false;
    return Array.isArray(payload.normalTargets) && payload.normalTargets.every(target => target instanceof Float32Array);
  }));
}

function isParsedAssetMetrics(value: unknown): value is GltfParsedAssetMetrics {
  if (!isRecord(value)) return false;
  return [
    'fetchMs',
    'parseMs',
    'workerParseMs',
    'dracoDecodeMs',
    'geometryPreparationMs',
    'sourceBytes',
    'workerTransferBytes',
    'workerTransferBufferCount',
  ].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
}
