import type {IEngine} from '../../core/IEngine';
import type {RenderFrameContext,RenderFrameContextOptions} from '../../core/RenderCommandContext';
import type {RenderRegion} from '../../core/RenderRegion';
import type {World} from '../../ecs/World';
import type {WorldFrameToken} from '../../frame/FrameData';
import type {RenderPipelineSystem} from '../RenderPipeline';
import {RegionPipeline} from './RegionPipeline';

/** Private execution boundary: the outer pipeline never owns regional attachments or GUI state. */
export interface RegionPipelineEntry {
  readonly id:number;readonly system:RenderPipelineSystem;readonly region:RenderRegion|undefined;
  readonly type:'render'|'compute';readonly depth:boolean;
  readonly pass:'shared'|'isolated';
  readonly depthLoadOp?:'clear'|'load'|undefined;readonly depthStoreOp?:'store'|'discard'|undefined;
}
export interface RegionPipelineStats {
  readonly updates:number;readonly producerRecords:number;readonly compositeDraws:number;readonly presentations:number;
  readonly cropCopies:number;
  readonly compositionSamples:0|1|4;
  /** Device-wide accounting includes other views and pending retirement. */
  readonly retainedColorBytes:number;
  /** Working color includes active allocation and pending retirement; never retained pixel-cache content. */
  readonly workingColorBytes:number;readonly workingRetiringColorBytes:number;
  /** Estimated regional depth and color+depth totals, including retirement. Host outputs and GUI resources are additional. */
  readonly regionDepthBytes:number;readonly totalRegionAttachmentBytes:number;
  readonly cachedRegions:number;readonly fallbacks:readonly string[];
}
export interface RegionExecution {
  readonly stats:RegionPipelineStats;
  execute<T extends RegionPipelineEntry>(world:World,time:number,delta:number,options:RenderFrameContextOptions&{context?:RenderFrameContext;regionCache?:boolean;frameToken?:WorldFrameToken|undefined},entries:readonly T[],record:(entry:T,context:RenderFrameContext)=>void):RenderFrameContext;
  destroy(abandon?:boolean):void;
}
export function createRegionExecution(engine:IEngine):RegionExecution {return new RegionPipeline(engine);}
