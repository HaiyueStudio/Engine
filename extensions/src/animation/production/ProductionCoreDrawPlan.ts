import {Geometry2D} from '@haiyue/engine/geometry';
import {Camera2D} from '@haiyue/engine/components';
import type {Entity, World} from '@haiyue/engine/ecs';
import {isEntityDisabledInHierarchyCached, type IEngine} from '@haiyue/engine/extension-authoring';
import {mat4} from 'wgpu-matrix';
import {compute2DViewProjection} from '../../utils/camera2d.js';
import {AnimationMaskSources} from '../AnimationMaskSources.js';
import {AnimationVisual2D} from '../AnimationVisual2D.js';
import {writeAnimationVisualMatrix} from '../AnimationVisualMatrix.js';
import type {AnimationTextBitmapSnapshot} from '../AnimationTextRasterizer.js';
import {ProductionDrawError, type ProductionDrawPlan, type ProductionDrawTexture, type ProductionDrawTextures} from '../layout/production/ProductionDrawPlan.js';
import {ProductionTexturePending} from '../layout/production/ProductionTextureOwner.js';

export interface ProductionCoreDrawOptions {
  readonly viewport: readonly [number, number]; readonly dpr: number;
  /** Explicit caller ceiling, including the original renderer's xy/uv/index upload representation. */
  readonly maxGeometryBytes: number;
  readonly textures?: Pick<ProductionDrawTextures, 'bitmap'>;
  /** Must acquire an independent ready lease; never return the runtime's borrowed handle. */
  readonly image?: (visual: AnimationVisual2D) => ProductionDrawTexture;
}
const fail = (code: string, path: string, message: string): never => {throw new ProductionDrawError(code, path, message);};

/** Copies evaluated core visuals into the existing draw-plan/generation owner, with no second renderer. */
export function compileProductionCoreDrawPlan(world: World, cameraEntity: Entity, engine: IEngine, options: ProductionCoreDrawOptions): ProductionDrawPlan {
  const viewport = Object.freeze([...options.viewport]) as readonly [number, number], dpr = options.dpr;
  if (viewport.length !== 2 || viewport.some(value => !Number.isFinite(value) || value <= 0) || !Number.isFinite(dpr) || dpr <= 0
    || !Number.isSafeInteger(options.maxGeometryBytes) || options.maxGeometryBytes < 0)
    fail('E_HYA_RUNTIME_LIMIT', '$.core.draw', 'invalid viewport, DPR or explicit geometry ceiling');
  if (world.destroyed || world.disabled) fail('E_HYA_RUNTIME_DRAW', '$.core.world', 'core source world is not active');
  const camera = cameraEntity.getComponent(Camera2D) ?? fail('E_HYA_RUNTIME_DRAW', '$.core.camera', 'core drawing requires its original 2D camera');
  const projection = compute2DViewProjection(engine, cameraEntity, camera), disabled = new Map();
  const visuals: AnimationVisual2D[] = [], maskSources = new Set<string>(), leases: ProductionDrawTexture[] = [];
  const bitmaps = new Map<object, ProductionDrawTexture>();
  let geometryBytes = 0, released = false;
  const release = (): void => {
    if (released) return; released = true; const errors: unknown[] = [];
    for (const value of leases) try {value.release();} catch (error) {errors.push(error);} leases.length = 0;
    if (errors.length) throw new AggregateError(errors, 'Core draw texture leases failed to release');
  };
  const acquire = (value: ProductionDrawTexture): ProductionDrawTexture => {
    if (value && typeof value.release === 'function') leases.push(value);
    if (!value || typeof value.release !== 'function' || typeof value.texture?.createView !== 'function'
      || !['straight', 'premultiplied'].includes(value.alphaMode)) fail('E_HYA_RUNTIME_HOST_PORT', '$.core.draw.textures', 'an acquired ready texture lease is required');
    return value;
  };
  try {
    for (const entity of world.entities.values()) {
      for (const key of entity.getComponent(AnimationMaskSources)?.keys ?? []) maskSources.add(key);
      const source = entity.getComponent(AnimationVisual2D);
      if (!source || isEntityDisabledInHierarchyCached(entity, disabled)) continue;
      const path = '$.core.visuals[' + JSON.stringify(source.nodeKey) + ']';
      const positions = source.geometry.positions.slice(), indices = source.geometry.indices?.slice();
      geometryBytes += positions.byteLength * 2 + (indices?.byteLength ?? 0);
      if (!Number.isSafeInteger(geometryBytes) || geometryBytes > options.maxGeometryBytes) fail('E_HYA_RUNTIME_LIMIT', path + '.geometry', 'core snapshot exceeds its explicit geometry ceiling');
      const geometry = new Geometry2D(positions, indices, {topology: source.geometry.topology});
      const local = new Float32Array(16);
      writeAnimationVisualMatrix(local, world.frameData.getWorldMatrix2D(entity), source.localTransform);
      const matrix = mat4.multiply(projection, local);
      if ([...matrix].some(value => !Number.isFinite(value)) || matrix[3] !== 0 || matrix[7] !== 0 || matrix[15] !== 1)
        fail('E_HYA_RUNTIME_CAPABILITY', path + '.transform', 'core snapshot requires a finite affine 2D projection');
      const transform = [matrix[0]! * viewport[0] / 2, -matrix[1]! * viewport[1] / 2,
        matrix[4]! * viewport[0] / 2, -matrix[5]! * viewport[1] / 2,
        (matrix[12]! + 1) * viewport[0] / 2, (1 - matrix[13]!) * viewport[1] / 2] as const;
      let texture: ProductionDrawTexture | undefined;
      if (source.textMaterial) {
        texture = bitmaps.get(source.textMaterial);
        if (!texture) {
          const port = options.textures ?? fail('E_HYA_RUNTIME_HOST_PORT', path + '.text', 'core bitmap materialization needs the common texture owner');
          const snapshot: AnimationTextBitmapSnapshot = source.textMaterial.acquireTextureSnapshot();
          let deferred = false;
          try {texture = acquire(port.bitmap(snapshot)); bitmaps.set(source.textMaterial, texture);}
          catch (error) {
            // The existing asynchronous host may still be copying these pixels. Keep its source alive
            // until that request settles, even though the candidate frame itself is rolled back.
            if (error instanceof ProductionTexturePending) {deferred = true; void error.ready.finally(snapshot.release).catch(() => {});}
            throw error;
          } finally {if (!deferred) snapshot.release();}
        }
      } else if (source.requiresTexture || source.texture || source.textureHandle) {
        const port = options.image ?? fail('E_HYA_RUNTIME_HOST_PORT', path + '.image', 'core images need an independent acquired texture lease');
        texture = acquire(port(source));
      }
      visuals.push(new AnimationVisual2D({geometry, instanceId: source.instanceId, nodeId: source.nodeId, order: source.order,
        color: source.color, multiplyColor: source.multiplyColor, screenColor: source.screenColor, blendMode: source.blendMode,
        culling: source.culling, sourceOnly: source.sourceOnly, localTransform: transform,
        ...(source.compositeLayers.length ? {composite: {layers: source.compositeLayers.map(layer => ({...layer}))}} : {}),
        ...(source.uvs ? {uvs: source.uvs.slice()} : {}), uvRect: source.uvRect,
        gradient: source.gradient ? {...source.gradient, start: [...source.gradient.start], end: [...source.gradient.end], stops: source.gradient.stops.slice()} : null,
        effects: source.effects.map(effect => ({kind: effect.kind, values: effect.values.slice()})),
        ...(texture ? {requiresTexture: true, textureAlphaMode: texture.alphaMode,
          ...(texture.sampling ? {textureSampling: texture.sampling} : source.textureSampling ? {textureSampling: source.textureSampling} : {}),
          textureHandle: {key: source.nodeKey, get value() {return texture.texture;}, release() {/* The plan owns this acquired lease. */}}} : {}),
      }));
    }
    return Object.freeze({viewport, dpr, visuals: Object.freeze(visuals), maskSources: Object.freeze([...maskSources]), geometryBytes, release,
      assertReady() {if (released) fail('E_HYA_RUNTIME_DISPOSED', '$.core.draw', 'core draw plan was released'); for (const value of leases) if (!value.texture) fail('E_HYA_RUNTIME_HOST_PORT', '$.core.draw.textures', 'core texture is no longer ready');},
    });
  } catch (error) {try {release();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Core snapshot preparation and cleanup failed');} throw error;}
}
