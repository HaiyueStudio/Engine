import { SHADER_COORDINATE_SPACES, type ShaderColorSpace, type ShaderCoordinateSpace } from '../contracts';
import { shaderError } from '../diagnostics';
import type { ShaderIrValueTypeDefinition } from '../ir/types';

export function shaderGraphValueType(
  valueType: string,
  options: { readonly space?: string; readonly colorSpace?: ShaderColorSpace; readonly path: string },
): ShaderIrValueTypeDefinition {
  const color = /^color([34])<f32>$/.exec(valueType);
  if (color) {
    const colorSpace = options.colorSpace;
    if (colorSpace !== 'linear' && colorSpace !== 'srgb') {
      invalid(options.path, `${valueType} requires explicit linear or srgb colorSpace.`);
    }
    return Object.freeze({
      dataType: `vec${color[1]}<f32>` as 'vec3<f32>' | 'vec4<f32>',
      semantic: 'color' as const,
      colorSpace,
    });
  }
  const spatial = /^(position|direction|normal)(3|4)<f32>$/.exec(valueType);
  if (spatial) {
    if (!options.space) invalid(options.path, `${valueType} requires an explicit coordinate space.`);
    if (!SHADER_COORDINATE_SPACES.includes(options.space as ShaderCoordinateSpace)) invalid(options.path, `Unknown coordinate space ${options.space}.`);
    if (spatial[1] !== 'position' && spatial[2] !== '3') invalid(options.path, `${valueType} must have three components.`);
    return Object.freeze({
      dataType: `vec${spatial[2]}<f32>` as 'vec3<f32>' | 'vec4<f32>',
      semantic: spatial[1] as 'position' | 'direction' | 'normal',
      coordinateSpace: options.space as ShaderCoordinateSpace,
    });
  }
  if (valueType === 'uv2<f32>') {
    if (!options.space) invalid(options.path, 'uv2<f32> requires an explicit coordinate space.');
    if (!SHADER_COORDINATE_SPACES.includes(options.space as ShaderCoordinateSpace)) invalid(options.path, `Unknown coordinate space ${options.space}.`);
    return Object.freeze({
      dataType: 'vec2<f32>' as const,
      semantic: 'uv' as const,
      coordinateSpace: options.space as ShaderCoordinateSpace,
    });
  }
  if (/^(?:bool|i32|u32|f32|vec[234]<(?:bool|i32|u32|f32)>|mat([234])x\1<f32>)$/.test(valueType)) {
    return valueType as ShaderIrValueTypeDefinition;
  }
  invalid(options.path, `Unsupported Shader Graph value type ${valueType}.`);
}

function invalid(path: string, message: string): never {
  shaderError('E_SHADER_GRAPH_INVALID', message, { moduleId: '@shader-graph-v1', path });
}
