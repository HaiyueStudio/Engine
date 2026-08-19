import { AnimationExtensionRegistry, type AnimationExtensionHandler } from '../extensions';
import { DEFORMABLE_MESH_2D_EXTENSION_ID } from './types';

export function createDeformableMesh2DFormatHandler(): AnimationExtensionHandler {
  return {
    id: DEFORMABLE_MESH_2D_EXTENSION_ID,
    validateComponent(component, context) {
      if (component.type !== DEFORMABLE_MESH_2D_EXTENSION_ID) context.fail('Component type does not match the deformable-mesh extension.', `${context.path}.type`);
      if (typeof component.dataResource !== 'string' || component.dataResource.length === 0) context.fail('dataResource must be a non-empty resource id.', `${context.path}.dataResource`);
      if (!Array.isArray(component.textures) || component.textures.length < 1 || component.textures.length > 32) context.fail('textures must contain 1-32 resource ids.', `${context.path}.textures`);
      const textures = component.textures as unknown[];
      for (let index = 0; index < textures.length; index++) {
        const value = textures[index];
        if (typeof value !== 'string' || value.length === 0) context.fail('Texture resource id must be non-empty.', `${context.path}.textures[${index}]`);
      }
    },
  };
}

export function createDeformableMesh2DFormatRegistry(): AnimationExtensionRegistry {
  const registry = new AnimationExtensionRegistry();
  registry.register(createDeformableMesh2DFormatHandler());
  return registry;
}
