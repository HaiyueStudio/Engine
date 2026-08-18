import { mat4 } from 'wgpu-matrix';
import { Camera3D } from '../components/Camera3D';
import { Mesh3D } from '../components/Mesh3D';
import { PlanarMirror } from '../components/PlanarMirror';
import { Transform3D } from '../components/Transform3D';
import { RenderGraph, type RenderGraphPassHandle, type RenderGraphStats } from '../core/RenderGraph';
import { RenderView, type RenderViewSnapshot, type RenderViewTarget, type RenderViewTargetPassOptions } from '../core/RenderView';
import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { GPUResourceScope } from '../core/GPUResourceTracker';
import { Entity } from '../ecs/Entity';
import type { SystemQueryDescriptor } from '../ecs/Query';
import type { World } from '../ecs/World';
import type { FrameData } from '../frame/FrameData';
import type { Material } from '../material/Material';
import { RttEngine } from '../rtt/RttEngine';
import {
  TransientRenderTargetPool,
  estimateTransientRenderTargetBytes,
  type TransientRenderTargetDescriptor,
  type TransientRenderTargetPoolStats,
  type TransientRenderTargetRequest,
} from '../rtt/TransientRenderTargetPool';
import { isEntityDisabledInHierarchy } from '../ecs/utils/hierarchy';
import {
  MirrorViewPlanner,
  type MirrorViewCacheState,
  type MirrorViewPlannerCallbacks,
  type MirrorViewPlannerMirror,
  type MirrorViewPlannerOptions,
  type MirrorViewPlannerStats,
  type MirrorViewPlanBudget,
  type MirrorViewRenderRequest,
} from './MirrorViewPlanner';

const MIRROR_QUERY: SystemQueryDescriptor = Object.freeze({ all: Object.freeze([PlanarMirror, Mesh3D]) });

interface MirrorRuntimeState extends MirrorViewPlannerMirror {
  entity: Entity;
  component: PlanarMirror;
  mesh: Mesh3D;
  originalMaterial: Material;
  readonly views: Map<string, MirrorViewRuntimeState>;
  readonly worldMatrix: Float32Array;
  readonly worldNormal: Float32Array;
  readonly worldSphere: { center: [number, number, number]; radius: number };
  readonly localBoundsMin: Float32Array;
  readonly localBoundsMax: Float32Array;
  seenGeneration: number;
}

interface MirrorViewRuntimeState {
  readonly mirrorEntityId: number;
  readonly sourceViewKey: string;
  readonly pendingTarget: PendingMirrorTarget;
  readonly cameraEntity: Entity;
  readonly camera: ObliqueReflectionCamera;
  readonly transform: Transform3D;
  readonly view: RenderView;
  readonly excludedEntityIds: Set<number>;
  readonly reflectionViewProjection: Float32Array;
  target: RttEngine | null;
  persistentTarget: RttEngine | null;
  persistentScope: GPUResourceScope | null;
  depth: number;
  width: number;
  height: number;
  textureVersion: number;
  seenGeneration: number;
  lastRenderedFrame: number;
  reflectionRevision: number;
}

interface MirrorGraphPassPayload {
  readonly sourceView: RenderViewSnapshot | null;
  readonly runtime: MirrorViewRuntimeState | null;
}

interface MirrorGraphResourcePayload {
  readonly runtime: MirrorViewRuntimeState;
  readonly descriptor: TransientRenderTargetDescriptor;
  readonly scope: string;
  readonly persistent: boolean;
}

export interface PlanarMirrorExecutionPass {
  readonly passClass: 'scene-global' | 'view-local' | 'reflection-local';
  readonly view: RenderViewSnapshot | null;
}

export interface PlanarMirrorResourceScopeStats {
  readonly scope: string;
  readonly lifetime: 'transient' | 'persistent';
  readonly physicalId: number | null;
  readonly firstUse: number;
  readonly lastUse: number;
  readonly estimatedBytes: number;
  readonly ownerLabel: string | null;
}

export interface PlanarMirrorGpuResourceStats {
  readonly logicalTargetCount: number;
  readonly transientPhysicalTargetCount: number;
  readonly persistentTargetCount: number;
  readonly estimatedLogicalBytes: number;
  readonly estimatedResidentBytes: number;
  readonly aliasSavedBytes: number;
  readonly scopes: readonly PlanarMirrorResourceScopeStats[];
}

/** Internal owner for planar-reflection cameras, targets, and view scheduling. */
export class PlanarMirrorManager {
  private readonly states = new Map<number, MirrorRuntimeState>();
  private readonly activeStates: MirrorRuntimeState[] = [];
  private readonly combinedViews: RenderViewSnapshot[] = [];
  private readonly executionPasses: PlanarMirrorExecutionPass[] = [];
  private readonly graph = new RenderGraph<MirrorGraphPassPayload, MirrorGraphResourcePayload>();
  private readonly transientTargets: TransientRenderTargetPool;
  private readonly sourcePasses = new Map<string, RenderGraphPassHandle>();
  private readonly requestPasses = new Map<MirrorViewRenderRequest, RenderGraphPassHandle>();
  private readonly transientRequests: TransientRenderTargetRequest<MirrorViewRuntimeState>[] = [];
  private sceneGlobalPass: RenderGraphPassHandle = -1;
  private readonly resourceScopes: PlanarMirrorResourceScopeStats[] = [];
  private readonly resourceStats: PlanarMirrorGpuResourceStats = {
    logicalTargetCount: 0,
    transientPhysicalTargetCount: 0,
    persistentTargetCount: 0,
    estimatedLogicalBytes: 0,
    estimatedResidentBytes: 0,
    aliasSavedBytes: 0,
    scopes: this.resourceScopes,
  };
  private readonly planner: MirrorViewPlanner;
  private readonly mirrorWorldMatrix = mat4.identity() as Float32Array;
  private readonly inverseMirrorWorld = mat4.identity() as Float32Array;
  private readonly reflectedCameraWorld = mat4.identity() as Float32Array;
  private readonly plane = new Float32Array(4);
  private readonly normal = new Float32Array(3);
  private readonly forward = new Float32Array(3);
  private readonly up = new Float32Array(3);
  private readonly right = new Float32Array(3);
  private generation = 0;
  private world: World | null = null;
  private frameData: FrameData | null = null;
  private readonly plannerCallbacks: MirrorViewPlannerCallbacks = {
    getCacheState: request => this.getCacheState(request),
    touchCache: request => this.touchCache(request),
    materialize: request => this.materialize(request),
    includeChild: (parent, childEntityId) => this.includeChild(parent, childEntityId),
  };

  constructor(private readonly engine: IEngine, options: MirrorViewPlannerOptions = {}) {
    this.planner = new MirrorViewPlanner(
      options,
      engine.device.limits?.maxTextureDimension2D ?? Number.MAX_SAFE_INTEGER,
    );
    this.transientTargets = new TransientRenderTargetPool(engine);
  }

  get stats(): MirrorViewPlannerStats { return this.planner.stats; }
  get graphStats(): RenderGraphStats { return this.graph.stats; }
  get transientTargetStats(): TransientRenderTargetPoolStats { return this.transientTargets.stats; }
  get gpuResourceStats(): PlanarMirrorGpuResourceStats { return this.resourceStats; }
  get compiledExecutionPasses(): readonly PlanarMirrorExecutionPass[] { return this.executionPasses; }

  prepare(
    world: World,
    frameData: FrameData,
    sourceViews: readonly RenderViewSnapshot[],
    budget: MirrorViewPlanBudget = {},
    mirrorsEnabled = true,
  ): readonly RenderViewSnapshot[] {
    this.world = world;
    this.frameData = frameData;
    this.generation = nextGeneration(this.generation);
    this.activeStates.length = 0;
    this.executionPasses.length = 0;
    this.graph.clear();
    this.sourcePasses.clear();
    this.requestPasses.clear();
    this.transientRequests.length = 0;

    const sceneGlobalPass = this.graph.addPass({
      name: 'render3d.scene-global',
      passClass: 'scene-global',
      payload: { sourceView: null, runtime: null },
    });
    this.sceneGlobalPass = sceneGlobalPass;
    for (const sourceView of sourceViews) {
      if (sourceView.key.startsWith('planar-mirror:')) continue;
      const pass = this.graph.addPass({
        name: `render3d.view:${sourceView.key}`,
        passClass: 'view-local',
        payload: { sourceView, runtime: null },
        sideEffect: true,
      });
      this.graph.dependsOn(pass, sceneGlobalPass);
      this.sourcePasses.set(sourceView.key, pass);
    }

    if (mirrorsEnabled) {
      for (const entity of world.iterQueryCandidates(MIRROR_QUERY)) {
        if (entity.world !== world || entity.destroyed || isEntityDisabledInHierarchy(entity)) continue;
        const component = entity.getComponent(PlanarMirror);
        const mesh = entity.getComponent(Mesh3D);
        if (!component || component.disabled || !mesh || mesh.disabled) continue;
        let state = this.states.get(entity.id);
        if (state && (state.entity !== entity || state.component !== component || state.mesh !== mesh)) {
          this.destroyState(state, true);
          this.states.delete(entity.id);
          state = undefined;
        }
        if (!state) {
          state = {
            entity,
            component,
            mesh,
            originalMaterial: mesh.material,
            views: new Map(),
            worldMatrix: mat4.identity() as Float32Array,
            worldNormal: new Float32Array(3),
            worldSphere: { center: [0, 0, 0], radius: 0 },
            localBoundsMin: new Float32Array(3),
            localBoundsMax: new Float32Array(3),
            seenGeneration: this.generation,
          };
          this.states.set(entity.id, state);
        }
        state.seenGeneration = this.generation;
        if (mesh.material !== component.material) {
          state.originalMaterial = mesh.material;
          mesh.material = component.material;
        }
        this.updatePlanningState(state, frameData);
        this.activeStates.push(state);
      }
    }

    this.combinedViews.length = 0;
    this.planner.plan(sourceViews, this.activeStates, frameData, this.plannerCallbacks, budget);
    for (const state of this.activeStates) {
      if (state.seenGeneration !== this.generation) continue;
      this.sweepViewStates(state, world);
    }
    this.sweepStates();
    const compiledPasses = this.graph.compile();
    this.assignTransientTargets();
    this.updateResourceStats();
    for (const pass of compiledPasses) {
      const payload = pass.payload;
      const view = payload.runtime ? payload.runtime.view.snapshot() : payload.sourceView;
      this.executionPasses.push({ passClass: pass.passClass, view });
      if (view) this.combinedViews.push(view);
    }
    return this.combinedViews;
  }

  destroy(): void {
    for (const state of this.states.values()) this.destroyState(state, true);
    this.states.clear();
    this.activeStates.length = 0;
    this.combinedViews.length = 0;
    this.executionPasses.length = 0;
    this.graph.clear();
    this.sourcePasses.clear();
    this.requestPasses.clear();
    this.transientTargets.destroy();
    this.resourceScopes.length = 0;
    this.world = null;
    this.frameData = null;
  }

  private prepareReflectionView(
    state: MirrorRuntimeState,
    sourceView: RenderViewSnapshot,
    world: World,
    frameData: FrameData,
    width: number,
    height: number,
    depth: number,
  ): RenderViewSnapshot | null {
    const sourceCamera = sourceView.camera.getComponent(Camera3D);
    if (!sourceCamera) return null;
    let runtime = state.views.get(sourceView.key);
    if (!runtime) {
      runtime = this.createViewState(state, sourceView, world, width, height, depth);
      state.views.set(sourceView.key, runtime);
    } else if (runtime.width !== width || runtime.height !== height) {
      this.destroyPersistentTarget(runtime);
      runtime.target = null;
      runtime.pendingTarget.resize(width, height);
      runtime.width = width;
      runtime.height = height;
      runtime.textureVersion++;
    }
    runtime.seenGeneration = this.generation;
    runtime.depth = depth;
    runtime.view.target = runtime.pendingTarget;
    runtime.excludedEntityIds.clear();
    for (const mirror of this.activeStates) runtime.excludedEntityIds.add(mirror.entity.id);
    this.copyCamera(sourceCamera, runtime.camera);

    const mirrorWorld = frameData.transforms.getWorldMatrix(state.entity);
    this.mirrorWorldMatrix.set(mirrorWorld);
    const sourceFrame = frameData.getCamera3D(sourceView.camera, sourceCamera, {
      width: sourceView.width,
      height: sourceView.height,
      reverseZ: sourceView.reverseZ,
    });
    this.computePlane(state.component, this.mirrorWorldMatrix, sourceFrame.position);
    this.reflectCamera(sourceFrame.worldMatrix, this.plane, this.reflectedCameraWorld);
    this.plane[3] = (this.plane[3] ?? 0) - state.component.clipBias;
    runtime.transform.setMatrix(this.reflectedCameraWorld);
    runtime.camera.setClipPlane(this.plane, this.reflectedCameraWorld);
    const reflectionFrame = frameData.getCamera3D(runtime.cameraEntity, runtime.camera, {
      width,
      height,
      reverseZ: sourceView.reverseZ,
    });
    runtime.reflectionViewProjection.set(reflectionFrame.viewProjectionMatrix);
    runtime.view.clearColor = state.component.clearColor as GPUColorDict;
    runtime.view.depthConvention = sourceView.depthConvention;
    runtime.view.sampleCount = state.component.sampleCount;
    runtime.view.loadOp = 'clear';
    if (requiresPersistentTarget(state.component)) {
      const target = this.ensurePersistentTarget(runtime, state, sourceView);
      runtime.view.target = target;
      state.component.material.setReflection(
        sourceView.key,
        target.colorTexture,
        runtime.textureVersion,
        runtime.reflectionViewProjection,
      );
    } else if (runtime.persistentTarget) {
      this.destroyPersistentTarget(runtime);
      runtime.target = null;
      runtime.textureVersion++;
    }
    runtime.lastRenderedFrame = frameData.frameId;
    runtime.reflectionRevision = state.component.reflectionRevision;
    return runtime.view.snapshot();
  }

  private createViewState(
    state: MirrorRuntimeState,
    sourceView: RenderViewSnapshot,
    world: World,
    width: number,
    height: number,
    depth: number,
  ): MirrorViewRuntimeState {
    const pendingTarget = new PendingMirrorTarget(this.engine.format, width, height);
    const camera = new ObliqueReflectionCamera();
    const transform = new Transform3D();
    const cameraEntity = new Entity(`PlanarMirrorCamera:${state.entity.id}:${sourceView.key}`)
      .addComponent(camera)
      .addComponent(transform);
    world.addEntity(cameraEntity);
    const excludedEntityIds = new Set<number>();
    const view = new RenderView({
      key: `planar-mirror:${state.entity.id}:${sourceView.key}`,
      camera: cameraEntity,
      target: pendingTarget,
      clearColor: state.component.clearColor as GPUColorDict,
      depthConvention: sourceView.depthConvention,
      sampleCount: state.component.sampleCount,
      loadOp: 'clear',
      excludedEntityIds,
      postProcessEnabled: false,
    });
    return {
      mirrorEntityId: state.entity.id,
      sourceViewKey: sourceView.key,
      pendingTarget,
      cameraEntity,
      camera,
      transform,
      view,
      excludedEntityIds,
      reflectionViewProjection: mat4.identity() as Float32Array,
      target: null,
      persistentTarget: null,
      persistentScope: null,
      depth,
      width,
      height,
      textureVersion: 0,
      seenGeneration: this.generation,
      lastRenderedFrame: 0,
      reflectionRevision: 0,
    };
  }

  private copyCamera(source: Camera3D, target: Camera3D): void {
    target.projectionType = source.projectionType;
    target.fov = source.fov;
    target.near = source.near;
    target.far = source.far;
    target.orthoLeft = source.orthoLeft;
    target.orthoRight = source.orthoRight;
    target.orthoTop = source.orthoTop;
    target.orthoBottom = source.orthoBottom;
    target.reverseZ = source.reverseZ;
  }

  private getCacheState(request: MirrorViewRenderRequest): MirrorViewCacheState | null {
    const state = this.states.get(request.mirror.entity.id);
    const runtime = state?.views.get(request.sourceView.key);
    if (
      !state
      || !runtime
      || runtime.width !== request.width
      || runtime.height !== request.height
      || !runtime.persistentTarget
      || runtime.persistentTarget.msaaSamples !== state.component.sampleCount
      || runtime.persistentTarget.reverseZ !== request.sourceView.reverseZ
    ) return null;
    return runtime;
  }

  private touchCache(request: MirrorViewRenderRequest): void {
    const runtime = this.states.get(request.mirror.entity.id)?.views.get(request.sourceView.key);
    if (!runtime) return;
    runtime.seenGeneration = this.generation;
    const consumer = request.parent
      ? this.requestPasses.get(request.parent)
      : this.sourcePasses.get(request.sourceView.key);
    if (consumer === undefined) return;
    const resource = this.graph.addResource({
      name: `planar-reflection.cached:${request.mirror.entity.id}:${request.sourceView.key}`,
      payload: {
        runtime,
        descriptor: {
          width: request.width,
          height: request.height,
          sampleCount: request.mirror.component.sampleCount,
          reverseZ: request.sourceView.reverseZ,
        },
        scope: `mirror:${request.mirror.entity.id}:depth:${request.depth}:source:${request.sourceView.key}`,
        persistent: true,
      },
      transient: false,
    });
    this.graph.read(consumer, resource);
  }

  private materialize(request: MirrorViewRenderRequest): RenderViewSnapshot | null {
    const world = this.world;
    const frameData = this.frameData;
    const state = this.states.get(request.mirror.entity.id);
    if (!world || !frameData || !state) return null;
    const view = this.prepareReflectionView(
      state,
      request.sourceView,
      world,
      frameData,
      request.width,
      request.height,
      request.depth,
    );
    if (!view) return null;
    const runtime = state.views.get(request.sourceView.key);
    if (!runtime) return null;
    const persistent = requiresPersistentTarget(state.component);
    const resource = this.graph.addResource({
      name: `planar-reflection:${state.entity.id}:${request.sourceView.key}`,
      payload: {
        runtime,
        descriptor: {
          width: request.width,
          height: request.height,
          sampleCount: state.component.sampleCount,
          reverseZ: request.sourceView.reverseZ,
        },
        scope: `mirror:${state.entity.id}:depth:${request.depth}:source:${request.sourceView.key}`,
        persistent,
      },
      transient: !persistent,
    });
    const pass = this.graph.addPass({
      name: `planar-reflection.pass:${state.entity.id}:${request.sourceView.key}`,
      passClass: 'reflection-local',
      payload: { sourceView: null, runtime },
    });
    if (this.sceneGlobalPass >= 0) this.graph.dependsOn(pass, this.sceneGlobalPass);
    this.graph.write(pass, resource);
    const consumer = request.parent
      ? this.requestPasses.get(request.parent)
      : this.sourcePasses.get(request.sourceView.key);
    if (consumer === undefined) return null;
    this.graph.read(consumer, resource);
    this.requestPasses.set(request, pass);
    return view;
  }

  private assignTransientTargets(): void {
    this.transientRequests.length = 0;
    for (const lifetime of this.graph.resourceLifetimes) {
      if (!lifetime.transient || lifetime.payload.persistent) continue;
      this.transientRequests.push({
        id: lifetime.handle,
        scope: lifetime.payload.scope,
        descriptor: lifetime.payload.descriptor,
        firstUse: lifetime.firstUse,
        lastUse: lifetime.lastUse,
        payload: lifetime.payload.runtime,
      });
    }
    const assignments = this.transientTargets.assign(this.transientRequests);
    for (const assignment of assignments) {
      const runtime = assignment.payload;
      if (runtime.target !== assignment.target) runtime.textureVersion++;
      runtime.target = assignment.target;
      runtime.view.target = assignment.target;
      assignment.target.msaaSamples = assignment.descriptor.sampleCount;
      assignment.target.reverseZ = assignment.descriptor.reverseZ;
      assignment.target.clearColor = runtime.view.clearColor as GPUColorDict;
      const state = this.states.get(runtime.mirrorEntityId);
      state?.component.material.setReflection(
        runtime.sourceViewKey,
        assignment.target.colorTexture,
        runtime.textureVersion,
        runtime.reflectionViewProjection,
      );
    }
  }

  private ensurePersistentTarget(
    runtime: MirrorViewRuntimeState,
    state: MirrorRuntimeState,
    sourceView: RenderViewSnapshot,
  ): RttEngine {
    let target = runtime.persistentTarget;
    if (!target) {
      const tracker = getEngineGPUResourceTracker(this.engine);
      const scope = tracker?.createScope(
        'system',
        `PlanarMirror:${state.entity.id}:depth:${runtime.depth}:source:${runtime.sourceViewKey}`,
      ) ?? null;
      target = new RttEngine(
        this.engine,
        runtime.width,
        runtime.height,
        state.component.clearColor as GPUColorDict,
        `PlanarMirror:${state.entity.id}:${runtime.sourceViewKey}`,
        scope?.owner ?? null,
      );
      runtime.persistentScope = scope;
      runtime.persistentTarget = target;
      runtime.target = target;
      runtime.textureVersion++;
    }
    target.msaaSamples = state.component.sampleCount;
    target.reverseZ = sourceView.reverseZ;
    target.clearColor = state.component.clearColor as GPUColorDict;
    return target;
  }

  private updateResourceStats(): void {
    this.resourceScopes.length = 0;
    const transient = this.transientTargets.stats;
    for (const scope of transient.scopes) {
      this.resourceScopes.push({
        scope: scope.scope,
        lifetime: 'transient',
        physicalId: scope.physicalId,
        firstUse: scope.firstUse,
        lastUse: scope.lastUse,
        estimatedBytes: scope.estimatedBytes,
        ownerLabel: null,
      });
    }
    let persistentCount = 0;
    let persistentBytes = 0;
    for (const lifetime of this.graph.resourceLifetimes) {
      const payload = lifetime.payload;
      if (!payload.persistent) continue;
      const estimatedBytes = estimateTransientRenderTargetBytes(this.engine, payload.descriptor);
      persistentCount++;
      persistentBytes += estimatedBytes;
      this.resourceScopes.push({
        scope: payload.scope,
        lifetime: 'persistent',
        physicalId: null,
        firstUse: lifetime.firstUse,
        lastUse: lifetime.lastUse,
        estimatedBytes,
        ownerLabel: payload.runtime.persistentScope?.owner.label ?? null,
      });
    }
    Object.assign(this.resourceStats, {
      logicalTargetCount: transient.logicalTargetCount + persistentCount,
      transientPhysicalTargetCount: transient.physicalTargetCount,
      persistentTargetCount: persistentCount,
      estimatedLogicalBytes: transient.estimatedLogicalBytes + persistentBytes,
      estimatedResidentBytes: transient.estimatedPhysicalBytes + persistentBytes,
      aliasSavedBytes: transient.savedBytes,
    });
  }

  private includeChild(parent: MirrorViewRenderRequest, childEntityId: number): void {
    const runtime = this.states.get(parent.mirror.entity.id)?.views.get(parent.sourceView.key);
    runtime?.excludedEntityIds.delete(childEntityId);
  }

  private updatePlanningState(state: MirrorRuntimeState, frameData: FrameData): void {
    const worldMatrix = frameData.transforms.getWorldMatrix(state.entity);
    state.worldMatrix.set(worldMatrix);
    const bounds = state.mesh.geometry.getBoundingBox();
    state.localBoundsMin.set(bounds.min);
    state.localBoundsMax.set(bounds.max);
    const localX = ((bounds.min[0] ?? 0) + (bounds.max[0] ?? 0)) * 0.5;
    const localY = ((bounds.min[1] ?? 0) + (bounds.max[1] ?? 0)) * 0.5;
    const localZ = ((bounds.min[2] ?? 0) + (bounds.max[2] ?? 0)) * 0.5;
    const extentX = ((bounds.max[0] ?? 0) - (bounds.min[0] ?? 0)) * 0.5;
    const extentY = ((bounds.max[1] ?? 0) - (bounds.min[1] ?? 0)) * 0.5;
    const extentZ = ((bounds.max[2] ?? 0) - (bounds.min[2] ?? 0)) * 0.5;
    const center = state.worldSphere.center;
    center[0] = (worldMatrix[0] ?? 1) * localX + (worldMatrix[4] ?? 0) * localY + (worldMatrix[8] ?? 0) * localZ + (worldMatrix[12] ?? 0);
    center[1] = (worldMatrix[1] ?? 0) * localX + (worldMatrix[5] ?? 1) * localY + (worldMatrix[9] ?? 0) * localZ + (worldMatrix[13] ?? 0);
    center[2] = (worldMatrix[2] ?? 0) * localX + (worldMatrix[6] ?? 0) * localY + (worldMatrix[10] ?? 1) * localZ + (worldMatrix[14] ?? 0);
    const scaleX = Math.hypot(worldMatrix[0] ?? 1, worldMatrix[1] ?? 0, worldMatrix[2] ?? 0);
    const scaleY = Math.hypot(worldMatrix[4] ?? 0, worldMatrix[5] ?? 1, worldMatrix[6] ?? 0);
    const scaleZ = Math.hypot(worldMatrix[8] ?? 0, worldMatrix[9] ?? 0, worldMatrix[10] ?? 1);
    state.worldSphere.radius = Math.hypot(extentX, extentY, extentZ) * Math.max(scaleX, scaleY, scaleZ);

    mat4.inverse(worldMatrix, this.inverseMirrorWorld);
    const localNormal = state.component.localNormal;
    const inverse = this.inverseMirrorWorld;
    const normal = state.worldNormal;
    normal[0] = (inverse[0] ?? 0) * localNormal[0] + (inverse[1] ?? 0) * localNormal[1] + (inverse[2] ?? 0) * localNormal[2];
    normal[1] = (inverse[4] ?? 0) * localNormal[0] + (inverse[5] ?? 0) * localNormal[1] + (inverse[6] ?? 0) * localNormal[2];
    normal[2] = (inverse[8] ?? 0) * localNormal[0] + (inverse[9] ?? 0) * localNormal[1] + (inverse[10] ?? 0) * localNormal[2];
    normalize3(normal);
  }

  private computePlane(component: PlanarMirror, worldMatrix: Float32Array, cameraPosition: Float32Array): void {
    mat4.inverse(worldMatrix, this.inverseMirrorWorld);
    const local = component.localNormal;
    const inverse = this.inverseMirrorWorld;
    let nx = (inverse[0] ?? 0) * local[0] + (inverse[1] ?? 0) * local[1] + (inverse[2] ?? 0) * local[2];
    let ny = (inverse[4] ?? 0) * local[0] + (inverse[5] ?? 0) * local[1] + (inverse[6] ?? 0) * local[2];
    let nz = (inverse[8] ?? 0) * local[0] + (inverse[9] ?? 0) * local[1] + (inverse[10] ?? 0) * local[2];
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    const px = worldMatrix[12] ?? 0;
    const py = worldMatrix[13] ?? 0;
    const pz = worldMatrix[14] ?? 0;
    if (nx * ((cameraPosition[0] ?? 0) - px) + ny * ((cameraPosition[1] ?? 0) - py) + nz * ((cameraPosition[2] ?? 0) - pz) < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    this.normal[0] = nx;
    this.normal[1] = ny;
    this.normal[2] = nz;
    this.plane[0] = nx;
    this.plane[1] = ny;
    this.plane[2] = nz;
    this.plane[3] = -(nx * px + ny * py + nz * pz);
  }

  private reflectCamera(sourceWorld: Float32Array, plane: Float32Array, out: Float32Array): void {
    const nx = plane[0] ?? 0;
    const ny = plane[1] ?? 0;
    const nz = plane[2] ?? 1;
    const d = plane[3] ?? 0;
    const ex = sourceWorld[12] ?? 0;
    const ey = sourceWorld[13] ?? 0;
    const ez = sourceWorld[14] ?? 0;
    const distance = nx * ex + ny * ey + nz * ez + d;
    const eyeX = ex - 2 * distance * nx;
    const eyeY = ey - 2 * distance * ny;
    const eyeZ = ez - 2 * distance * nz;

    this.forward[0] = -(sourceWorld[8] ?? 0);
    this.forward[1] = -(sourceWorld[9] ?? 0);
    this.forward[2] = -(sourceWorld[10] ?? 1);
    this.up[0] = sourceWorld[4] ?? 0;
    this.up[1] = sourceWorld[5] ?? 1;
    this.up[2] = sourceWorld[6] ?? 0;
    reflectDirection(this.forward, nx, ny, nz);
    reflectDirection(this.up, nx, ny, nz);
    normalize3(this.forward);
    normalize3(this.up);
    cross3(this.forward, this.up, this.right);
    normalize3(this.right);
    cross3(this.right, this.forward, this.up);
    normalize3(this.up);

    out[0] = this.right[0] ?? 1;
    out[1] = this.right[1] ?? 0;
    out[2] = this.right[2] ?? 0;
    out[3] = 0;
    out[4] = this.up[0] ?? 0;
    out[5] = this.up[1] ?? 1;
    out[6] = this.up[2] ?? 0;
    out[7] = 0;
    out[8] = -(this.forward[0] ?? 0);
    out[9] = -(this.forward[1] ?? 0);
    out[10] = -(this.forward[2] ?? -1);
    out[11] = 0;
    out[12] = eyeX;
    out[13] = eyeY;
    out[14] = eyeZ;
    out[15] = 1;
  }

  private sweepViewStates(state: MirrorRuntimeState, world: World): void {
    for (const [viewKey, runtime] of state.views) {
      if (generationAge(this.generation, runtime.seenGeneration) < this.planner.cacheRetentionFrames) continue;
      this.destroyViewState(state, runtime, world);
      state.views.delete(viewKey);
    }
  }

  private sweepStates(): void {
    for (const [entityId, state] of this.states) {
      if (state.seenGeneration === this.generation) continue;
      this.destroyState(state, true);
      this.states.delete(entityId);
    }
  }

  private destroyState(state: MirrorRuntimeState, restoreMaterial: boolean): void {
    const world = state.entity.world ?? this.world;
    for (const runtime of state.views.values()) {
      if (world) this.destroyViewState(state, runtime, world);
      else this.destroyPersistentTarget(runtime);
    }
    state.views.clear();
    state.component.material.clearReflections();
    if (restoreMaterial && state.mesh.material === state.component.material) {
      state.mesh.material = state.originalMaterial;
    }
  }

  private destroyViewState(state: MirrorRuntimeState, runtime: MirrorViewRuntimeState, world: World): void {
    state.component.material.deleteReflection(runtime.sourceViewKey);
    this.destroyPersistentTarget(runtime);
    if (world.hasEntity(runtime.cameraEntity)) world.destroyEntity(runtime.cameraEntity);
  }

  private destroyPersistentTarget(runtime: MirrorViewRuntimeState): void {
    runtime.persistentTarget?.destroy();
    runtime.persistentTarget = null;
    runtime.persistentScope?.release();
    runtime.persistentScope = null;
  }
}

class PendingMirrorTarget implements RenderViewTarget {
  readonly key: string;
  get displayWidth(): number { return this.width; }
  get displayHeight(): number { return this.height; }

  constructor(
    readonly format: GPUTextureFormat,
    public width: number,
    public height: number,
  ) {
    this.key = `planar-mirror-pending:${++pendingMirrorTargetId}`;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  getOutputView(): GPUTextureView {
    throw new Error('Pending planar-mirror target reached execution before RenderGraph allocation.');
  }

  getRenderPassDescriptor(_options: RenderViewTargetPassOptions): GPURenderPassDescriptor {
    throw new Error('Pending planar-mirror target reached execution before RenderGraph allocation.');
  }
}

let pendingMirrorTargetId = 0;

function requiresPersistentTarget(component: PlanarMirror): boolean {
  return component.staticCache || component.updateInterval > 1;
}

class ObliqueReflectionCamera extends Camera3D {
  private readonly clipPlaneView = new Float32Array(4);
  private readonly inverseProjection = mat4.identity() as Float32Array;
  private clipEnabled = false;

  setClipPlane(worldPlane: Float32Array, cameraWorld: Float32Array): void {
    const a = worldPlane[0] ?? 0;
    const b = worldPlane[1] ?? 0;
    const c = worldPlane[2] ?? 1;
    const d = worldPlane[3] ?? 0;
    this.clipPlaneView[0] = (cameraWorld[0] ?? 0) * a + (cameraWorld[1] ?? 0) * b + (cameraWorld[2] ?? 0) * c + (cameraWorld[3] ?? 0) * d;
    this.clipPlaneView[1] = (cameraWorld[4] ?? 0) * a + (cameraWorld[5] ?? 0) * b + (cameraWorld[6] ?? 0) * c + (cameraWorld[7] ?? 0) * d;
    this.clipPlaneView[2] = (cameraWorld[8] ?? 0) * a + (cameraWorld[9] ?? 0) * b + (cameraWorld[10] ?? 0) * c + (cameraWorld[11] ?? 0) * d;
    this.clipPlaneView[3] = (cameraWorld[12] ?? 0) * a + (cameraWorld[13] ?? 0) * b + (cameraWorld[14] ?? 0) * c + (cameraWorld[15] ?? 1) * d;
    this.clipEnabled = true;
  }

  override writeProjectionMatrix(out: Float32Array, aspect = this.aspect, reverseZ = this.reverseZ): Float32Array {
    super.writeProjectionMatrix(out, aspect, reverseZ);
    if (!this.clipEnabled) return out;
    mat4.inverse(out, this.inverseProjection);
    const plane = this.clipPlaneView;
    const clipX = plane[0]! >= 0 ? 1 : -1;
    const clipY = plane[1]! >= 0 ? 1 : -1;
    const clipZ = reverseZ ? 0 : 1;
    const inverse = this.inverseProjection;
    const qx = (inverse[0] ?? 0) * clipX + (inverse[4] ?? 0) * clipY + (inverse[8] ?? 0) * clipZ + (inverse[12] ?? 0);
    const qy = (inverse[1] ?? 0) * clipX + (inverse[5] ?? 0) * clipY + (inverse[9] ?? 0) * clipZ + (inverse[13] ?? 0);
    const qz = (inverse[2] ?? 0) * clipX + (inverse[6] ?? 0) * clipY + (inverse[10] ?? 0) * clipZ + (inverse[14] ?? 0);
    const qw = (inverse[3] ?? 0) * clipX + (inverse[7] ?? 0) * clipY + (inverse[11] ?? 0) * clipZ + (inverse[15] ?? 0);
    const denominator = (plane[0] ?? 0) * qx + (plane[1] ?? 0) * qy + (plane[2] ?? 0) * qz + (plane[3] ?? 0) * qw;
    if (Math.abs(denominator) <= 1e-8) return out;
    const row3DotQ = (out[3] ?? 0) * qx + (out[7] ?? 0) * qy + (out[11] ?? 0) * qz + (out[15] ?? 0) * qw;
    const scale = row3DotQ / denominator;
    for (let column = 0; column < 4; column++) {
      const row2 = column * 4 + 2;
      const planeValue = plane[column] ?? 0;
      out[row2] = reverseZ ? (out[row2 + 1] ?? 0) - planeValue * scale : planeValue * scale;
    }
    return out;
  }
}

function reflectDirection(vector: Float32Array, nx: number, ny: number, nz: number): void {
  const dot = (vector[0] ?? 0) * nx + (vector[1] ?? 0) * ny + (vector[2] ?? 0) * nz;
  vector[0] = (vector[0] ?? 0) - 2 * dot * nx;
  vector[1] = (vector[1] ?? 0) - 2 * dot * ny;
  vector[2] = (vector[2] ?? 0) - 2 * dot * nz;
}

function normalize3(vector: Float32Array): void {
  const length = Math.hypot(vector[0] ?? 0, vector[1] ?? 0, vector[2] ?? 0) || 1;
  vector[0] = (vector[0] ?? 0) / length;
  vector[1] = (vector[1] ?? 0) / length;
  vector[2] = (vector[2] ?? 0) / length;
}

function cross3(a: Float32Array, b: Float32Array, out: Float32Array): void {
  const ax = a[0] ?? 0;
  const ay = a[1] ?? 0;
  const az = a[2] ?? 0;
  const bx = b[0] ?? 0;
  const by = b[1] ?? 0;
  const bz = b[2] ?? 0;
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
}

function nextGeneration(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function generationAge(current: number, previous: number): number {
  return current >= previous ? current - previous : (0xffff_ffff - previous) + current + 1;
}
