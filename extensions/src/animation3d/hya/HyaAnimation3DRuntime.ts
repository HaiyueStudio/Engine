import {
  Camera3D,
  Component,
  Entity,
  Mesh3D,
  type Scene,
} from '@haiyue/engine';
import { MeshHelper, ParticleEmitter3D, Transform3D } from '@haiyue/engine/components';
import {
  createBox3D,
  createCone3D,
  createCylinder3D,
  createPlane3D,
  createSphere3D,
  type Geometry3D,
} from '@haiyue/engine/geometry';
import { AmbientLight, DirectionalLight } from '@haiyue/engine/lighting';
import { PbrMaterial } from '@haiyue/engine/material';
import { disposeGltfModel, loadGltfModel } from '../../gltf/gltfLoader';
import type { LoadedGltfModel } from '../../gltf/GltfLoaderContract';
import { GltfAnimation3DRuntime } from '../../gltf/GltfAnimation3DAdapter';
import { composeTrsMatrix } from '../../gltf/GltfAnimationRuntime';
import type {
  Animation3DBinding,
  Animation3DBindingResolver,
  Animation3DResolvedBinding,
} from '../Animation3DBinding';
import type { Animation3DAction } from '../Animation3DAction';
import type { Animation3DClip } from '../Animation3DClip';
import { Animation3DMixer } from '../Animation3DMixer';
import { Animation3DPoseApplier } from '../Animation3DPose';
import { Animation3DPoseBuffer } from '../Animation3DPoseBuffer';
import type { Animation3DTrack } from '../Animation3DTrack';
import { animation3DMixerRuntime } from '../runtime/mixer/Animation3DMixerRuntimeStore';
import {
  HyaAnimation3DStateMachineRuntime,
  type HyaAnimation3DParticleCue,
  type HyaAnimation3DStateMachinePartition,
} from './HyaAnimation3DStateMachineRuntime';
import type {
  HyaAnimation3DActionGroup,
  HyaAnimation3DCameraProjection,
  HyaAnimation3DComponentDescriptor,
  HyaAnimation3DMaterialDescriptor,
  HyaAnimation3DNodeDescriptor,
  HyaAnimation3DPayload,
  HyaAnimation3DPlayOptions,
  HyaAnimation3DResource,
  HyaAnimation3DRuntimeDiagnostics,
  HyaAnimation3DRuntimeOptions,
  HyaAnimation3DStateMachineRuntimeControl,
} from './HyaAnimation3DTypes';

type RuntimeState = 'active' | 'destroyed';

interface TransformState {
  readonly transform: Transform3D;
  readonly translation: Float32Array;
  readonly rotation: Float32Array;
  readonly scale: Float32Array;
  readonly matrix: Float32Array;
}

interface ModelState {
  readonly nodeId: string;
  readonly componentId: string;
  readonly model: LoadedGltfModel;
  readonly runtime: GltfAnimation3DRuntime;
}

interface ActionEntry {
  readonly owner: Animation3DMixer;
  readonly action: Animation3DAction;
}

interface ParticleState {
  readonly key: string;
  readonly node: HyaAnimation3DNodeDescriptor;
  readonly componentId: string;
  readonly emitter: ParticleEmitter3D;
}

class HyaAnimation3DResolvedEndpoint implements Animation3DResolvedBinding {
  constructor(
    readonly binding: Animation3DBinding,
    private readonly _read: (out: Float32Array) => void,
    private readonly _write: (value: ArrayLike<number>) => void,
  ) {}

  read(out: Float32Array): void { this._read(out); }
  write(value: ArrayLike<number>): void { this._write(value); }
}

class HyaAnimation3DBindingResolver implements Animation3DBindingResolver {
  private readonly _endpoints = new Map<string, HyaAnimation3DResolvedEndpoint>();
  private _revision = 0;
  private _destroyed = false;

  get revision(): number { return this._revision; }
  get size(): number { return this._endpoints.size; }

  add(endpoint: HyaAnimation3DResolvedEndpoint): void {
    if (this._destroyed) throw new Error('HYA Animation3D resolver is destroyed.');
    this._endpoints.set(endpoint.binding.id, endpoint);
    this._revision++;
  }

  resolve<TBinding extends Animation3DBinding>(binding: TBinding): Animation3DResolvedBinding<TBinding> | null {
    if (this._destroyed) return null;
    const endpoint = this._endpoints.get(binding.id);
    if (!endpoint || endpoint.binding.path !== binding.path
      || endpoint.binding.valueType !== binding.valueType
      || endpoint.binding.valueSize !== binding.valueSize) return null;
    return endpoint as unknown as Animation3DResolvedBinding<TBinding>;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._endpoints.clear();
    this._revision++;
  }
}

class HyaAnimation3DRuntimeOwner extends Component {
  private _runtime: HyaAnimation3DRuntime | null = null;

  constructor() { super('HyaAnimation3DRuntimeOwner'); }
  attach(runtime: HyaAnimation3DRuntime): void { this._runtime = runtime; }
  release(runtime: HyaAnimation3DRuntime): void { if (this._runtime === runtime) this._runtime = null; }
  override clone(): HyaAnimation3DRuntimeOwner { return new HyaAnimation3DRuntimeOwner(); }
  override destroy(): void {
    if (this.destroyed) return;
    const runtime = this._runtime;
    this._runtime = null;
    runtime?.destroy();
    super.destroy();
  }
}

class HyaAnimation3DActionGroupImpl implements HyaAnimation3DActionGroup {
  constructor(
    readonly id: string,
    readonly clipId: string,
    readonly entries: readonly ActionEntry[],
  ) {}

  get actionCount(): number { return this.entries.length; }
  get playing(): boolean {
    return this.entries.some(entry => entry.owner.state === 'active'
      && (entry.action.status === 'running' || entry.action.status === 'scheduled'));
  }
  play(): this { for (const entry of this.entries) if (entry.owner.state === 'active') entry.action.play(); return this; }
  stop(): this { for (const entry of this.entries) if (entry.owner.state === 'active') entry.action.stop(); return this; }
  reset(): this { for (const entry of this.entries) if (entry.owner.state === 'active') entry.action.reset(); return this; }
}

/**
 * Optional native-3D HYA owner. The caller must pass an already validated
 * animation-spec payload; no ECS/GPU object is allocated by the parser.
 */
export class HyaAnimation3DRuntime {
  readonly root = new Entity('HYA Native 3D');
  readonly mixer: Animation3DMixer;
  readonly pose = new Animation3DPoseBuffer();

  private readonly _scene: Scene;
  private readonly _payload: HyaAnimation3DPayload;
  private readonly _clips: readonly Animation3DClip[];
  private readonly _resources: Map<string, HyaAnimation3DResource>;
  private readonly _entities = new Map<string, Entity>();
  private readonly _transforms = new Map<string, TransformState>();
  private readonly _materials = new Map<string, PbrMaterial>();
  private readonly _cameras = new Map<string, Camera3D>();
  private readonly _models: ModelState[] = [];
  private readonly _mainClips = new Map<string, Animation3DClip>();
  private readonly _modelClips = new Map<string, Map<ModelState, Animation3DClip>>();
  private readonly _modelBindingIds = new Map<ModelState, Map<string, string>>();
  private readonly _actionGroups = new Map<string, HyaAnimation3DActionGroupImpl>();
  private readonly _resolver = new HyaAnimation3DBindingResolver();
  private readonly _poseApplier: Animation3DPoseApplier;
  private readonly _owner = new HyaAnimation3DRuntimeOwner();
  private readonly _geometries = new Set<Geometry3D>();
  private readonly _particles: ParticleState[] = [];
  private readonly _abortController = new AbortController();
  private readonly _externalSignal: AbortSignal | null;
  private readonly _externalAbortListener: (() => void) | null;
  private readonly _disposeModel: (model: LoadedGltfModel) => void;
  private _state: RuntimeState = 'active';
  private _initialized = false;
  private _stateMachine: HyaAnimation3DStateMachineRuntime | null = null;

  private constructor(options: HyaAnimation3DRuntimeOptions) {
    this._scene = options.scene;
    this._payload = options.payload;
    this._clips = Object.freeze(options.payload.clips.map(lowerRuntimeClip));
    this._resources = new Map(options.resources.map(resource => [resource.id, resource]));
    this._disposeModel = options.disposeModel ?? disposeGltfModel;
    this.mixer = new Animation3DMixer(this._resolver);
    this._poseApplier = new Animation3DPoseApplier(this._resolver);
    this._owner.attach(this);
    this.root.addComponent(this._owner);
    this._externalSignal = options.signal ?? null;
    this._externalAbortListener = this._externalSignal ? () => this.destroy() : null;
    this._externalSignal?.addEventListener('abort', this._externalAbortListener!, { once: true });
  }

  static async create(options: HyaAnimation3DRuntimeOptions): Promise<HyaAnimation3DRuntime> {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    const runtime = new HyaAnimation3DRuntime(options);
    try {
      await runtime._initialize(options);
      return runtime;
    } catch (error) {
      runtime.destroy();
      throw error;
    }
  }

  get state(): RuntimeState { return this._state; }
  get initialized(): boolean { return this._initialized; }
  get clips(): readonly Animation3DClip[] { return this._clips; }
  get authoredCameraIds(): readonly string[] { return Object.freeze([...this._cameras.keys()]); }
  get stateMachine(): HyaAnimation3DStateMachineRuntimeControl | null { return this._stateMachine; }

  getEntity(nodeId: string): Entity | null { return this._entities.get(nodeId) ?? null; }
  getMaterial(materialId: string): PbrMaterial | null { return this._materials.get(materialId) ?? null; }
  getModelAnimationClips(nodeId: string): readonly Animation3DClip[] {
    return this._models.find(model => model.nodeId === nodeId)?.runtime.clips ?? Object.freeze([]);
  }

  select(nodeIds: readonly string[]): void {
    const selected = new Set(nodeIds);
    for (const [id, entity] of this._entities) {
      if (selected.has(id)) entity.addComponent(new MeshHelper({ mode: 'aabb', color: [0.25, 0.75, 1, 1], lineWidth: 1.5 }));
      else entity.removeComponent(MeshHelper);
    }
  }

  useAuthoredCamera(nodeId: string): void {
    this._assertActive();
    const entity = this._entities.get(nodeId);
    if (!entity || !this._cameras.has(nodeId)) throw new RangeError(`Unknown authored camera node "${nodeId}".`);
    this._scene.setCamera(entity);
  }

  playClip(clipId: string, options: HyaAnimation3DPlayOptions = {}): HyaAnimation3DActionGroup {
    this._assertActive();
    if (this._stateMachine) {
      throw new Error('Manual HYA Animation3D clip actions are unavailable while the built-in state machine owns the mixers.');
    }
    const base = this._clips.find(clip => clip.id === clipId);
    if (!base) throw new RangeError(`Unknown HYA Animation3D clip "${clipId}".`);
    const groupId = options.id ?? `${clipId}:action:${this._actionGroups.size}`;
    if (this._actionGroups.has(groupId)) throw new RangeError(`HYA Animation3D action group "${groupId}" already exists.`);
    const entries: ActionEntry[] = [];
    const actionOptions = withoutGroupOptions(options);
    const main = this._mainClips.get(clipId);
    if (main) entries.push({ owner: this.mixer, action: this.mixer.createAction(main, { ...actionOptions, id: `${groupId}:scene` }) });
    for (const [model, clip] of this._modelClips.get(clipId) ?? []) {
      entries.push({ owner: model.runtime.mixer, action: model.runtime.mixer.createAction(clip, { ...actionOptions, id: `${groupId}:${model.componentId}` }) });
    }
    const group = new HyaAnimation3DActionGroupImpl(groupId, clipId, entries);
    if (options.fadeFrom) {
      const source = options.fadeFrom as HyaAnimation3DActionGroupImpl;
      const duration = options.fadeDuration ?? 0;
      for (const entry of entries) {
        const sourceEntry = source.entries.find(candidate => candidate.owner === entry.owner);
        if (sourceEntry) entry.action.crossFadeFrom(sourceEntry.action, duration, options.warp ?? false);
        else entry.action.fadeIn(duration).play();
      }
    } else group.play();
    this._actionGroups.set(groupId, group);
    return group;
  }

  removeActionGroup(group: HyaAnimation3DActionGroup | string): boolean {
    const id = typeof group === 'string' ? group : group.id;
    const target = this._actionGroups.get(id);
    if (!target) return false;
    for (const entry of target.entries) {
      if (entry.owner.state !== 'active') continue;
      entry.action.stop();
      entry.owner.removeAction(entry.action);
    }
    this._actionGroups.delete(id);
    return true;
  }

  update(deltaSeconds: number): void {
    this._assertActive();
    if (this._stateMachine) {
      this._stateMachine.update(deltaSeconds);
      return;
    }
    this._poseApplier.apply(this.mixer.update(deltaSeconds, this.pose));
    for (const model of this._models) model.runtime.update(deltaSeconds);
  }

  setTime(timeSeconds: number): void {
    this._assertActive();
    if (this._stateMachine) {
      throw new Error('HYA Animation3D setTime() is unavailable while the built-in state machine owns the playhead.');
    }
    this._poseApplier.apply(this.mixer.setTime(timeSeconds, this.pose));
    for (const model of this._models) model.runtime.setTime(timeSeconds);
  }

  diagnostics(): HyaAnimation3DRuntimeDiagnostics {
    const residual = this._state === 'destroyed'
      ? this._entities.size + this._materials.size + this._models.length + this._actionGroups.size + this._resolver.size
      : 0;
    return Object.freeze({
      state: this._state,
      entityCount: this._entities.size,
      materialCount: this._materials.size,
      modelCount: this._models.length,
      actionGroupCount: this._actionGroups.size,
      ownerResidualCount: residual,
    });
  }

  destroy(): void {
    if (this._state === 'destroyed') return;
    this._state = 'destroyed';
    if (this._externalSignal && this._externalAbortListener) this._externalSignal.removeEventListener('abort', this._externalAbortListener);
    this._stateMachine?.destroy();
    this._stateMachine = null;
    for (const id of [...this._actionGroups.keys()]) this.removeActionGroup(id);
    this._abortController.abort('hya-animation3d-runtime-destroyed');
    this.mixer.destroy();
    this._resolver.destroy();
    for (const model of this._models.splice(0)) {
      model.runtime.destroy();
      if (!model.model.root.destroyed) this._disposeModel(model.model);
    }
    this._owner.release(this);
    if (!this.root.destroyed) this.root.destroy();
    this._entities.clear();
    this._transforms.clear();
    this._materials.clear();
    this._cameras.clear();
    this._mainClips.clear();
    this._modelClips.clear();
    this._modelBindingIds.clear();
    this._particles.length = 0;
    this._geometries.clear();
  }

  private async _initialize(options: HyaAnimation3DRuntimeOptions): Promise<void> {
    this._createMaterials();
    this._createNodes(options);
    this._attachHierarchy();
    this._scene.add(this.root);
    if (options.addPreviewLights !== false) this._addPreviewLights();
    await this._loadModels(options);
    this._buildClipPartitions();
    this._createStateMachineRuntime();
    const authoredCamera = this._cameras.keys().next().value as string | undefined;
    if (options.useAuthoredCamera !== false && authoredCamera) this.useAuthoredCamera(authoredCamera);
    this._initialized = true;
  }

  private _createMaterials(): void {
    for (const descriptor of this._payload.materials) {
      this._materials.set(descriptor.id, materialFromDescriptor(descriptor));
    }
  }

  private _createNodes(options: HyaAnimation3DRuntimeOptions): void {
    for (const descriptor of this._payload.nodes) {
      const entity = new Entity(descriptor.name || descriptor.id);
      const transform = new Transform3D();
      const state: TransformState = {
        transform,
        translation: new Float32Array(descriptor.transform.translation),
        rotation: new Float32Array(descriptor.transform.rotation),
        scale: new Float32Array(descriptor.transform.scale),
        matrix: new Float32Array(16),
      };
      commitTransform(state);
      entity.addComponent(transform);
      this._entities.set(descriptor.id, entity);
      this._transforms.set(descriptor.id, state);
      for (const component of descriptor.components) this._createComponent(descriptor, entity, component, options);
    }
  }

  private _createComponent(
    node: HyaAnimation3DNodeDescriptor,
    entity: Entity,
    component: HyaAnimation3DComponentDescriptor,
    options: HyaAnimation3DRuntimeOptions,
  ): void {
    if (component.kind === 'camera3d') {
      const camera = cameraFromProjection(component.projection, this._payload.viewport.width / this._payload.viewport.height);
      entity.addComponent(camera);
      this._cameras.set(node.id, camera);
      return;
    }
    if (component.kind === 'primitive3d') {
      const geometry = primitiveGeometry(component.primitive);
      this._geometries.add(geometry);
      entity.addComponent(new Mesh3D(geometry, required(this._materials, component.materialId, 'material')));
      return;
    }
    if (component.kind === 'particle3d') {
      const { textureResource, ...descriptor } = component.descriptor;
      const resource = textureResource ? required(this._resources, textureResource, 'particle texture') : undefined;
      const textureSource = resource ? options.resolveTexture?.(resource, null) ?? null : null;
      const emitter = new ParticleEmitter3D({
        ...descriptor,
        ...(textureSource ? { textureSource } : {}),
        ...(this._payload.stateMachine ? { playing: false, emitting: false } : {}),
      });
      entity.addComponent(emitter);
      this._particles.push({
        key: `${node.id}\u0000${component.id}`,
        node,
        componentId: component.id,
        emitter,
      });
    }
  }

  private _attachHierarchy(): void {
    for (const descriptor of this._payload.nodes) {
      const entity = required(this._entities, descriptor.id, 'node');
      if (descriptor.parent) required(this._entities, descriptor.parent, 'parent node').addChild(entity);
      else this.root.addChild(entity);
    }
  }

  private async _loadModels(options: HyaAnimation3DRuntimeOptions): Promise<void> {
    const loader = options.loadModel ?? loadGltfModel;
    const tasks: Promise<void>[] = [];
    for (const node of this._payload.nodes) {
      for (const component of node.components) {
        if (component.kind !== 'model3d') continue;
        tasks.push((async () => {
          const resource = required(this._resources, component.resource, 'model resource');
          const model = await loader(resource.uri, { signal: this._abortController.signal });
          if (this._state !== 'active') {
            if (!model.root.destroyed) this._disposeModel(model);
            throw abortError('runtime-destroyed-during-model-load');
          }
          const entity = required(this._entities, node.id, 'model node');
          entity.addChild(model.root);
          applyMaterialOverrides(model.root, component.materialOverrides ?? [], this._materials);
          const runtime = new GltfAnimation3DRuntime(model, {
            signal: this._abortController.signal,
            clipIdPrefix: `hya:${component.id}`,
          });
          this._models.push({ nodeId: node.id, componentId: component.id, model, runtime });
        })());
      }
    }
    await Promise.all(tasks);
  }

  private _buildClipPartitions(): void {
    for (const clip of this._clips) {
      const mainTracks: Animation3DTrack[] = [];
      const modelTracks = new Map<ModelState, Animation3DTrack[]>();
      for (const track of clip.tracks) {
        const endpoint = this._createSceneEndpoint(track.binding);
        if (endpoint) {
          this._resolver.add(endpoint);
          mainTracks.push(track);
          continue;
        }
        const modelMatch = this._matchModelBinding(track);
        if (modelMatch) {
          let tracks = modelTracks.get(modelMatch.model);
          if (!tracks) { tracks = []; modelTracks.set(modelMatch.model, tracks); }
          tracks.push({ ...track, binding: modelMatch.binding });
          let bindingIds = this._modelBindingIds.get(modelMatch.model);
          if (!bindingIds) {
            bindingIds = new Map();
            this._modelBindingIds.set(modelMatch.model, bindingIds);
          }
          bindingIds.set(track.binding.id, modelMatch.binding.id);
          continue;
        }
        throw new RangeError(`HYA Animation3D binding "${track.binding.id}" cannot be resolved.`);
      }
      if (mainTracks.length > 0 || this._payload.stateMachine) {
        this._mainClips.set(clip.id, { ...clip, tracks: Object.freeze(mainTracks) });
      }
      const byModel = new Map<ModelState, Animation3DClip>();
      for (const [model, tracks] of modelTracks) byModel.set(model, { ...clip, id: `${clip.id}:${model.componentId}`, tracks: Object.freeze(tracks) });
      this._modelClips.set(clip.id, byModel);
    }
  }

  private _createStateMachineRuntime(): void {
    const definition = this._payload.stateMachine;
    if (!definition) return;
    const partitions: HyaAnimation3DStateMachinePartition[] = [{
      id: 'scene',
      mixer: animation3DMixerRuntime(this.mixer),
      clips: this._mainClips,
      pose: this.pose,
      apply: pose => this._poseApplier.apply(pose),
    }];
    for (const model of this._models) {
      const clips = new Map<string, Animation3DClip>();
      for (const [clipId, byModel] of this._modelClips) {
        const clip = byModel.get(model);
        if (clip) clips.set(clipId, clip);
      }
      if (clips.size === 0) continue;
      partitions.push({
        id: `model:${model.nodeId}:${model.componentId}`,
        mixer: animation3DMixerRuntime(model.runtime.mixer),
        clips,
        ...(this._modelBindingIds.get(model) ? { bindingIds: this._modelBindingIds.get(model)! } : {}),
        pose: model.runtime.pose,
        apply: pose => model.runtime.applySynchronizedPose(pose),
      });
    }
    const particleCues = new Map<string, readonly HyaAnimation3DParticleCue[]>();
    for (const clip of this._clips) {
      const cues: HyaAnimation3DParticleCue[] = [];
      for (const particle of this._particles) {
        const start = Math.min(clip.duration, Math.max(0, particle.node.start ?? 0));
        const authoredEnd = particle.node.duration === undefined
          ? clip.duration
          : (particle.node.start ?? 0) + particle.node.duration;
        const end = Math.min(clip.duration, Math.max(0, authoredEnd));
        if (end <= start) continue;
        cues.push(Object.freeze({
          key: particle.key,
          emitter: particle.emitter,
          start,
          end,
        }));
      }
      particleCues.set(clip.id, Object.freeze(cues));
    }
    this._stateMachine = new HyaAnimation3DStateMachineRuntime({
      definition,
      clips: this._clips,
      partitions,
      particleCues,
    });
  }

  private _createSceneEndpoint(binding: Animation3DBinding): HyaAnimation3DResolvedEndpoint | null {
    if (binding.path === 'morph.weights') return null;
    const nodeId = binding.target.kind === 'node-id' ? binding.target.nodeId
      : binding.target.kind === 'node-path' && binding.target.segments.length === 1 ? binding.target.segments[0]
        : null;
    if (binding.path.startsWith('transform.') && nodeId) {
      const state = this._transforms.get(nodeId);
      if (!state) return null;
      const target = binding.path === 'transform.translation' ? state.translation
        : binding.path === 'transform.rotation' ? state.rotation : state.scale;
      return endpoint(binding, new Float32Array(target), value => { copy(value, target, binding.valueSize); commitTransform(state); });
    }
    if (binding.path !== 'property') return null;
    if (binding.component === 'material3d' && binding.target.kind === 'slot') {
      const material = this._materials.get(binding.target.slot);
      if (!material) return null;
      return materialEndpoint(binding, material);
    }
    if (binding.component === 'camera3d' && nodeId) {
      const camera = this._cameras.get(nodeId);
      if (!camera) return null;
      return cameraEndpoint(binding, camera, this._payload.viewport.width / this._payload.viewport.height);
    }
    return null;
  }

  private _matchModelBinding(track: Animation3DTrack): { model: ModelState; binding: Animation3DBinding } | null {
    const candidates: Array<{ model: ModelState; binding: Animation3DBinding }> = [];
    for (const model of this._models) {
      for (const sourceClip of model.runtime.clips) {
        for (const sourceTrack of sourceClip.tracks) {
          if (sameModelBinding(track.binding, sourceTrack.binding, model.nodeId)) candidates.push({ model, binding: sourceTrack.binding });
        }
      }
    }
    const exact = candidates.find(candidate => candidate.binding.id === track.binding.id);
    if (exact) return exact;
    return candidates.length === 1 ? candidates[0]! : null;
  }

  private _addPreviewLights(): void {
    const ambient = new Entity('HYA Preview Ambient');
    ambient.addComponent(new AmbientLight({ color: [0.72, 0.8, 1], intensity: 0.5 }));
    this.root.addChild(ambient);
    const sun = new Entity('HYA Preview Sun');
    sun.addComponent(new DirectionalLight({ color: [1, 0.94, 0.84], intensity: 2, direction: [-0.4, -1, -0.35], castShadow: false }));
    this.root.addChild(sun);
  }

  private _assertActive(): void {
    if (this._state !== 'active' || this.root.destroyed) {
      this.destroy();
      throw new Error('HYA Animation3D runtime is destroyed.');
    }
  }
}

export async function createHyaAnimation3DRuntime(options: HyaAnimation3DRuntimeOptions): Promise<HyaAnimation3DRuntime> {
  return await HyaAnimation3DRuntime.create(options);
}

function lowerRuntimeClip(value: HyaAnimation3DPayload['clips'][number]): Animation3DClip {
  return Object.freeze({
    format: 'haiyue-animation3d-clip@1',
    id: value.id,
    name: value.name,
    duration: value.duration,
    tracks: Object.freeze(value.tracks.map(track => Object.freeze({
      id: track.id,
      binding: track.binding,
      interpolation: track.interpolation,
      times: new Float32Array(Array.from(track.times)),
      values: new Float32Array(Array.from(track.values)),
    }))),
    events: Object.freeze([...value.events]),
  });
}

function materialFromDescriptor(value: HyaAnimation3DMaterialDescriptor): PbrMaterial {
  return new PbrMaterial({
    baseColor: value.baseColorFactor,
    metallic: value.metallicFactor,
    roughness: Math.max(0.04, value.roughnessFactor),
    emissiveFactor: value.emissiveFactor,
    alphaMode: value.alphaMode,
    alphaCutoff: value.alphaCutoff ?? 0.5,
    doubleSided: value.doubleSided,
  });
}

function cameraFromProjection(value: HyaAnimation3DCameraProjection, aspect: number): Camera3D {
  if (value.kind === 'perspective') return new Camera3D({ type: 'perspective', fov: value.fovYRadians, near: value.near, far: value.far, aspect });
  const half = value.orthoHeight * 0.5;
  return new Camera3D({ type: 'orthographic', near: value.near, far: value.far, aspect, left: -half * aspect, right: half * aspect, top: half, bottom: -half });
}

function primitiveGeometry(value: Extract<HyaAnimation3DComponentDescriptor, { kind: 'primitive3d' }>['primitive']): Geometry3D {
  switch (value) {
    case 'box': return createBox3D();
    case 'sphere': return createSphere3D();
    case 'plane': return createPlane3D();
    case 'cylinder': return createCylinder3D();
    case 'cone': return createCone3D();
  }
}

function commitTransform(state: TransformState): void {
  composeTrsMatrix(state.translation, state.rotation, state.scale, state.matrix as Float32Array<ArrayBuffer>);
  state.transform.localMatrix = state.matrix;
}

function endpoint(binding: Animation3DBinding, base: Float32Array, write: (value: ArrayLike<number>) => void): HyaAnimation3DResolvedEndpoint {
  return new HyaAnimation3DResolvedEndpoint(binding, out => copy(base, out, binding.valueSize), write);
}

function materialEndpoint(binding: Extract<Animation3DBinding, { path: 'property' }>, material: PbrMaterial): HyaAnimation3DResolvedEndpoint {
  const base = new Float32Array(binding.valueSize);
  if (binding.property === 'baseColorFactor') material.baseColor.writeLinear(base);
  else {
    const value: ArrayLike<number> = binding.property === 'emissiveFactor' ? material.emissiveFactor
        : [binding.property === 'metallicFactor' ? material.metallic
          : binding.property === 'roughnessFactor' ? material.roughness
            : material.alphaCutoff];
    copy(value, base, binding.valueSize);
  }
  const write = (value: ArrayLike<number>): void => {
    if (binding.property === 'baseColorFactor') material.baseColor = tuple4(value);
    else if (binding.property === 'emissiveFactor') material.emissiveFactor = tuple3(value);
    else if (binding.property === 'metallicFactor') material.metallic = value[0] ?? 0;
    else if (binding.property === 'roughnessFactor') material.roughness = Math.max(0.04, value[0] ?? 0.04);
    else if (binding.property === 'alphaCutoff') material.alphaCutoff = value[0] ?? 0.5;
  };
  return endpoint(binding, base, write);
}

function cameraEndpoint(binding: Extract<Animation3DBinding, { path: 'property' }>, camera: Camera3D, aspect: number): HyaAnimation3DResolvedEndpoint {
  const base = new Float32Array([binding.property === 'fovYRadians' ? camera.fov
    : binding.property === 'near' ? camera.near
      : binding.property === 'far' ? camera.far
        : camera.orthoTop - camera.orthoBottom]);
  const write = (value: ArrayLike<number>): void => {
    const next = value[0] ?? 0;
    if (binding.property === 'fovYRadians') camera.fov = next;
    else if (binding.property === 'near') camera.near = next;
    else if (binding.property === 'far') camera.far = next;
    else if (binding.property === 'orthoHeight') {
      const half = next * 0.5;
      camera.orthoLeft = -half * aspect; camera.orthoRight = half * aspect;
      camera.orthoTop = half; camera.orthoBottom = -half;
    }
  };
  return endpoint(binding, base, write);
}

function sameModelBinding(candidate: Animation3DBinding, endpoint: Animation3DBinding, modelNodeId: string): boolean {
  if (candidate.id === endpoint.id) return candidate.path === endpoint.path && candidate.valueSize === endpoint.valueSize;
  if (candidate.path !== endpoint.path || candidate.valueSize !== endpoint.valueSize) return false;
  if (candidate.target.kind === 'node-path' && endpoint.target.kind === 'node-path') {
    const authored = candidate.target.segments[0] === modelNodeId ? candidate.target.segments.slice(1) : candidate.target.segments;
    const endpointSegments = endpoint.target.segments;
    return authored.length <= endpointSegments.length
      && authored.every((segment, index) => segment === endpointSegments[endpointSegments.length - authored.length + index]);
  }
  if (candidate.path === 'morph.weights' && candidate.target.kind === 'slot') {
    return candidate.target.slot === modelNodeId || candidate.target.slot.startsWith(`${modelNodeId}:`);
  }
  return false;
}

function applyMaterialOverrides(root: Entity, overrides: readonly Readonly<{ slot: string; materialId: string }>[], materials: ReadonlyMap<string, PbrMaterial>): void {
  if (overrides.length === 0) return;
  const bySlot = new Map(overrides.map(item => [item.slot, required(materials, item.materialId, 'material override')]));
  const pending = [root];
  while (pending.length > 0) {
    const entity = pending.pop()!;
    const mesh = entity.getComponent(Mesh3D);
    const material = bySlot.get(entity.name);
    if (mesh && material) mesh.material = material;
    pending.push(...entity.children);
  }
}

function copy(source: ArrayLike<number>, target: Float32Array, count: number): void {
  for (let index = 0; index < count; index++) target[index] = source[index] ?? 0;
}

function tuple3(value: ArrayLike<number>): [number, number, number] {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
}

function tuple4(value: ArrayLike<number>): [number, number, number, number] {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0];
}

function withoutGroupOptions(options: HyaAnimation3DPlayOptions): import('../Animation3DAction').Animation3DActionOptions {
  const { fadeFrom: _fadeFrom, fadeDuration: _fadeDuration, warp: _warp, id: _id, ...result } = options;
  return result;
}

function required<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key, label: string): Value {
  const value = map.get(key);
  if (!value) throw new RangeError(`Unknown ${label} "${String(key)}".`);
  return value;
}

function abortError(reason: unknown): DOMException {
  return new DOMException(reason === undefined ? 'The operation was aborted.' : String(reason), 'AbortError');
}
