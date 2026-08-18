import type { IEngine } from '../core/IEngine';
import type { Geometry2D } from '../geometry/Geometry2D';
import type { Material2D } from '../material/Material2D';
import { MaterialRegistryBase } from './MaterialRegistryBase';
import type { MaterialConstructor, MaterialRenderContract, MaterialRendererKey } from './MaterialRegistryBase';

export type Material2DConstructor<M extends Material2D = Material2D> = MaterialConstructor<M>;
export type Material2DRendererKey<M extends Material2D = Material2D> = MaterialRendererKey<M>;

export interface Material2DRenderContext<M extends Material2D = Material2D> {
  engine: IEngine;
  passEncoder: GPURenderPassEncoder;
  entityId: number;
  geometry: Geometry2D;
  material: M;
  worldMatrix: Float32Array;
  reverseZ: boolean;
  msaaSamples: 1 | 4;
}

export interface Material2DRenderBatchItem<M extends Material2D = Material2D> {
  entityId: number;
  geometry: Geometry2D;
  material: M;
  worldMatrix: Float32Array;
}

export interface Material2DRendererRegistration<M extends Material2D = Material2D> extends MaterialRenderContract<M> {
  render(context: Material2DRenderContext<M>): void;
  renderBatch?: (context: Material2DRenderContext<M>, items: readonly Material2DRenderBatchItem<M>[]) => void;
}

export class Material2DRendererRegistry extends MaterialRegistryBase<Material2D, Material2DRendererRegistration> {
  register<M extends Material2D>(registration: Material2DRendererRegistration<M>): this {
    return super.register(registration as unknown as Material2DRendererRegistration);
  }

  unregister(materialType: Material2DRendererKey): this {
    return super.unregister(materialType);
  }

  resolve<M extends Material2D>(material: M): Material2DRendererRegistration<M> | null {
    return this.resolveRegistration(material) as unknown as Material2DRendererRegistration<M> | null;
  }
}
