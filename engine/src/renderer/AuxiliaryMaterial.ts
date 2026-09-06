import type { Geometry3D } from '../geometry/Geometry3D';
import type { Material } from '../material/Material';
import { BasicMaterial } from '../material/BasicMaterial';
import { BlinnPhongMaterial } from '../material/BlinnPhongMaterial';
import { PbrMaterial } from '../material/PbrMaterial';
import { ToonMaterial } from '../material/ToonMaterial';

/** Borrowed PBR resources: the forward renderer remains their only owner. */
export interface MaterialCoverageResources {
  readonly buffer: GPUBuffer;
  readonly textures: { readonly baseColor: GPUTexture };
  readonly samplers: { readonly baseColor: GPUSampler };
  readonly textureRevision: number;
}

export type MaterialCoverageResolver = (material: Material) => MaterialCoverageResources | null;

export function auxiliaryCullMode(geometry: Geometry3D, material?: Material | null): GPUCullMode {
  if (material instanceof BasicMaterial) return material.cullMode ?? geometry.cullMode ?? 'back';
  if (material instanceof PbrMaterial || material instanceof ToonMaterial) {
    return material.doubleSided ? 'none' : geometry.cullMode ?? 'back';
  }
  return geometry.cullMode ?? 'back';
}

export function auxiliaryFrontFace(geometry: Geometry3D, material?: Material | null): GPUFrontFace {
  return (material instanceof BasicMaterial ? material.frontFace : null) ?? geometry.frontFace ?? 'ccw';
}

/** Reconstruct the surfaces actually written to the main depth attachment. */
export function auxiliaryWritesDepth(material: Material | null): boolean {
  if (material instanceof BasicMaterial) return material.depthWrite;
  if (material instanceof BlinnPhongMaterial) return material.blending === 'none';
  if (material instanceof PbrMaterial || material instanceof ToonMaterial) return material.alphaMode !== 'blend';
  return material?.type !== 'volume';
}

/** Lit legacy/custom vertex paths do not implicitly opt into GPU deformation. */
export function auxiliaryUsesDeformation(material?: Material | null): boolean {
  return !material || material.type === 'basic' || material.type === 'pbr-metallic-roughness'
    || material.type === 'depth' || material.type === 'normal';
}

// GPUShaderStage.FRAGMENT is 2; importing renderer modules also works before GPU globals are installed.
export const MATERIAL_COVERAGE_LAYOUT: readonly GPUBindGroupLayoutEntry[] = [
  { binding: 1, visibility: 2, buffer: { type: 'uniform', minBindingSize: 192 } },
  { binding: 2, visibility: 2, texture: { sampleType: 'float' } },
  { binding: 3, visibility: 2, sampler: { type: 'filtering' } },
];

/** Creates pass bindings without copying uniforms or owning forward textures. */
export class MaterialCoverageBindings {
  private readonly fallback: MaterialCoverageResources;
  private readonly bindings = new WeakMap<GPUBuffer, {
    texture: GPUTexture;
    sampler: GPUSampler;
    groups: WeakMap<object, GPUBindGroup>;
  }>();

  constructor(private readonly device: GPUDevice, private readonly layout: GPUBindGroupLayout) {
    // Prefix of PBR's existing material ABI, through baseColor's two UV rows.
    const buffer = device.createBuffer({ label: 'MaterialCoverage.opaque', size: 192, usage: GPUBufferUsage.UNIFORM });
    const texture = device.createTexture({
      label: 'MaterialCoverage.fallback', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.fallback = { buffer, textures: { baseColor: texture }, samplers: { baseColor: device.createSampler() }, textureRevision: 0 };
  }

  get(source: MaterialCoverageResources | null = null, parameters: GPUBuffer | null = null): GPUBindGroup {
    const resources = source ?? this.fallback;
    const texture = resources.textures.baseColor;
    const sampler = resources.samplers.baseColor;
    let entry = this.bindings.get(resources.buffer);
    if (!entry || entry.texture !== texture || entry.sampler !== sampler) {
      entry = { texture, sampler, groups: new WeakMap() };
      this.bindings.set(resources.buffer, entry);
    }
    let group = entry.groups.get(parameters ?? this);
    if (!group) {
      group = this.device.createBindGroup({
        label: 'MaterialCoverage.bindGroup', layout: this.layout,
        entries: [
          ...(parameters ? [{ binding: 0, resource: { buffer: parameters } }] : []),
          { binding: 1, resource: { buffer: resources.buffer, size: 192 } },
          { binding: 2, resource: texture.createView() },
          { binding: 3, resource: sampler },
        ],
      });
      entry.groups.set(parameters ?? this, group);
    }
    return group;
  }

  destroy(): void {
    this.fallback.buffer.destroy();
    this.fallback.textures.baseColor.destroy();
  }
}
