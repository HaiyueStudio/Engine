import {ProductionFrameError, type PreparedProductionFrameStep} from './FrameTransaction.js';
import type {ProductionCompositionFrame} from './CompositionOwner.js';
import type {PreparedCompositionCore} from './CoreCompositionVisual.js';
import type {ProductionDrawOwner} from '../layout/production/ProductionDrawOwner.js';
import {compileProductionDrawPlan, type ProductionDrawTextures} from '../layout/production/ProductionDrawPlan.js';
import {compileProductionCompositionDrawPlan} from './CompositionDrawPlan.js';

/** One borrowed generation owner for every core/layout part in the compiled painter order. */
export class ProductionCompositionDrawAdapter {
  private readonly identity = Object.freeze({});
  private readonly parts: readonly Readonly<{id: string; kind: 'core' | 'layout'}>[];
  private preparing = false;
  constructor(private readonly draw: ProductionDrawOwner, parts: readonly Readonly<{id: string; kind: 'core' | 'layout'}>[],
    private readonly textures?: ProductionDrawTextures, private readonly maxGeometryBytes = 512 * 1024 * 1024) {
    if (!parts.length || parts.length > 16 || new Set(parts.map(part => part.id)).size !== parts.length || parts.some(part => !part.id || !['core', 'layout'].includes(part.kind))
      || !Number.isSafeInteger(maxGeometryBytes) || maxGeometryBytes < 0 || maxGeometryBytes > 512 * 1024 * 1024) throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.draw.parts', 'invalid compiled painter order or geometry ceiling');
    this.parts = Object.freeze(parts.map(part => Object.freeze({...part})));
  }
  prepare(frame: ProductionCompositionFrame, cores: ReadonlyMap<string, PreparedCompositionCore>): PreparedProductionFrameStep {
    if (this.preparing) throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT', '$.draw', 'composition draw preparation is already active');
    this.preparing = true;
    try {
      if (Object.keys(frame.layouts).length + cores.size !== this.parts.length) throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE', '$.draw.parts', 'every visual part must have one draw adapter');
      const layouts = this.parts.flatMap(part => part.kind === 'layout' ? [frame.layouts[part.id]!] : []);
      for (const part of this.parts) if (part.kind === 'core' ? !cores.has(part.id) : !frame.layouts[part.id]) throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE', part.id, 'compiled visual source is absent');
      this.textures?.prepare?.(layouts);
      const revision = JSON.stringify([this.textures?.revision ?? 0, this.parts.map(part => [part.id, part.kind === 'core' ? cores.get(part.id)!.revision : frame.layouts[part.id]!.revision])]);
      return this.draw.preparePlan(this.identity, revision, () => compileProductionCompositionDrawPlan(this.parts.map(part => part.kind === 'core'
        ? () => cores.get(part.id)!.compile() : () => compileProductionDrawPlan([frame.layouts[part.id]!], this.textures, this.maxGeometryBytes)), this.maxGeometryBytes));
    } finally {this.preparing = false;}
  }
}
