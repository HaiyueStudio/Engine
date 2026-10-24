import {AnimationVisual2D} from '../AnimationVisual2D.js';
import type {Entity, World} from '@haiyue/engine/ecs';
import {Camera2D} from '@haiyue/engine/components';
import type {IEngine} from '@haiyue/engine/extension-authoring';
import {compute2DViewProjection} from '../../utils/camera2d.js';
import type {StateMachinePose} from '../../hya-state-machine/v2/runtime-types.js';
import type {ProductionCoreStateVisualRuntime} from './ProductionCoreStateVisualRuntime.js';
import {compileProductionCoreDrawPlan, type ProductionCoreDrawOptions} from './ProductionCoreDrawPlan.js';
import type {ProductionDrawOwner} from '../layout/production/ProductionDrawOwner.js';
import {ProductionFrameError, type PreparedProductionFrameStep, type ProductionFrameContext, type ProductionFrameStage} from './FrameTransaction.js';

export interface ProductionCoreFrameStageOptions extends Omit<ProductionCoreDrawOptions, 'viewport' | 'dpr'> {
  readonly stateStages: readonly string[];
  /** The existing composition/transport owner is the clock. This stage never advances another clock. */
  readonly time: (context: ProductionFrameContext) => number;
  readonly resourceRevision?: () => string;
  /** The original resource owner must throw its named pending/error before visual preparation. */
  readonly resourcesReady?: () => void;
}

/** Borrows the original sampler/state/draw owners and joins their existing whole-frame barrier. */
export class ProductionCoreFrameStage implements ProductionFrameStage {
  readonly phase = 'geometry-draw' as const;
  private readonly options: ProductionCoreFrameStageOptions;
  private readonly identity = Object.freeze({});
  private pending: PreparedProductionFrameStep | undefined;
  private preparing = false;
  private disposed = false;
  private committedTime: number | undefined;
  constructor(readonly id: string, private readonly runtime: ProductionCoreStateVisualRuntime, private readonly world: World,
    private readonly camera: Entity, private readonly engine: IEngine, private readonly draw: ProductionDrawOwner, options: ProductionCoreFrameStageOptions) {
    if (!id || new Set(options.stateStages).size !== options.stateStages.length || options.stateStages.some(id => typeof id !== 'string' || !id)
      || typeof options.time !== 'function') throw new ProductionFrameError('E_HYA_RUNTIME_STAGE', id, 'core stage needs its explicit clock and unique upstream state stages');
    this.options = Object.freeze({...options, stateStages: Object.freeze([...options.stateStages])});
  }
  prepare(context: ProductionFrameContext): PreparedProductionFrameStep {
    this.live(); if (this.preparing || this.pending) throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT', this.id, 'core stage already has a preparation');
    this.preparing = true; let step: PreparedProductionFrameStep | undefined;
    try {
      this.prepareResources();
      if (this.world.destroyed || this.world.disabled) throw new ProductionFrameError('E_HYA_RUNTIME_DRAW', '$.core.world', 'core frame source world is not active');
      const poses = this.options.stateStages.flatMap(id => {
        const value = context.values.get(id);
        if (!Array.isArray(value)) throw new ProductionFrameError('E_HYA_RUNTIME_STAGE', id, 'the upstream state frame was not prepared');
        return value as readonly StateMachinePose[];
      });
      const time = this.options.time(context); this.live();
      this.runtime.applyAuthoredMixedChannels(poses.flatMap(pose => pose.channels), time);
      // Authored/state visibility can materialize text or images for the first time here.
      // Never publish the fallback glyph/texture made before that original font/image finishes.
      this.prepareResources();
      this.world.frameData.begin(this.world, this.engine, context.request.sequence, 0);
      const camera = this.camera.getComponent(Camera2D);
      if (!camera) throw new ProductionFrameError('E_HYA_RUNTIME_DRAW', '$.core.camera', 'core stage lost its 2D camera');
      const projection = [...compute2DViewProjection(this.engine, this.camera, camera)];
      const resources = this.options.resourceRevision?.() ?? ''; this.live();
      const revision = JSON.stringify([context.request.viewport, context.request.dpr, projection, resources, [...this.world.entities.values()].map(entity => {
        const visual = entity.getComponent(AnimationVisual2D);
        return [entity.id, entity.disabled, [...this.world.frameData.getWorldMatrix2D(entity)], visual ? [visual.revision, visual.geometry.id, visual.geometry.version, visual.textMaterial?.textureVersion] : null];
      })]);
      step = this.draw.preparePlan(this.identity, revision, () => compileProductionCoreDrawPlan(this.world, this.camera, this.engine,
        {...this.options, viewport: context.request.viewport, dpr: context.request.dpr}));
      this.live(); let closed = false;
      const prepared = Object.freeze({value: Object.freeze({time, generation: step.value}), commit: () => {
        if (closed) return; closed = true; this.pending = undefined; step!.commit(); this.committedTime = time;
      }, rollback: () => {if (closed) return; closed = true; this.pending = undefined; step!.rollback();},
      finalize: () => step!.finalize?.(), publish: () => step!.publish?.()});
      this.pending = prepared; return prepared;
    } catch (error) {try {step?.rollback();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Core frame preparation and draw rollback failed');} throw error;}
    finally {this.preparing = false;}
  }
  get lastCommittedTime(): number | undefined {return this.committedTime;}
  private prepareResources(): void {
    this.options.resourcesReady?.(); this.live();
    this.runtime.assertCoreResourcesReady();
    if (this.runtime.stats.failedResourceCount) throw new ProductionFrameError('E_HYA_RUNTIME_RESOURCE', '$.core.resources', 'original core resource preparation failed');
    if (this.runtime.stats.pendingResourceCount) throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT', '$.core.resources', 'a core resource readiness port must await original pending resources');
  }
  dispose(): void {if (this.disposed) return; this.disposed = true; const step = this.pending; this.pending = undefined; step?.rollback();}
  private live(): void {if (this.disposed) throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', this.id, 'core frame stage is disposed');}
}
