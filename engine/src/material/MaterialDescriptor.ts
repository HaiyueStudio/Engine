import { PbrMaterial, type PbrMaterialState } from './PbrMaterial';
import { ToonMaterial, type ToonMaterialState } from './ToonMaterial';

export interface MaterialDescriptorVariant {
  readonly name: string;
  readonly state: Readonly<PbrMaterialState>;
}

/**
 * Importer-neutral material boundary.
 *
 * Importers produce descriptors; the engine owns validation and concrete
 * material construction. New shading models extend this discriminated
 * contract instead of making importers depend on renderer classes.
 */
export interface PbrMaterialDescriptor {
  readonly shadingModel: 'pbr-metallic-roughness';
  readonly state: Readonly<PbrMaterialState>;
  readonly variants?: readonly MaterialDescriptorVariant[];
}

export interface ToonMaterialDescriptor {
  readonly shadingModel: 'toon';
  readonly state: Readonly<ToonMaterialState>;
}

export type MaterialDescriptor = PbrMaterialDescriptor | ToonMaterialDescriptor;

export function createMaterialFromDescriptor(descriptor: PbrMaterialDescriptor): PbrMaterial;
export function createMaterialFromDescriptor(descriptor: ToonMaterialDescriptor): ToonMaterial;
export function createMaterialFromDescriptor(descriptor: MaterialDescriptor): PbrMaterial | ToonMaterial;
export function createMaterialFromDescriptor(descriptor: MaterialDescriptor): PbrMaterial | ToonMaterial {
  switch (descriptor.shadingModel) {
    case 'pbr-metallic-roughness':
      return new PbrMaterial({
        ...descriptor.state,
        ...(descriptor.variants === undefined ? {} : { variants: descriptor.variants }),
      });
    case 'toon':
      return new ToonMaterial(descriptor.state);
    default:
      throw new RangeError(`Unsupported material descriptor shading model: ${String((descriptor as MaterialDescriptor).shadingModel)}.`);
  }
}
