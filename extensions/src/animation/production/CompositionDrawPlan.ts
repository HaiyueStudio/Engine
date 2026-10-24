import {AnimationVisual2D} from '../AnimationVisual2D.js';
import {ProductionDrawError, type ProductionDrawPlan} from '../layout/production/ProductionDrawPlan.js';

/** Merges original core/layout plans into one generation; namespaces masks without interpreting opaque node IDs. */
export function compileProductionCompositionDrawPlan(sources: readonly (() => ProductionDrawPlan)[], maxGeometryBytes = 512 * 1024 * 1024): ProductionDrawPlan {
  const plans: ProductionDrawPlan[] = [], visuals: AnimationVisual2D[] = [], maskSources: string[] = [];
  let bytes = 0, released = false, instance = 0;
  const release = (): void => {if (released) return; released = true; const errors: unknown[] = []; for (const plan of plans) try {plan.release();} catch (error) {errors.push(error);} if (errors.length) throw new AggregateError(errors, 'Composition plan lease release failed');};
  try {
    if (!sources.length || !Number.isSafeInteger(maxGeometryBytes) || maxGeometryBytes < 0) throw new ProductionDrawError('E_HYA_RUNTIME_LIMIT', '$.draw', 'one or more sources and a valid geometry ceiling are required');
    for (const source of sources) {
      const plan = source(); plans.push(plan); plan.assertReady();
      const first = plans[0]!;
      if (plan.dpr !== first.dpr || plan.viewport.some((value, index) => value !== first.viewport[index])) throw new ProductionDrawError('E_HYA_RUNTIME_DRAW', '$.draw', 'composition sources must share their viewport and DPR');
      bytes += plan.geometryBytes;
      if (!Number.isSafeInteger(bytes) || bytes > maxGeometryBytes) throw new ProductionDrawError('E_HYA_RUNTIME_LIMIT', '$.draw.geometryBytes', 'composed geometry exceeds the shared ceiling');
      const identities = new Map<number, number>();
      const scoped = (id: number): number => {let value = identities.get(id); if (value === undefined) {value = instance++; identities.set(id, value);} return value;};
      for (const key of plan.maskSources ?? []) {
        const separator = key.indexOf(':'), original = Number(key.slice(0, separator));
        if (separator < 1 || !Number.isSafeInteger(original)) throw new ProductionDrawError('E_HYA_RUNTIME_DRAW', '$.draw.masks', 'invalid original mask key');
        maskSources.push(`${scoped(original)}:${key.slice(separator + 1)}`);
      }
      for (const source of [...plan.visuals].sort((a, b) => a.order - b.order)) {
        const visual = source.clone();
        visuals.push(new AnimationVisual2D({geometry: visual.geometry, color: visual.color, multiplyColor: visual.multiplyColor, screenColor: visual.screenColor,
          instanceId: scoped(source.instanceId), nodeId: source.nodeId, order: visuals.length, blendMode: visual.blendMode, culling: visual.culling,
          sourceOnly: visual.sourceOnly, textureAlphaMode: visual.textureAlphaMode, texture: visual.texture, textureHandle: visual.textureHandle,
          textMaterial: visual.textMaterial, requiresTexture: visual.requiresTexture, uvRect: visual.uvRect, gradient: visual.gradient, effects: visual.effects,
          ...(visual.uvs ? {uvs: visual.uvs} : {}), ...(visual.textureSampling ? {textureSampling: visual.textureSampling} : {}),
          ...(visual.localTransform ? {localTransform: visual.localTransform} : {}), ...(source.compositeLayers.length ? {composite: {layers: source.compositeLayers}} : {})}));
      }
    }
    return Object.freeze({viewport: plans[0]!.viewport, dpr: plans[0]!.dpr, geometryBytes: bytes, visuals: Object.freeze(visuals), maskSources: Object.freeze(maskSources), release,
      assertReady() {if (released) throw new ProductionDrawError('E_HYA_RUNTIME_DISPOSED', '$.draw', 'composition plan was released'); for (const plan of plans) plan.assertReady();}});
  } catch (error) {try {release();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Composition plan preparation and cleanup failed');} throw error;}
}
