import { BasicMaterial } from '../material/BasicMaterial';
import { BlinnPhongMaterial } from '../material/BlinnPhongMaterial';
import { DepthMaterial } from '../material/DepthMaterial';
import type { Material } from '../material/Material';
import { NormalMaterial } from '../material/NormalMaterial';
import { PbrMaterial } from '../material/PbrMaterial';
import { PlanarMirrorMaterial } from '../material/PlanarMirrorMaterial';
import { RadialShadowMaterial } from '../material/RadialShadowMaterial';
import { VolumeMaterial } from '../material/VolumeMaterial';
import type {
  InternalMaterialRenderContext,
  MaterialGpuDrivenBatch,
  MaterialRenderContext,
} from '../renderer/MaterialRendererRegistry';
import { MaterialRendererRegistry } from '../renderer/MaterialRendererRegistry';
import type { DepthRenderer } from '../renderer/DepthRenderer';
import type { BlinnPhongRenderer } from '../renderer/BlinnPhongRenderer';
import { supportsBasicSortedInstanceBatching, type Mesh3DRenderer } from '../renderer/Mesh3DRenderer';
import type { NormalRenderer } from '../renderer/NormalRenderer';
import type { PbrRenderer } from '../renderer/PbrRenderer';
import type { PlanarMirrorRenderer } from '../renderer/PlanarMirrorRenderer';
import type { VolumeRenderer } from '../renderer/VolumeRenderer';
import type { DefaultMaterialRendererOptions } from './Render3DContracts';
import type { Render3DLiveCache } from './Render3DLiveCache';

export interface DefaultRendererAccess {
  basic(): Mesh3DRenderer;
  blinnPhong(): BlinnPhongRenderer;
  pbr(): PbrRenderer;
  depth(): DepthRenderer;
  normal(): NormalRenderer;
  volume(): VolumeRenderer;
  planarMirror(): PlanarMirrorRenderer;
  destroyPlanarMirror(): void;
  readonly live: Render3DLiveCache;
}

function getGpuDrivenBatch<M extends Material>(context: MaterialRenderContext<M>): MaterialGpuDrivenBatch | undefined {
  return (context as InternalMaterialRenderContext<M>).gpuDrivenBatch;
}

export function registerDefaultMaterialRenderers(
  registry: MaterialRendererRegistry,
  access: DefaultRendererAccess,
  options: boolean | DefaultMaterialRendererOptions = true,
): void {
    if (options === false) return;
    const enabled: Required<DefaultMaterialRendererOptions> = {
    basic: true,
    blinnPhong: true,
      pbr: true,
      depth: true,
      normal: true,
      volume: true,
      planarMirror: true,
      ...(typeof options === 'object' ? options : {}),
    };
  if (enabled.basic) {
      registry.register<BasicMaterial>({
        materialType: BasicMaterial,
        shadowCullMode: material => material.cullMode,
        beginView: context => {
          const renderer = access.basic();
          renderer.reverseZ = context.reverseZ;
          renderer.msaaSamples = context.msaaSamples;
          renderer.updateCamera(context.sceneFrameUniforms, context.viewSlot, context.commandContext);
        },
        prepareObjects: (context, items, first, count, firstBatchIndex) => {
          access.basic().prepareObjects(
            items,
            first,
            count,
            firstBatchIndex,
            context.gpuDrivenBatchBuffer,
          );
        },
        flushUploads: () => access.basic().flushUploads(),
        endView: () => access.basic().endView(),
        isTransparent: material => material.blending !== 'none',
        transparentOrder: material => material.blending === 'additive' ? 10 : 0,
        transparentDepthSort: material => material.blending !== 'additive',
        supportsSortedInstanceBatching: supportsBasicSortedInstanceBatching,
        needsDepthPrepass: material => material.blending === 'normal' && material.depthWrite,
        renderDepthPrepass: context => {
          const renderer = access.basic();
          renderer.renderDepthPrepass(
            context.passEncoder,
            context.entityId,
            context.geometry,
            context.material,
            context.worldMatrix,
            context.clippingPlanes,
          );
        },
        renderItem: context => {
          const gpuDrivenBatch = getGpuDrivenBatch(context);
          const renderer = access.basic();
          access.live.basicEntities.add(context.entityId);
          access.live.basicGeometries.add(context.geometry.id);
          access.live.basicMaterials.add(context.material.id);
          const skipDepthPrepass = context.material.blending === 'normal' && context.material.depthWrite;
          renderer.render(context.passEncoder, context.entityId, context.geometry, context.material, context.worldMatrix, {
            skipDepthPrepass,
            gpuDrivenBatch: (
              context.material.blending === 'none'
              || supportsBasicSortedInstanceBatching(context.material)
            ) ? gpuDrivenBatch : undefined,
          }, context.clippingPlanes);
        },
        renderBatch: (context, items, first, count, batchBuffer) => {
          const renderer = access.basic();
          const material = context.material;
          const skipDepthPrepass = material.blending === 'normal' && material.depthWrite;
          const end = Math.min(items.length, first + count);
          for (let index = first; index < end; index++) {
            const item = items[index];
            if (!item?.geometry || !item.material) continue;
            access.live.basicEntities.add(item.entityId);
            access.live.basicGeometries.add(item.geometry.id);
            access.live.basicMaterials.add(item.material.id);
          }
          renderer.renderBatch(context.passEncoder, items, first, count, batchBuffer, skipDepthPrepass);
        },
        renderSortedInstanceBatch: (context, items, first, count, batchBuffer, firstBatchIndex) => {
          const renderer = access.basic();
          const end = Math.min(items.length, first + count);
          for (let index = first; index < end; index++) {
            const item = items[index];
            if (!item?.geometry || !item.material) continue;
            access.live.basicEntities.add(item.entityId);
            access.live.basicGeometries.add(item.geometry.id);
            access.live.basicMaterials.add(item.material.id);
          }
          renderer.renderBatch(
            context.passEncoder,
            items,
            first,
            count,
            batchBuffer,
            false,
            firstBatchIndex,
          );
        },
      });
    }
    if (enabled.blinnPhong) {
      registry.register<BlinnPhongMaterial>({
        materialType: BlinnPhongMaterial,
        isTransparent: material => material.blending !== 'none',
        transparentDepthSort: material => material.blending !== 'none',
        beginView: context => {
          const renderer = access.blinnPhong();
          renderer.reverseZ = context.reverseZ;
          renderer.msaaSamples = context.msaaSamples;
          renderer.updateCamera(context.sceneFrameUniforms, context.commandContext);
          renderer.updateLights(context.sceneEnvironment.pbrLights);
        },
        prepareObjects: (context, items, first, count, firstBatchIndex) => {
          access.blinnPhong().prepareObjects(
            items,
            first,
            count,
            firstBatchIndex,
            context.gpuDrivenBatchBuffer,
          );
        },
        flushUploads: () => access.blinnPhong().flushUploads(),
        endView: () => access.blinnPhong().endView(),
        renderItem: context => {
          const renderer = access.blinnPhong();
          access.live.blinnPhongEntities.add(context.entityId);
          access.live.blinnPhongGeometries.add(context.geometry.id);
          access.live.blinnPhongMaterials.add(context.material.id);
          renderer.render(context.passEncoder, context.entityId, context.geometry, context.material, context.worldMatrix, {
            gpuDrivenBatch: getGpuDrivenBatch(context),
          }, context.clippingPlanes);
        },
        renderBatch: (context, items, first, count, batchBuffer) => {
          const renderer = access.blinnPhong();
          const end = Math.min(items.length, first + count);
          for (let index = first; index < end; index++) {
            const item = items[index];
            if (!item?.geometry || !item.material) continue;
            access.live.blinnPhongEntities.add(item.entityId);
            access.live.blinnPhongGeometries.add(item.geometry.id);
            access.live.blinnPhongMaterials.add(item.material.id);
          }
          renderer.renderBatch(context.passEncoder, items, first, count, batchBuffer);
        },
      });
    }
    if (enabled.pbr) {
      registry.register<PbrMaterial>({
        materialType: PbrMaterial,
        receivesDirectionalShadow: true,
        shadowCullMode: material => material.doubleSided ? 'none' : 'back',
        beginView: context => access.pbr().beginView(
          context.sceneFrameUniforms,
          context.commandContext,
        ),
        isTransparent: material => material.alphaMode === 'blend' || material.transmissionFactor > 0,
        transparentDepthSort: material => material.alphaMode === 'blend' || material.transmissionFactor > 0,
        prepareObjects: (context, items, first, count, firstBatchIndex) => {
          access.pbr().prepareObjects(
            items,
            first,
            count,
            firstBatchIndex,
            context.gpuDrivenBatchBuffer,
          );
        },
        flushUploads: () => access.pbr().flushUploads(),
        endView: () => access.pbr().endView(),
        renderItem: context => {
          const gpuDrivenBatch = getGpuDrivenBatch(context);
          const renderer = access.pbr();
          renderer.reverseZ = context.reverseZ;
          renderer.msaaSamples = context.msaaSamples;
          access.live.pbrEntities.add(context.entityId);
          access.live.pbrGeometries.add(context.geometry.id);
          access.live.pbrMaterials.add(context.material.id);
          renderer.render(context.passEncoder, context.entityId, context.geometry, context.material, context.worldMatrix, {
            gpuDrivenBatch: context.material.alphaMode === 'opaque' && context.material.transmissionFactor <= 0
              ? gpuDrivenBatch
              : undefined,
          }, context.clippingPlanes);
        },
        renderBatch: (context, items, first, count, batchBuffer) => {
          const renderer = access.pbr();
          renderer.reverseZ = context.reverseZ;
          renderer.msaaSamples = context.msaaSamples;
          const end = Math.min(items.length, first + count);
          for (let index = first; index < end; index++) {
            const item = items[index];
            if (!item?.geometry || !item.material) continue;
            access.live.pbrEntities.add(item.entityId);
            access.live.pbrGeometries.add(item.geometry.id);
            access.live.pbrMaterials.add(item.material.id);
          }
          renderer.renderBatch(context.passEncoder, items, first, count, batchBuffer);
        },
      });
    }
    if (enabled.depth) {
      registry.register<DepthMaterial>({
        materialType: DepthMaterial,
        beginView: context => {
          const renderer = access.depth();
          renderer.reverseZ = context.reverseZ;
          renderer.msaaSamples = context.msaaSamples;
          renderer.beginView(context.sceneFrameUniforms, context.commandContext);
        },
        prepareObjects: (context, items, first, count, firstBatchIndex) => access.depth().prepareObjects(
          items,
          first,
          count,
          firstBatchIndex,
          context.gpuDrivenBatchBuffer,
        ),
        flushUploads: () => access.depth().flushUploads(),
        endView: () => access.depth().endView(),
        renderItem: context => {
          const gpuDrivenBatch = getGpuDrivenBatch(context);
          const renderer = access.depth();
          access.live.depthEntities.add(context.entityId);
          access.live.depthGeometries.add(context.geometry.id);
          access.live.depthMaterials.add(context.material.id);
          renderer.render(context.passEncoder, context.entityId, context.geometry, context.material, context.worldMatrix, {
            gpuDrivenBatch,
          }, context.clippingPlanes);
        },
        renderBatch: (context, items, first, count, batchBuffer) => {
          const renderer = access.depth();
          const end = Math.min(items.length, first + count);
          for (let index = first; index < end; index++) {
            const item = items[index];
            if (!item?.geometry || !item.material) continue;
            access.live.depthEntities.add(item.entityId);
            access.live.depthGeometries.add(item.geometry.id);
            access.live.depthMaterials.add(item.material.id);
          }
          renderer.renderBatch(context.passEncoder, items, first, count, batchBuffer);
        },
      });
    }
    if (enabled.normal) {
      registry.register<NormalMaterial>({
        materialType: NormalMaterial,
        beginView: context => {
          const renderer = access.normal();
          renderer.reverseZ = context.reverseZ;
          renderer.msaaSamples = context.msaaSamples;
          renderer.beginView(context.sceneFrameUniforms, context.commandContext);
        },
        prepareObjects: (context, items, first, count, firstBatchIndex) => access.normal().prepareObjects(
          items,
          first,
          count,
          firstBatchIndex,
          context.gpuDrivenBatchBuffer,
        ),
        flushUploads: () => access.normal().flushUploads(),
        endView: () => access.normal().endView(),
        renderItem: context => {
          const gpuDrivenBatch = getGpuDrivenBatch(context);
          const renderer = access.normal();
          access.live.normalEntities.add(context.entityId);
          access.live.normalGeometries.add(context.geometry.id);
          access.live.normalMaterials.add(context.material.id);
          renderer.render(context.passEncoder, context.entityId, context.geometry, context.material, context.worldMatrix, {
            gpuDrivenBatch,
          }, context.clippingPlanes);
        },
        renderBatch: (context, items, first, count, batchBuffer) => {
          const renderer = access.normal();
          const end = Math.min(items.length, first + count);
          for (let index = first; index < end; index++) {
            const item = items[index];
            if (!item?.geometry || !item.material) continue;
            access.live.normalEntities.add(item.entityId);
            access.live.normalGeometries.add(item.geometry.id);
            access.live.normalMaterials.add(item.material.id);
          }
          renderer.renderBatch(context.passEncoder, items, first, count, batchBuffer);
        },
      });
    }
    if (enabled.volume) {
      registry.register<VolumeMaterial>({
        materialType: VolumeMaterial,
        isTransparent: () => true,
        transparentOrder: () => 5,
        transparentDepthSort: () => true,
        beginView: context => {
          const renderer = access.volume();
          renderer.reverseZ = context.reverseZ;
          renderer.msaaSamples = context.msaaSamples;
          renderer.beginView(context.sceneFrameUniforms, context.commandContext);
        },
        prepareObjects: (context, items, first, count, firstBatchIndex) => access.volume().prepareObjects(
          items,
          first,
          count,
          context.eyePosition,
          firstBatchIndex,
          context.gpuDrivenBatchBuffer,
        ),
        flushUploads: () => access.volume().flushUploads(),
        endView: () => access.volume().endView(),
        renderItem: context => {
          const gpuDrivenBatch = getGpuDrivenBatch(context);
          const renderer = access.volume();
          access.live.volumeEntities.add(context.entityId);
          access.live.volumeGeometries.add(context.geometry.id);
          access.live.volumeMaterials.add(context.material.id);
          renderer.render(context.passEncoder, context.entityId, context.geometry, context.material, context.worldMatrix, context.eyePosition, {
            gpuDrivenBatch,
          }, context.clippingPlanes);
        },
      });
    }
    if (enabled.planarMirror) {
      registry.register<PlanarMirrorMaterial>({
        materialType: PlanarMirrorMaterial,
        beginView: context => access.planarMirror().beginView(context),
        prepareObjects: (_context, items, first, count) => (
          access.planarMirror().prepareObjects(items, first, count)
        ),
        flushUploads: () => access.planarMirror().flushUploads(),
        endView: () => access.planarMirror().endView(),
        renderItem: context => access.planarMirror().render(
          context.passEncoder,
          context.entityId,
          context.geometry,
          context.material,
          context.worldMatrix,
        ),
        destroy: () => access.destroyPlanarMirror(),
      });
    }
    registry.register<RadialShadowMaterial>({
      materialType: RadialShadowMaterial,
      renderItem: () => {
        // Radial shadows are drawn by RadialShadowRenderFeature in a dedicated pass.
      },
      renderBatch: () => {
        // Keep batched main 3D rendering from treating radial shadows as unsupported.
      },
    });
  }
