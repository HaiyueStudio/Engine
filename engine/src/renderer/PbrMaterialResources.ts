import type { AssetHandle, CompressedTextureSourceDescriptor, AssetManager } from '../assets/AssetManager';
import { writeColorLinear } from '../color/ColorLike';
import type { MaterialTextureSource } from '../material/BasicMaterial';
import { getPbrTextureFormat, PBR_TEXTURE_SLOTS, type PbrMaterial, type PbrTextureSlot } from '../material/PbrMaterial';
import { getInstrumentedGPUResourceTracker } from '../core/GPUResourceTracker';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { getPbrTextureSource, unwrapPbrTexture, writePbrTextureMapping } from './PbrTextureBindings';
import { RendererCacheMap } from './RendererCacheMap';
import { RecordedGpuResources } from './RecordedGpuResources';
import { writeBuffer } from './utils';

export interface MaterialGpuData {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  transmissionBindGroup: GPUBindGroup;
  samplers: Record<PbrTextureSlot, GPUSampler>;
  samplerKeys: Record<PbrTextureSlot, string>;
  textures: Record<PbrTextureSlot, GPUTexture>;
  sources: Record<PbrTextureSlot, unknown>;
  handles: Partial<Record<PbrTextureSlot, AssetHandle<GPUTexture>>>;
  loaded: Record<PbrTextureSlot, boolean>;
  uniformBuffer: ArrayBuffer;
  f32: Float32Array;
  u32: Uint32Array;
  materialRevision: number;
  textureRevision: number;
  uploadedTextureRevision: number;
  disposed: boolean;
}

const TEXTURE_SLOTS: readonly PbrTextureSlot[] = PBR_TEXTURE_SLOTS;
export const PBR_BASE_BINDING_SLOTS: readonly PbrTextureSlot[] = TEXTURE_SLOTS.slice(0, 12);
const TRANSMISSION_BINDING_SLOTS: readonly PbrTextureSlot[] = Object.freeze([
  ...TEXTURE_SLOTS.slice(0, 10),
  'transmission',
  'thickness',
]);
// Ten base vec4s and two affine-transform rows for each texture slot.
const MATERIAL_BYTES = 160 + TEXTURE_SLOTS.length * 32;
interface PbrMaterialResourceOptions {
  readonly device: GPUDevice;
  readonly assets: AssetManager;
  readonly signal: AbortSignal;
  readonly layout: GPUBindGroupLayout;
  readonly defaultSampler: GPUSampler;
  readonly white: GPUTexture;
  readonly normal: GPUTexture;
  readonly black: GPUTexture;
  readonly recorded: RecordedGpuResources;
}

/** Owns material packing, texture readiness and recorded GPU versions independently of scene orchestration. */
export class PbrMaterialResources {
  readonly entries = new RendererCacheMap<MaterialGpuData>(data => this._destroyMaterial(data));
  private readonly _samplers = new Map<string, GPUSampler>();
  private disposed = false;
  private get recorded(): RecordedGpuResources { return this.options.recorded; }
  constructor(private readonly options: PbrMaterialResourceOptions) {}

  create(material: PbrMaterial): MaterialGpuData {
    const buffer = this.options.device.createBuffer({ size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.recorded.own(buffer, () => buffer.destroy());
    const samplerKeys = {} as Record<PbrTextureSlot, string>;
    const samplers = {} as Record<PbrTextureSlot, GPUSampler>;
    for (const slot of TEXTURE_SLOTS) {
      const descriptor = material.getTextureSampler(slot);
      samplerKeys[slot] = this._samplerKey(descriptor);
      samplers[slot] = this._getSampler(descriptor);
    }
    const data: MaterialGpuData = {
      buffer,
      bindGroup: null as unknown as GPUBindGroup,
      transmissionBindGroup: null as unknown as GPUBindGroup,
      samplers,
      samplerKeys,
      textures: {
        baseColor: this.options.white,
        metallicRoughness: this.options.white,
        normal: this.options.normal,
        occlusion: this.options.white,
        emissive: this.options.white,
        clearcoat: this.options.white,
        clearcoatRoughness: this.options.white,
        clearcoatNormal: this.options.normal,
        specular: this.options.white,
        specularColor: this.options.white,
        sheenColor: this.options.white,
        sheenRoughness: this.options.white,
        transmission: this.options.white,
        thickness: this.options.white,
      },
      sources: {
        baseColor: null, metallicRoughness: null, normal: null, occlusion: null, emissive: null,
        clearcoat: null, clearcoatRoughness: null, clearcoatNormal: null,
        specular: null, specularColor: null,
        sheenColor: null, sheenRoughness: null,
        transmission: null, thickness: null,
      },
      handles: {},
      loaded: {
        baseColor: false, metallicRoughness: false, normal: false, occlusion: false, emissive: false,
        clearcoat: false, clearcoatRoughness: false, clearcoatNormal: false,
        specular: false, specularColor: false,
        sheenColor: false, sheenRoughness: false,
        transmission: false, thickness: false,
      },
      uniformBuffer: new ArrayBuffer(MATERIAL_BYTES),
      f32: null as unknown as Float32Array,
      u32: null as unknown as Uint32Array,
      materialRevision: -1,
      textureRevision: 0,
      uploadedTextureRevision: -1,
      disposed: false,
    };
    data.f32 = new Float32Array(data.uniformBuffer);
    data.u32 = new Uint32Array(data.uniformBuffer);
    data.bindGroup = this._buildMaterialBindGroup(data);
    data.transmissionBindGroup = this._buildMaterialBindGroup(data, true);
    return data;
  }

  sync(material: PbrMaterial, data: MaterialGpuData, context?: RenderCommandContext): void {
    this._updateMaterial(material, data);
    this.recorded.retain(data.buffer, context);
    this.recorded.retain(data.bindGroup, context);
    this.recorded.retain(data.transmissionBindGroup, context);
    for (const handle of Object.values(data.handles)) if (handle) this.recorded.retain(handle, context);
  }

  private _updateMaterial(material: PbrMaterial, data: MaterialGpuData): void {
    if (data.materialRevision === material.revision
      && data.uploadedTextureRevision === data.textureRevision) return;

    if (data.materialRevision !== material.revision) {
      let bindingsChanged = false;
      for (const slot of TEXTURE_SLOTS) {
        bindingsChanged = this._syncTexture(slot, getPbrTextureSource(material, slot), data) || bindingsChanged;
      }
      for (const slot of TEXTURE_SLOTS) {
        const descriptor = material.samplers[slot] ?? null;
        const samplerKey = this._samplerKey(descriptor);
        if (samplerKey === data.samplerKeys[slot]) continue;
        data.samplerKeys[slot] = samplerKey;
        data.samplers[slot] = this._getSampler(descriptor);
        bindingsChanged = true;
      }
      if (bindingsChanged) {
        this._rebuildMaterialBindGroups(data);
      }
    }
    if (data.materialRevision === material.revision
      && data.uploadedTextureRevision === data.textureRevision) return;

    writeColorLinear(material.baseColor, data.f32, 0);
    data.materialRevision = material.revision;
    data.uploadedTextureRevision = data.textureRevision;
    data.f32[4] = material.emissiveFactor[0];
    data.f32[5] = material.emissiveFactor[1];
    data.f32[6] = material.emissiveFactor[2];
    data.f32[7] = material.normalScale;
    data.f32[8] = material.metallic;
    data.f32[9] = material.roughness;
    data.f32[10] = material.occlusionStrength;
    data.f32[11] = material.alphaCutoff;
    data.u32[12] = data.loaded.baseColor ? 1 : 0;
    data.u32[13] = data.loaded.metallicRoughness ? 1 : 0;
    data.u32[14] = (data.loaded.normal ? 1 : 0) | (data.loaded.occlusion ? 2 : 0) | (data.loaded.emissive ? 4 : 0);
    data.u32[15] = material.alphaMode === 'mask' ? 1 : material.alphaMode === 'blend' ? 2 : 0;
    data.f32[16] = material.clearcoatFactor;
    data.f32[17] = material.clearcoatRoughnessFactor;
    data.f32[18] = material.clearcoatNormalScale;
    data.f32[19] = material.ior;
    data.u32[20] = (data.loaded.clearcoat ? 1 : 0)
      | (data.loaded.clearcoatRoughness ? 2 : 0)
      | (data.loaded.clearcoatNormal ? 4 : 0);
    data.u32[21] = (data.loaded.specular ? 1 : 0)
      | (data.loaded.specularColor ? 2 : 0);
    data.u32[22] = (data.loaded.sheenColor ? 1 : 0)
      | (data.loaded.sheenRoughness ? 2 : 0);
    data.f32[24] = material.specularFactor;
    data.f32[25] = material.specularColorFactor[0];
    data.f32[26] = material.specularColorFactor[1];
    data.f32[27] = material.specularColorFactor[2];
    data.f32[28] = material.sheenColorFactor[0];
    data.f32[29] = material.sheenColorFactor[1];
    data.f32[30] = material.sheenColorFactor[2];
    data.f32[31] = material.sheenRoughnessFactor;
    data.f32[32] = material.transmissionFactor;
    data.f32[33] = material.thicknessFactor;
    data.f32[34] = Number.isFinite(material.attenuationDistance) ? material.attenuationDistance : 0;
    data.f32[35] = (data.loaded.transmission ? 1 : 0) | (data.loaded.thickness ? 2 : 0);
    data.f32[36] = material.attenuationColor[0];
    data.f32[37] = material.attenuationColor[1];
    data.f32[38] = material.attenuationColor[2];
    for (let index = 0; index < TEXTURE_SLOTS.length; index++) {
      const slot = TEXTURE_SLOTS[index]!;
      writePbrTextureMapping(data.f32, 40 + index * 8, material.textureMappings[slot]);
    }
    if (this.recorded.pending(data.buffer)) {
      const previous = data.buffer;
      const buffer = this.options.device.createBuffer({ size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      data.buffer = this.recorded.own(buffer, () => buffer.destroy());
      this._rebuildMaterialBindGroups(data);
      this.recorded.retire(previous);
    }
    writeBuffer(this.options.device.queue, data.buffer, 0, data.f32);
  }

  private _syncTexture(slot: PbrTextureSlot, source: MaterialTextureSource, data: MaterialGpuData): boolean {
    if (data.sources[slot] === source) return false;
    if (data.handles[slot]) this.recorded.retire(data.handles[slot]!);
    delete data.handles[slot];
    data.sources[slot] = source;
    data.loaded[slot] = false;
    data.textures[slot] = this._defaultForSlot(slot);
    data.textureRevision++;
    if (!source) return true;
    const immediate = unwrapPbrTexture(source);
    if (immediate) {
      data.textures[slot] = immediate;
      data.loaded[slot] = true;
      return true;
    }
    const format: GPUTextureFormat = getPbrTextureFormat(slot);
    void this.options.assets.loadTexture(
      source as string | ImageBitmap | HTMLCanvasElement | HTMLImageElement | CompressedTextureSourceDescriptor,
      { format, mipmaps: 'generate', signal: this.options.signal },
    ).then(handle => {
      if ((this.disposed || this.options.signal.aborted) || data.disposed || data.sources[slot] !== source) {
        handle.release();
        return;
      }
      data.handles[slot] = handle;
      this.recorded.own(handle, () => handle.release());
      data.textures[slot] = handle.value;
      data.loaded[slot] = true;
      data.textureRevision++;
      this._rebuildMaterialBindGroups(data);
    }).catch(error => {
      if (!(this.disposed || this.options.signal.aborted)) console.warn(`[PbrRenderer] Failed to load ${slot} texture.`, error);
    });
    return true;
  }

  private _buildMaterialBindGroup(data: MaterialGpuData, transmission = false): GPUBindGroup {
    const slots = transmission ? TRANSMISSION_BINDING_SLOTS : PBR_BASE_BINDING_SLOTS;
    const group = this.options.device.createBindGroup({
      layout: this.options.layout,
      entries: [
        { binding: 0, resource: { buffer: data.buffer } },
        ...slots.map((slot, index) => ({ binding: index + 1, resource: data.textures[slot].createView() })),
        ...slots.map((slot, index) => ({ binding: index + 1 + slots.length, resource: data.samplers[slot] })),
      ],
    });
    return this.recorded.own(group, () => getInstrumentedGPUResourceTracker(this.options.device)?.untrackObject(group));
  }

  private _rebuildMaterialBindGroups(data: MaterialGpuData): void {
    const previous = [data.bindGroup, data.transmissionBindGroup];
    data.bindGroup = this._buildMaterialBindGroup(data);
    data.transmissionBindGroup = this._buildMaterialBindGroup(data, true);
    for (const group of previous) this.recorded.retire(group);
  }

  private _defaultForSlot(slot: PbrTextureSlot): GPUTexture {
    if (slot === 'normal' || slot === 'clearcoatNormal') return this.options.normal;
    if (slot === 'emissive') return this.options.black;
    return this.options.white;
  }

  private _getSampler(descriptor: GPUSamplerDescriptor | null): GPUSampler {
    if (!descriptor) return this.options.defaultSampler;
    const key = this._samplerKey(descriptor);
    let sampler = this._samplers.get(key);
    if (!sampler) {
      sampler = this.options.device.createSampler(descriptor);
      this._samplers.set(key, sampler);
    }
    return sampler;
  }

  private _samplerKey(descriptor: GPUSamplerDescriptor | null): string {
    return descriptor ? JSON.stringify(descriptor, Object.keys(descriptor).sort()) : 'default';
  }

  private _destroyMaterial(data: MaterialGpuData): void {
    data.disposed = true;
    this.recorded.retire(data.buffer);
    this.recorded.retire(data.bindGroup);
    this.recorded.retire(data.transmissionBindGroup);
    for (const handle of Object.values(data.handles)) if (handle) this.recorded.retire(handle);
  }

  destroy(): void {
    this.disposed = true;
    this.entries.clear();
    this._samplers.clear();
  }
}
