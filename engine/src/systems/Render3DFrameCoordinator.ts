import type { Camera3D } from '../components/Camera3D';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { RenderViewSnapshot } from '../core/RenderView';
import type { World } from '../ecs/World';
import type { Camera3DFrameData, FrameData } from '../frame/FrameData';
import type { SceneRenderEnvironment } from '../frame/SceneRenderEnvironment';
import type { PostProcessPass } from '../postprocess/PostProcessPass';
import type { Render3DPostSceneRequirements } from './Render3DPostScenePasses';
import {
  Render3DFramePlan,
  type Render3DFramePassSnapshot,
} from './Render3DFramePlan';
import type { WorldFrameState } from './Render3DFrameState';

interface CollectPassNameCacheEntry {
  name: string;
  lastSeenFrame: number;
}

export interface Render3DViewExecutionState {
  world: World;
  context: RenderCommandContext;
  camera: Camera3D;
  cameraEntityId: number;
  cameraFrame: Camera3DFrameData;
  postProcessPasses: PostProcessPass[];
  postSceneRequirements: Render3DPostSceneRequirements;
  frameView: RenderViewSnapshot;
  worldFrameState: WorldFrameState;
  sceneEnvironment: SceneRenderEnvironment;
  cameraPosition: Float32Array;
  uniformSlot: number;
  viewportWidth: number;
  viewportHeight: number;
  camWorldMatrix: Float32Array;
}

export interface Render3DSceneGlobalExecutionState {
  context: RenderCommandContext;
  frameData: FrameData;
  worldFrameState: WorldFrameState;
  sceneEnvironment: SceneRenderEnvironment;
}

export interface Render3DFrameStageActions {
  collectView(): void;
  sortRenderItems(): void;
  prepareGpuDrivenBatches(): void;
  sortTransparentOnGpu(): void;
  preparePbrLighting(): void;
  renderScene(): void;
  renderPostScene(): void;
  renderDirectionalShadow(): void;
}

const EMPTY_POST_PROCESS_PASSES: PostProcessPass[] = [];

/**
 * Sole owner of per-frame/view execution state and pass-plan storage.
 * Render3DSystem chooses inputs; this coordinator fixes stage ordering and
 * executes caller-owned stage implementations without owning render resources.
 */
export class Render3DFrameCoordinator {
  readonly viewPlan = new Render3DFramePlan();
  readonly sceneGlobalPlan = new Render3DFramePlan();
  private readonly viewStatePool: Render3DViewExecutionState[] = [];
  private viewStateDepth = 0;
  readonly sceneGlobalState: Render3DSceneGlobalExecutionState = {
    context: null as unknown as RenderCommandContext,
    frameData: null as unknown as FrameData,
    worldFrameState: null as unknown as WorldFrameState,
    sceneEnvironment: null as unknown as SceneRenderEnvironment,
  };

  private readonly _collectPassNames = new Map<string, CollectPassNameCacheEntry>();

  constructor(private readonly _actions: Render3DFrameStageActions) {}

  get viewState(): Render3DViewExecutionState {
    const state = this.viewStatePool[this.viewStateDepth - 1];
    if (!state) throw new Error('Render3DFrameCoordinator has no active view state.');
    return state;
  }

  get snapshot(): readonly Render3DFramePassSnapshot[] {
    return this.viewPlan.snapshot;
  }

  /** @internal Compatibility seam for cache-bound diagnostics. */
  get collectPassNames(): ReadonlyMap<string, CollectPassNameCacheEntry> {
    return this._collectPassNames;
  }

  beginFrame(): void {
    this.viewPlan.clear();
    this.sceneGlobalPlan.clear();
  }

  setSceneGlobalState(
    context: RenderCommandContext,
    frameData: FrameData,
    worldFrameState: WorldFrameState,
    sceneEnvironment: SceneRenderEnvironment,
  ): void {
    const state = this.sceneGlobalState;
    state.context = context;
    state.frameData = frameData;
    state.worldFrameState = worldFrameState;
    state.sceneEnvironment = sceneEnvironment;
  }

  executeSceneGlobal(hasDirectionalShadowPass: boolean): void {
    this.sceneGlobalPlan.clear();
    if (hasDirectionalShadowPass) {
      this.sceneGlobalPlan.add(
        'render-directional-shadow',
        'render',
        this._actions.renderDirectionalShadow,
      );
    }
    this.sceneGlobalPlan.execute();
  }

  executeView(
    world: World,
    context: RenderCommandContext,
    camera: Camera3D,
    cameraEntityId: number,
    cameraFrame: Camera3DFrameData,
    postProcessPasses: PostProcessPass[],
    postSceneRequirements: Render3DPostSceneRequirements,
    frameView: RenderViewSnapshot,
    worldFrameState: WorldFrameState,
    camWorldMatrix: Float32Array,
    sceneEnvironment: SceneRenderEnvironment,
    cameraPosition: Float32Array,
    uniformSlot: number,
    viewportWidth: number,
    viewportHeight: number,
    liveFrame: number,
  ): void {
    const depth = this.viewStateDepth++;
    const state = this.viewStatePool[depth] ?? createViewExecutionState();
    this.viewStatePool[depth] = state;
    state.world = world;
    state.context = context;
    state.camera = camera;
    state.cameraEntityId = cameraEntityId;
    state.cameraFrame = cameraFrame;
    state.postProcessPasses = postProcessPasses;
    state.postSceneRequirements = postSceneRequirements;
    state.frameView = frameView;
    state.worldFrameState = worldFrameState;
    state.camWorldMatrix = camWorldMatrix;
    state.sceneEnvironment = sceneEnvironment;
    state.cameraPosition = cameraPosition;
    state.uniformSlot = uniformSlot;
    state.viewportWidth = viewportWidth;
    state.viewportHeight = viewportHeight;

    let collectPass = this._collectPassNames.get(frameView.key);
    if (!collectPass) {
      collectPass = {
        name: `collect-view:${frameView.key}`,
        lastSeenFrame: liveFrame,
      };
      this._collectPassNames.set(frameView.key, collectPass);
    }
    collectPass.lastSeenFrame = liveFrame;
    try {
      this.viewPlan.clear()
        .add(collectPass.name, 'prepare', this._actions.collectView)
        .add('sort-render-items', 'prepare', this._actions.sortRenderItems)
        .add(
          'prepare-gpu-driven-batches',
          'compute',
          this._actions.prepareGpuDrivenBatches,
        )
        .add(
          'sort-transparent-on-gpu',
          'compute',
          this._actions.sortTransparentOnGpu,
        )
        .add('prepare-pbr-lighting', 'prepare', this._actions.preparePbrLighting)
        .add('render-scene-pass', 'render', this._actions.renderScene)
        .add(
          'render-post-scene-passes',
          'postprocess',
          this._actions.renderPostScene,
        )
        .execute();
    } finally {
      resetViewExecutionState(state);
      this.viewStateDepth--;
    }
  }

  sweepViewCaches(liveFrame: number): void {
    for (const [viewKey, entry] of this._collectPassNames) {
      if (entry.lastSeenFrame !== liveFrame) this._collectPassNames.delete(viewKey);
    }
  }

  clearViewCaches(): void {
    this._collectPassNames.clear();
  }
}

function createViewExecutionState(): Render3DViewExecutionState {
  return {
    world: null as unknown as World,
    context: null as unknown as RenderCommandContext,
    camera: null as unknown as Camera3D,
    cameraEntityId: 0,
    cameraFrame: null as unknown as Camera3DFrameData,
    postProcessPasses: EMPTY_POST_PROCESS_PASSES,
    postSceneRequirements: null as unknown as Render3DPostSceneRequirements,
    frameView: null as unknown as RenderViewSnapshot,
    worldFrameState: null as unknown as WorldFrameState,
    sceneEnvironment: null as unknown as SceneRenderEnvironment,
    cameraPosition: null as unknown as Float32Array,
    uniformSlot: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    camWorldMatrix: null as unknown as Float32Array,
  };
}

function resetViewExecutionState(state: Render3DViewExecutionState): void {
  state.world = null as unknown as World;
  state.context = null as unknown as RenderCommandContext;
  state.camera = null as unknown as Camera3D;
  state.cameraFrame = null as unknown as Camera3DFrameData;
  state.postProcessPasses = EMPTY_POST_PROCESS_PASSES;
  state.postSceneRequirements = null as unknown as Render3DPostSceneRequirements;
  state.frameView = null as unknown as RenderViewSnapshot;
  state.worldFrameState = null as unknown as WorldFrameState;
  state.sceneEnvironment = null as unknown as SceneRenderEnvironment;
  state.cameraPosition = null as unknown as Float32Array;
  state.camWorldMatrix = null as unknown as Float32Array;
}
