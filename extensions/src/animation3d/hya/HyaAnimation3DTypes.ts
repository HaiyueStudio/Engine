import type { Scene } from '@haiyue/engine';
import type { ParticleEmitter3DOptions } from '@haiyue/engine/components';
import type { PbrMaterial } from '@haiyue/engine/material';
import type { LoadedGltfModel, LoadGltfOptions } from '../../gltf/GltfLoaderContract';
import type { Animation3DActionOptions } from '../Animation3DAction';
import type { Animation3DBinding } from '../Animation3DBinding';
import type { Animation3DEvent } from '../Animation3DClip';
import type { Animation3DStateMachineDefinition } from '../Animation3DStateMachine';

export interface HyaAnimation3DResource {
  readonly id: string;
  readonly type: 'image' | 'audio' | 'binary';
  readonly uri: string;
  readonly mimeType?: string;
  readonly integrity?: string;
}

export interface HyaAnimation3DMaterialDescriptor {
  readonly id: string;
  readonly name: string;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly emissiveFactor: readonly [number, number, number];
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly alphaCutoff?: number;
  readonly doubleSided: boolean;
  readonly baseColorTexture?: string;
  readonly normalTexture?: string;
  readonly metallicRoughnessTexture?: string;
  readonly emissiveTexture?: string;
}

export interface HyaAnimation3DTransformDescriptor {
  readonly translation: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

export type HyaAnimation3DCameraProjection =
  | Readonly<{ kind: 'perspective'; fovYRadians: number; near: number; far: number }>
  | Readonly<{ kind: 'orthographic'; orthoHeight: number; near: number; far: number }>;

export type HyaAnimation3DComponentDescriptor =
  | Readonly<{ id: string; kind: 'camera3d'; projection: HyaAnimation3DCameraProjection }>
  | Readonly<{
      id: string;
      kind: 'primitive3d';
      primitive: 'box' | 'sphere' | 'plane' | 'cylinder' | 'cone';
      materialId: string;
    }>
  | Readonly<{
      id: string;
      kind: 'model3d';
      resource: string;
      materialOverrides?: readonly Readonly<{ slot: string; materialId: string }>[];
    }>
  | Readonly<{ id: string; kind: 'particle3d'; descriptor: ParticleEmitter3DOptions & Readonly<{ textureResource?: string }> }>;

export interface HyaAnimation3DNodeDescriptor {
  readonly id: string;
  readonly name: string;
  readonly parent?: string;
  readonly start?: number;
  readonly duration?: number;
  readonly transform: HyaAnimation3DTransformDescriptor;
  readonly components: readonly HyaAnimation3DComponentDescriptor[];
}

export interface HyaAnimation3DClipDescriptor {
  readonly format: 'haiyue-animation3d-clip@1';
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly Readonly<{
    id: string;
    binding: Animation3DBinding;
    interpolation: 'step' | 'linear' | 'cubic-spline';
    times: ArrayLike<number>;
    values: ArrayLike<number>;
  }>[];
  readonly events: readonly Animation3DEvent[];
}

/** Runtime port implemented by the validated animation-spec payload. */
export interface HyaAnimation3DPayload {
  readonly format: 'haiyue-animation-3d@1';
  readonly mode: 'native-3d';
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly materials: readonly HyaAnimation3DMaterialDescriptor[];
  readonly nodes: readonly HyaAnimation3DNodeDescriptor[];
  readonly clips: readonly HyaAnimation3DClipDescriptor[];
  readonly stateMachine?: Animation3DStateMachineDefinition | null;
}

export interface HyaAnimation3DRuntimeOptions {
  readonly scene: Scene;
  /** Payload returned by animation-spec native3d validation. */
  readonly payload: HyaAnimation3DPayload;
  readonly resources: readonly HyaAnimation3DResource[];
  readonly signal?: AbortSignal;
  readonly useAuthoredCamera?: boolean;
  readonly addPreviewLights?: boolean;
  readonly loadModel?: (uri: string, options: LoadGltfOptions) => Promise<LoadedGltfModel>;
  readonly disposeModel?: (model: LoadedGltfModel) => void;
  readonly resolveTexture?: (
    resource: HyaAnimation3DResource,
    material: PbrMaterial | null,
  ) => ParticleEmitter3DOptions['textureSource'] | null;
}

export interface HyaAnimation3DPlayOptions extends Animation3DActionOptions {
  readonly fadeFrom?: HyaAnimation3DActionGroup;
  readonly fadeDuration?: number;
  readonly warp?: boolean;
}

export interface HyaAnimation3DActionGroup {
  readonly id: string;
  readonly clipId: string;
  readonly actionCount: number;
  readonly playing: boolean;
  play(): this;
  stop(): this;
  reset(): this;
}

export interface HyaAnimation3DRuntimeDiagnostics {
  readonly state: 'active' | 'destroyed';
  readonly entityCount: number;
  readonly materialCount: number;
  readonly modelCount: number;
  readonly actionGroupCount: number;
  readonly ownerResidualCount: number;
}

export interface HyaAnimation3DStateMachineLayerSnapshot {
  readonly layerId: string;
  readonly currentStateId: string;
  readonly currentTime: number;
  readonly transitionId: string | null;
  readonly sourceStateId: string | null;
  readonly destinationStateId: string | null;
  readonly transitionProgress: number;
}

/** Stable parameter/query port for the runtime's unique state-machine clock. */
export interface HyaAnimation3DStateMachineController {
  readonly status: 'active' | 'destroyed';
  readonly layerSnapshots: readonly HyaAnimation3DStateMachineLayerSnapshot[];
  getLayerSnapshot(layerId: string): HyaAnimation3DStateMachineLayerSnapshot;
  setFloat(name: string, value: number): this;
  setInteger(name: string, value: number): this;
  setBoolean(name: string, value: boolean): this;
  setTrigger(name: string): this;
  resetTrigger(name: string): this;
  getParameter(name: string): number | boolean;
}

/** Stable lifecycle and diagnostic view of the HYA state-machine owner. */
export interface HyaAnimation3DStateMachineRuntimeControl {
  readonly controller: HyaAnimation3DStateMachineController;
  readonly time: number;
  readonly liveActionCount: number;
  readonly liveBindingCount: number;
  readonly sideEffectOwnerCount: number;
  reset(): void;
}
