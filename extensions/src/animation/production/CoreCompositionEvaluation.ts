import {Entity} from '@haiyue/engine/ecs';
import {Transform2D} from '@haiyue/engine/components';
import type {ParsedAnimation,AnimationText2DComponent} from '@haiyue/animation-spec';
import type {RuntimeChannel, StateMachinePose} from '../../hya-state-machine/v2/runtime-types.js';
import type {Animation2DCoreResourcePort} from '../Animation2DRuntime.js';
import {ProductionCoreStateVisualRuntime} from './ProductionCoreStateVisualRuntime.js';
import type {ProductionCompositionCore, PreparedCompositionCore} from './CoreCompositionVisual.js';
import {ProductionFrameError, type ProductionFrameRequest} from './FrameTransaction.js';

/** Same core sampler, mixed-channel writer and CPU tessellator; no World, camera, Engine or upload owner. */
class EvaluationRuntime extends ProductionCoreStateVisualRuntime {
  protected override get _rasterizeCoreText(): boolean {return false;}
  protected override get _materializeCoreFontFace(): boolean {return false;}
  protected override get _materializeCoreImages(): boolean {return false;}
  evaluate(time: number, channels: StateMachinePose['channels']) {
    this.assertCoreResourcesReady();
    this.applyAuthoredMixedChannels(channels, time);
    this.assertCoreResourcesReady();
    if (this.stats.unsupportedComponentCount)
      throw new ProductionFrameError('E_HYA_RUNTIME_CAPABILITY', '$.core', 'core evaluation contains an unsupported component');
    return this._nodes.map(node => ({
      id: node.source.id, parent: node.source.parent ?? null, active: this._isNodeActive(node),
      transform: [node.transform.x, node.transform.y, node.transform.rotation, node.transform.scaleX, node.transform.scaleY],
      opacity: this._resolveOpacity(node),
      visuals: node.visuals.map(visual => ({
        component: visual.sourceComponentIndex, resource: (node.source.components?.[visual.sourceComponentIndex] as {resource?:string}|undefined)?.resource ?? null, order: visual.component.order,
        positions: [...visual.component.geometry.positions], indices: visual.component.geometry.indices ? [...visual.component.geometry.indices] : null,
        color: [...visual.color], uv: [...visual.component.uvRect],
        gradient: visual.component.gradient, effects: visual.component.effects,
        text: visual.textRasterizer?.evaluateDocument(time) ?? null,
        glyphLayout: visual.textRasterizer&&hasFont(node.source.components?.[visual.sourceComponentIndex])?visual.textRasterizer.evaluateOutlineGlyphLayout(time):null
      }))
    }));
  }
}

export class ProductionCoreCompositionEvaluation implements ProductionCompositionCore {
  private readonly root = new Entity('HYA CPU evaluation').addComponent(new Transform2D());
  private readonly runtime: EvaluationRuntime;
  private disposed = false;
  constructor(animation: ParsedAnimation, channels: readonly RuntimeChannel[], resources?: Animation2DCoreResourcePort, private readonly release:()=>void=()=>{}, invalidate?:()=>void) {
    try {this.runtime = new EvaluationRuntime(this.root, animation, channels,undefined,undefined,resources);this.runtime.setCoreResourceInvalidation(invalidate);}
    catch (error) {try{this.release();}finally{this.root.destroy();}throw error;}
  }
  prepare(time: number, channels: StateMachinePose['channels'], _request: ProductionFrameRequest): PreparedCompositionCore & {readonly evaluation: unknown} {
    this.live();
    // Serialize the actual evaluated values, rather than time, sequence or mutable revision counters.
    const revision = JSON.stringify(this.runtime.evaluate(time, channels));
    const evaluation: unknown = JSON.parse(revision);
    const freeze = (value: unknown): void => {if(value && typeof value === 'object') {for(const child of Object.values(value)) freeze(child);Object.freeze(value);}};
    freeze(evaluation);
    return Object.freeze({revision, evaluation, compile: () => {
      this.live();
      throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT', '$.core.draw', 'CPU evaluation cannot provide a draw plan; select render mode with a real Scene');
    }});
  }
  dispose(): void {if(this.disposed)return;this.disposed=true;try{this.runtime.destroy();}finally{try{this.release();}finally{this.root.destroy();}}}
  private live(): void {if(this.disposed)throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core', 'core evaluation is disposed');}
}

function hasFont(component:unknown):boolean {const text=component as AnimationText2DComponent|undefined;return text?.type==='text2d'&&!!(text.fontResource||text.documents?.some(d=>d.fontResource)||text.styleRuns?.some(run=>run.fontResource));}
