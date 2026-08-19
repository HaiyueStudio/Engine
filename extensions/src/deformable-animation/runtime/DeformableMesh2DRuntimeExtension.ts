import {
  DEFORMABLE_MESH_2D_EXTENSION_ID,
  decodeDeformableMesh2DData,
  type DeformableMesh2DComponent,
  type ParsedDeformableMesh2DData,
  type ParsedDeformableMesh2DDrawable,
} from '@haiyue/animation-spec/deformable2d';
import { AnimationFormatError } from '@haiyue/animation-spec';
import { Entity, Geometry2D, Transform2D } from '@haiyue/engine';
import type { AssetHandle } from '@haiyue/engine/assets';
import type {
  Animation2DExtensionContext,
  Animation2DExtensionHandler,
  Animation2DExtensionInstance,
} from '../../animation/Animation2DExtensionRegistry';
import { AnimationVisual2D } from '../../animation/AnimationVisual2D';
import { sampleDeformableMesh2DDrawable } from './DeformableMesh2DSampler';

export type DeformableMesh2DRuntimeState = 'loading' | 'ready' | 'error' | 'destroyed';

export interface DeformableMesh2DRuntimeStatus {
  readonly state: DeformableMesh2DRuntimeState;
  readonly drawableCount: number;
  readonly error?: string;
}

export interface DeformableMesh2DRuntimeExtensionOptions {
  readonly onStatus?: (status: DeformableMesh2DRuntimeStatus) => void;
}

interface RuntimeDrawable {
  readonly source: ParsedDeformableMesh2DDrawable;
  readonly geometry: Geometry2D;
  readonly positions: Float32Array;
  readonly visuals: readonly AnimationVisual2D[];
}

export function createDeformableMesh2DRuntimeExtension(
  options: DeformableMesh2DRuntimeExtensionOptions = {},
): Animation2DExtensionHandler {
  return {
    id: DEFORMABLE_MESH_2D_EXTENSION_ID,
    create(context) {
      return new DeformableMesh2DRuntimeInstance(context, options);
    },
  };
}

class DeformableMesh2DRuntimeInstance implements Animation2DExtensionInstance {
  // Keep an explicit transform at the extension boundary. TransformStore marks
  // transform-less entities as non-transform parents, so two consecutive
  // transform-less runtime nodes would otherwise drop the owning HYA model's
  // world transform before it reaches the drawable entities.
  private readonly root = new Entity('HYA deformable mesh runtime').addComponent(new Transform2D());
  private readonly controller = new AbortController();
  private readonly assetHandles: AssetHandle<unknown>[] = [];
  private readonly drawables: RuntimeDrawable[] = [];
  private readonly onOwnerAbort = (): void => this.controller.abort('animation-owner-destroyed');
  private state: DeformableMesh2DRuntimeState = 'loading';
  private lastTime = 0;
  private lastOpacity = 1;
  private destroyed = false;

  constructor(
    private readonly context: Animation2DExtensionContext,
    private readonly options: DeformableMesh2DRuntimeExtensionOptions,
  ) {
    context.parent.addChild(this.root);
    context.signal.addEventListener('abort', this.onOwnerAbort, { once: true });
    this.emitStatus();
    void this.load();
  }

  apply(timeSeconds: number, opacity: number): void {
    this.lastTime = timeSeconds;
    this.lastOpacity = opacity;
    if (this.state !== 'ready') return;
    for (const item of this.drawables) {
      const sample = sampleDeformableMesh2DDrawable(this.data!.times, item.source, timeSeconds, item.positions);
      item.geometry.markDirty();
      for (const visual of item.visuals) {
        visual.color[3] = sample.opacity * opacity;
        visual.setOrder(sample.renderOrder);
        visual.revision++;
      }
    }
  }

  setOpacity(opacity: number): void {
    this.apply(this.lastTime, opacity);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.state = 'destroyed';
    this.controller.abort('deformable-runtime-destroyed');
    this.context.signal.removeEventListener('abort', this.onOwnerAbort);
    for (const handle of this.assetHandles.splice(0)) handle.release();
    this.drawables.length = 0;
    this.root.destroy();
    this.emitStatus();
  }

  private data: ParsedDeformableMesh2DData | null = null;

  private async load(): Promise<void> {
    try {
      const manager = this.context.assetManager;
      if (!manager) throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', 'Deformable mesh runtime requires an AssetManager.', '$runtime.assetManager');
      const component = this.context.component as unknown as DeformableMesh2DComponent;
      const dataResource = this.context.animation.resources.find(resource => resource.id === component.dataResource);
      if (!dataResource || dataResource.type !== 'binary') throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', `Deformable data resource "${component.dataResource}" is missing or not binary.`, '$.resources');
      const textureResources = component.textures.map((id, index) => {
        const resource = this.context.animation.resources.find(candidate => candidate.id === id);
        if (!resource || resource.type !== 'image') throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', `Texture resource "${id}" is missing or not an image.`, `$.nodes[].components[].textures[${index}]`);
        return resource;
      });
      const dataHandle = await manager.load<ArrayBuffer>(
        `deformable2d:${dataResource.integrity ?? dataResource.uri}`,
        async signal => {
          const response = await fetch(dataResource.uri, signal ? { signal } : {});
          if (!response.ok) throw new Error(`Deformable sidecar request failed with HTTP ${response.status}.`);
          return response.arrayBuffer();
        },
        () => {},
        { signal: this.controller.signal },
      );
      if (this.destroyed) { dataHandle.release(); return; }
      this.assetHandles.push(dataHandle);
      const data = decodeDeformableMesh2DData(dataHandle.value);
      if (Math.abs(data.canvasWidth - this.context.animation.canvas.width) > 1e-6
        || Math.abs(data.canvasHeight - this.context.animation.canvas.height) > 1e-6
        || Math.abs(data.duration - this.context.animation.duration) > 1e-6) {
        throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', 'Deformable sidecar canvas/duration does not match HYA.', '$.resources');
      }
      for (let index = 0; index < data.drawables.length; index++) {
        if (data.drawables[index]!.textureIndex >= textureResources.length) throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', 'Drawable texture index exceeds component texture resources.', `$.drawables[${index}].textureIndex`);
      }
      const textureHandles: AssetHandle<GPUTexture>[] = [];
      for (let index = 0; index < textureResources.length; index++) {
        const resource = textureResources[index]!;
        try {
          textureHandles.push(await manager.loadTexture(resource.uri, {
            label: `DeformableMesh2D:${resource.id}`,
            // AnimationVisual2D currently composites display-encoded 2D colors
            // into an rgba8unorm canvas. An sRGB texture view would decode the
            // authored bytes to linear values and make the result visibly dark.
            // Preserve the source bytes here to match Canvas/WebGL Live2D output.
            format: 'rgba8unorm',
            cacheKey: resource.integrity ?? resource.uri,
            signal: this.controller.signal,
          }));
        } catch (error) {
          for (const handle of textureHandles) handle.release();
          throw new Error(`Texture ${index} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (this.destroyed) { for (const handle of textureHandles) handle.release(); return; }
      this.assetHandles.push(...textureHandles);
      this.data = data;
      this.createVisuals(data, textureHandles);
      this.state = 'ready';
      this.apply(this.lastTime, this.lastOpacity);
      this.emitStatus();
    } catch (error) {
      if (this.controller.signal.aborted || this.destroyed) return;
      for (const handle of this.assetHandles.splice(0)) handle.release();
      this.data = null;
      this.drawables.length = 0;
      this.root.destroy();
      this.state = 'error';
      this.emitStatus(error instanceof Error ? error.message : String(error));
    }
  }

  private createVisuals(data: ParsedDeformableMesh2DData, textures: readonly AssetHandle<GPUTexture>[]): void {
    const maskSources = new Set(data.drawables.flatMap(drawable => drawable.masks));
    for (const drawable of data.drawables) {
      const positions = new Float32Array(drawable.vertexCount * 2);
      sampleDeformableMesh2DDrawable(data.times, drawable, this.lastTime, positions);
      const geometry = new Geometry2D(positions, drawable.indices);
      const composite = drawable.masks.length > 0 ? {
        layers: drawable.masks.map((source, index) => ({
          kind: 'mask' as const,
          source: `mask:${source}`,
          mode: 'alpha' as const,
          operation: index === 0 ? 'add' as const : 'add' as const,
        })),
      } : undefined;
      const createVisual = (sourceOnly: boolean, nodeId: string): AnimationVisual2D => new AnimationVisual2D({
        geometry,
        uvs: drawable.uvs,
        color: [1, 1, 1, 1],
        instanceId: this.context.instanceId,
        nodeId,
        order: drawable.renderOrders[0]!,
        sourceOnly,
        ...(composite ? { composite } : {}),
        textureHandle: textures[drawable.textureIndex]!,
        requiresTexture: true,
      });
      const visuals: AnimationVisual2D[] = [];
      const visible = createVisual(false, `draw:${drawable.id}`);
      this.root.addChild(new Entity(`Drawable ${drawable.id}`).addComponent(visible));
      visuals.push(visible);
      if (maskSources.has(drawable.id)) {
        const mask = createVisual(true, `mask:${drawable.id}`);
        this.root.addChild(new Entity(`Mask ${drawable.id}`).addComponent(mask));
        visuals.push(mask);
      }
      this.drawables.push({ source: drawable, geometry, positions, visuals: Object.freeze(visuals) });
    }
  }

  private emitStatus(error?: string): void {
    this.options.onStatus?.(Object.freeze({ state: this.state, drawableCount: this.drawables.length, ...(error ? { error } : {}) }));
  }
}
