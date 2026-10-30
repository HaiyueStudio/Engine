import type {AnimationVisual2D} from '../../AnimationVisual2D.js';
import type {ProductionDrawPlan} from './ProductionDrawPlan.js';

/** Compare immutable storage, never a mutable author's revision or an approximate hash. */
function same(a: ArrayLike<number> | null, b: ArrayLike<number> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length || a.constructor !== b.constructor) return false;
  for (let index=0;index<a.length;index++) if (!Object.is(a[index],b[index])) return false;
  return true;
}

/** Only the immediately committed plan is retained; retired generations own their original leases. */
export function reuseProductionDrawStorage(plan: ProductionDrawPlan, previous?: ProductionDrawPlan): ProductionDrawPlan {
  if (!previous) return plan;
  const old = new Map<string, AnimationVisual2D>();
  const duplicates = new Set<string>();
  for (const visual of previous.visuals) {
    if (old.has(visual.nodeKey)) duplicates.add(visual.nodeKey);
    old.set(visual.nodeKey,visual);
  }
  const visuals = plan.visuals.map(visual => {
    const prior = old.get(visual.nodeKey);
    if (!prior || duplicates.has(visual.nodeKey) || !same(visual.geometry.positions,prior.geometry.positions)
      || !same(visual.geometry.indices,prior.geometry.indices)) return visual;
    return visual.clone({geometry:prior.geometry,...(visual.uvs && same(visual.uvs,prior.uvs) ? {uvs:prior.uvs!} : {})});
  });
  return {...plan,visuals};
}
