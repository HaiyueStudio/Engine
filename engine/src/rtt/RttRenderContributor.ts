import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { World } from '../ecs/World';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import type { DeltaRenderPassContributor } from '../renderer/RenderFeature';
import type { RttTexture } from './RttTexture';

export interface RttRenderContributorOptions {
  sort?: number;
}

/**
 * RenderPipeline contributor that updates an RTT world before later passes
 * sample its texture.
 */
export class RttRenderContributor implements DeltaRenderPassContributor {
  readonly name = 'RttRenderContributor';
  readonly renderPipelineOptions: RenderPipelineEntryOptions;

  constructor(
    readonly rtt: RttTexture,
    options: RttRenderContributorOptions = {},
  ) {
    this.renderPipelineOptions = {
      passType: 'compute',
      recordMode: 'delta',
      sort: options.sort ?? -1000,
    };
  }

  record(_world: World, delta: number, _context: RenderCommandContext): void {
    this.rtt.render(performance.now(), delta);
  }
}
