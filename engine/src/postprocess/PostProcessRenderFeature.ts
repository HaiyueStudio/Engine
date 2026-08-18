import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import type { RenderPassContributor } from '../renderer/RenderFeature';
import type { Render3DSystem } from '../systems/Render3DSystem';
import type { PostProcessPass } from './PostProcessPass';

export interface PostProcessRenderFeatureOptions {
  sort?: number;
}

/**
 * Declarative post-process pipeline entry.
 *
 * Render3DSystem still owns scene texture allocation and post-process execution,
 * but this feature makes the post-process dependency explicit in RenderPipeline.
 */
export class PostProcessRenderFeature extends System implements RenderPassContributor {
  readonly renderPipelineOptions: RenderPipelineEntryOptions;
  readonly passes: PostProcessPass[] = [];

  constructor(
    private readonly renderSystem: Render3DSystem,
    passes: Iterable<PostProcessPass> = [],
    options: PostProcessRenderFeatureOptions = {},
  ) {
    super(() => false);
    this.name = 'PostProcessRenderFeature';
    this.priority = options.sort ?? renderSystem.priority;
    this.renderPipelineOptions = {
      passType: 'compute',
      sort: this.priority,
    };
    this.renderSystem.requiresIsolatedPass = true;
    this.setPasses(passes);
  }

  setPasses(passes: Iterable<PostProcessPass>): this {
    this.passes.length = 0;
    for (const pass of passes) this.passes.push(pass);
    this.renderSystem.passes = this.passes;
    return this;
  }

  record(_world: World, _context: RenderCommandContext): this {
    if (this.renderSystem.passes !== this.passes) {
      this.renderSystem.passes = this.passes;
    }
    return this;
  }
}
