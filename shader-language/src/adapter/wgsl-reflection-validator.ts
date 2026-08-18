import type {
  PrecompiledShaderBindingLayoutV2,
  PrecompiledShaderPassV2,
} from './precompiled-artifact-contract';
import { shaderError } from '../diagnostics';

interface ReflectedBinding {
  readonly group: number;
  readonly binding: number;
  readonly layout: PrecompiledShaderBindingLayoutV2;
}

/** Verifies that production binding metadata cannot drift from the generated WGSL declarations. */
export function validateWgslBindingReflection(pass: Omit<PrecompiledShaderPassV2, 'canonicalHash'>): void {
  const sourceBindings = reflectBindings(pass.code, pass.id);
  const declared = new Map(pass.bindGroups.flatMap(group => group.bindings.map(binding => [
    bindingKey(group.physicalGroup, binding.binding),
    binding,
  ] as const)));
  if (sourceBindings.size !== declared.size) {
    invalid(pass.id, 'bindGroups', `WGSL declares ${sourceBindings.size} bindings but reflection declares ${declared.size}.`);
  }
  for (const [key, source] of sourceBindings) {
    const binding = declared.get(key);
    if (!binding) invalid(pass.id, `bindGroups.${key}`, `WGSL binding ${key} is missing from reflection.`);
    if (!sameLayout(source.layout, binding!.layout)) {
      invalid(pass.id, `bindGroups.${key}.layout`, `WGSL binding ${key} does not match its reflected layout.`);
    }
  }
}

function reflectBindings(source: string, passId: string): ReadonlyMap<string, ReflectedBinding> {
  const result = new Map<string, ReflectedBinding>();
  const declaration = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]+)>)?\s+[A-Za-z_]\w*\s*:\s*([^;]+);/g;
  for (const match of source.matchAll(declaration)) {
    const group = Number(match[1]);
    const binding = Number(match[2]);
    const key = bindingKey(group, binding);
    if (result.has(key)) invalid(passId, `code.${key}`, `WGSL declares duplicate binding ${key}.`);
    result.set(key, Object.freeze({
      group,
      binding,
      layout: reflectLayout(match[3]?.trim() ?? '', match[4]!.trim(), passId, key),
    }));
  }
  return result;
}

function reflectLayout(addressSpace: string, type: string, passId: string, key: string): PrecompiledShaderBindingLayoutV2 {
  if (addressSpace === 'uniform') {
    return { kind: 'buffer', bufferType: 'uniform', hasDynamicOffset: false, minBindingSize: 0 };
  }
  if (addressSpace.startsWith('storage')) {
    return {
      kind: 'buffer',
      bufferType: addressSpace.includes('read_write') ? 'storage' : 'read-only-storage',
      hasDynamicOffset: false,
      minBindingSize: 0,
    };
  }
  if (type === 'sampler') return { kind: 'sampler', samplerType: 'filtering' };
  if (type === 'sampler_comparison') return { kind: 'sampler', samplerType: 'comparison' };
  if (type === 'texture_external') return { kind: 'external-texture' };
  const storage = /^texture_storage_(1d|2d|2d_array|3d)<\s*([^,]+),\s*([^>]+)>$/.exec(type);
  if (storage) {
    return {
      kind: 'storage-texture',
      viewDimension: storageDimension(storage[1]!),
      format: storage[2]!.trim(),
      access: storage[3]!.trim() as 'write-only' | 'read-only' | 'read-write',
    };
  }
  const depth = /^texture_depth_(2d|2d_array|cube|cube_array)$/.exec(type);
  if (depth) {
    return { kind: 'texture', sampleType: 'depth', viewDimension: dimension(depth[1]!), multisampled: false };
  }
  const texture = /^texture_(multisampled_)?(1d|2d|2d_array|cube|cube_array|3d)<\s*(f32|i32|u32)\s*>$/.exec(type);
  if (texture) {
    return {
      kind: 'texture',
      sampleType: texture[3] === 'i32' ? 'sint' : texture[3] === 'u32' ? 'uint' : 'float',
      viewDimension: dimension(texture[2]!),
      multisampled: Boolean(texture[1]),
    };
  }
  return invalid(passId, `code.${key}`, `Unsupported production WGSL resource type ${type}.`);
}

function sameLayout(source: PrecompiledShaderBindingLayoutV2, declared: PrecompiledShaderBindingLayoutV2): boolean {
  if (source.kind !== declared.kind) return false;
  switch (source.kind) {
    case 'buffer':
      return declared.kind === 'buffer' && source.bufferType === declared.bufferType;
    case 'sampler':
      return declared.kind === 'sampler' && source.samplerType === declared.samplerType;
    case 'texture':
      return declared.kind === 'texture'
        && (source.sampleType === declared.sampleType || (source.sampleType === 'float' && declared.sampleType === 'unfilterable-float'))
        && source.viewDimension === declared.viewDimension
        && source.multisampled === declared.multisampled;
    case 'storage-texture':
      return declared.kind === 'storage-texture'
        && normalizeAccess(source.access) === normalizeAccess(declared.access)
        && source.format === declared.format
        && source.viewDimension === declared.viewDimension;
    case 'external-texture':
      return declared.kind === 'external-texture';
  }
}

function normalizeAccess(value: string): string {
  if (value === 'write') return 'write-only';
  if (value === 'read') return 'read-only';
  if (value === 'read_write') return 'read-write';
  return value.replace('_', '-');
}

function dimension(value: string): '1d' | '2d' | '2d-array' | 'cube' | 'cube-array' | '3d' {
  return value.replace('_array', '-array') as '1d' | '2d' | '2d-array' | 'cube' | 'cube-array' | '3d';
}

function storageDimension(value: string): '1d' | '2d' | '2d-array' | '3d' {
  return value.replace('_array', '-array') as '1d' | '2d' | '2d-array' | '3d';
}

function bindingKey(group: number, binding: number): string {
  return `${group}:${binding}`;
}

function invalid(passId: string, path: string, message: string): never {
  shaderError('E_SHADER_RESOURCE_CONFLICT', message, {
    moduleId: `@precompiled-shader-artifact-v2/${passId}`,
    path,
  });
}
