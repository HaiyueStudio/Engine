import type { Material } from '../material/Material';
import { RendererRegistrationRegistry } from './RendererRegistrationRegistry';

export type MaterialConstructor<M extends Material = Material> = new (...args: never[]) => M;
export type MaterialRendererKey<M extends Material = Material> = MaterialConstructor<M> | string;

export interface MaterialRenderContract<M extends Material = Material> {
  readonly materialType: MaterialRendererKey<M>;
  isTransparent?: (material: M) => boolean;
  transparentOrder?: (material: M) => number;
  transparentDepthSort?: (material: M) => boolean;
  destroy?: () => void;
}

export abstract class MaterialRegistryBase<
  MMaterial extends Material,
  TRegistration extends MaterialRenderContract<MMaterial>,
> extends RendererRegistrationRegistry<MMaterial, TRegistration> {
  private readonly _byMaterialType = new Map<string, TRegistration>();

  register<M extends MMaterial>(registration: TRegistration & MaterialRenderContract<M>): this {
    const typedRegistration = registration as unknown as TRegistration;
    if (typeof registration.materialType === 'string') {
      this.unregister(registration.materialType);
      this.registrations.push(typedRegistration);
      this._byMaterialType.set(registration.materialType, typedRegistration);
      this._markChanged();
      return this;
    }
    return this.registerType(registration.materialType as MaterialConstructor<MMaterial>, typedRegistration);
  }

  unregister(materialType: MaterialRendererKey<MMaterial>): this {
    if (typeof materialType !== 'string') return this.unregisterType(materialType);
    const current = this._byMaterialType.get(materialType);
    if (!current) return this;
    this._byMaterialType.delete(materialType);
    const index = this.registrations.indexOf(current);
    if (index >= 0) this.registrations.splice(index, 1);
    current.destroy?.();
    this._markChanged();
    return this;
  }

  protected resolveRegistration<M extends MMaterial>(material: M): TRegistration | null {
    const byType = this._byMaterialType.get(material.type);
    if (byType) return byType;
    return this.resolveFor(material);
  }

  override destroy(): void {
    super.destroy();
    this._byMaterialType.clear();
  }

  protected matches(material: MMaterial, registration: TRegistration): boolean {
    if (typeof registration.materialType === 'string') return registration.materialType === material.type;
    return material instanceof registration.materialType;
  }
}
