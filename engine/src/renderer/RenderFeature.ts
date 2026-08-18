import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { World } from '../ecs/World';
import type { RenderPipelineEntryOptions } from './RenderPipeline';

export interface RenderPassContributor {
  readonly name?: string;
  readonly renderPipelineOptions?: RenderPipelineEntryOptions;
  record(world: World, context: RenderCommandContext): unknown;
}

export interface DeltaRenderPassContributor {
  readonly name?: string;
  readonly renderPipelineOptions?: RenderPipelineEntryOptions;
  record(world: World, delta: number, context: RenderCommandContext): unknown;
}

export type RendererFeature = RenderPassContributor | DeltaRenderPassContributor;
