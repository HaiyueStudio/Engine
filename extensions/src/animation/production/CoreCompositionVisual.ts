import type {ParsedAnimation} from '@haiyue/animation-spec';
import type {World, Entity} from '@haiyue/engine/ecs';
import type {IEngine} from '@haiyue/engine/extension-authoring';
import {Camera2D} from '@haiyue/engine/components';
import {AnimationVisual2D} from '../AnimationVisual2D.js';
import {compute2DViewProjection} from '../../utils/camera2d.js';
import type {RuntimeChannel, StateMachinePose} from '../../hya-state-machine/v2/runtime-types.js';
import {ProductionFrameError, type ProductionFrameRequest} from './FrameTransaction.js';
import type {ProductionDrawPlan} from '../layout/production/ProductionDrawPlan.js';
import {compileProductionCoreDrawPlan, type ProductionCoreDrawOptions} from './ProductionCoreDrawPlan.js';
import type {ProductionCoreStateVisualRuntime} from './ProductionCoreStateVisualRuntime.js';

export interface PreparedCompositionCore {readonly revision: string; compile(): ProductionDrawPlan;}
export interface ProductionCompositionCore {
  prepare(time: number, channels: StateMachinePose['channels'], request: ProductionFrameRequest): PreparedCompositionCore;
  dispose(): void;
}
/** Internal render adapter. Pure evaluation will use its original sampler port, not instantiate this adapter. */
export type ProductionCompositionCoreFactory = (animation: ParsedAnimation, channels: readonly RuntimeChannel[], part: string) => ProductionCompositionCore;

/** A working original core evaluator behind the immutable committed draw generation. No additional clock or draw owner. */
export class ProductionCoreCompositionVisual implements ProductionCompositionCore {
  private disposed = false;
  constructor(private readonly runtime: ProductionCoreStateVisualRuntime, private readonly world: World, private readonly camera: Entity,
    private readonly engine: IEngine, private readonly options: Omit<ProductionCoreDrawOptions, 'viewport' | 'dpr'>,
    private readonly release: () => void) {}
  prepare(time: number, channels: StateMachinePose['channels'], request: ProductionFrameRequest): PreparedCompositionCore {
    this.live(); this.runtime.assertCoreResourcesReady();
    this.runtime.applyAuthoredMixedChannels(channels, time); this.runtime.assertCoreResourcesReady();
    if (this.world.destroyed || this.world.disabled) throw new ProductionFrameError('E_HYA_RUNTIME_DRAW', '$.core.world', 'core source world is not active');
    this.world.frameData.begin(this.world, this.engine, request.sequence, 0);
    const camera = this.camera.getComponent(Camera2D);
    if (!camera) throw new ProductionFrameError('E_HYA_RUNTIME_DRAW', '$.core.camera', 'the original 2D camera is required');
    const revision = JSON.stringify([request.viewport, request.dpr, [...compute2DViewProjection(this.engine, this.camera, camera)], [...this.world.entities.values()].map(entity => {
      const visual = entity.getComponent(AnimationVisual2D);
      return [entity.id, entity.disabled, [...this.world.frameData.getWorldMatrix2D(entity)], visual ? [visual.revision, visual.geometry.id, visual.geometry.version, visual.textMaterial?.textureVersion] : null];
    })]);
    // The callback is private and only valid during this synchronous draw preparation.
    return Object.freeze({revision, compile: () => {this.live(); return compileProductionCoreDrawPlan(this.world, this.camera, this.engine, {...this.options, viewport: request.viewport, dpr: request.dpr});}});
  }
  dispose(): void {if (this.disposed) return; this.disposed = true; this.release();}
  private live(): void {if (this.disposed) throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core', 'core composition visual is disposed');}
}
