import {
  SHADER_COLOR_SPACES,
  SHADER_COORDINATE_SPACES,
  type ShaderColorSpace,
  type ShaderCoordinateSpace,
} from '../contracts';
import { shaderError } from '../diagnostics';

export const SHADER_IR_SCALAR_TYPES = ['bool', 'i32', 'u32', 'f32'] as const;
export type ShaderIrScalarType = typeof SHADER_IR_SCALAR_TYPES[number];
export type ShaderIrVectorWidth = 2 | 3 | 4;
export type ShaderIrVectorType = `vec${ShaderIrVectorWidth}<${ShaderIrScalarType}>`;
export type ShaderIrMatrixType = 'mat2x2<f32>' | 'mat3x3<f32>' | 'mat4x4<f32>';
export type ShaderIrDataType = ShaderIrScalarType | ShaderIrVectorType | ShaderIrMatrixType;
export type ShaderIrSemantic = 'value' | 'position' | 'direction' | 'normal' | 'uv' | 'color' | 'transform';

export interface ShaderIrValueType {
  readonly dataType: ShaderIrDataType;
  readonly semantic: ShaderIrSemantic;
  readonly coordinateSpace?: ShaderCoordinateSpace;
  readonly colorSpace?: Exclude<ShaderColorSpace, 'data'>;
  readonly fromSpace?: ShaderCoordinateSpace;
  readonly toSpace?: ShaderCoordinateSpace;
}

export type ShaderIrValueTypeDefinition = ShaderIrDataType | {
  readonly dataType: ShaderIrDataType;
  readonly semantic?: ShaderIrSemantic;
  readonly coordinateSpace?: ShaderCoordinateSpace;
  readonly colorSpace?: Exclude<ShaderColorSpace, 'data'>;
  readonly fromSpace?: ShaderCoordinateSpace;
  readonly toSpace?: ShaderCoordinateSpace;
};

export interface ShaderIrDataTypeInfo {
  readonly dataType: ShaderIrDataType;
  readonly kind: 'scalar' | 'vector' | 'matrix';
  readonly scalarType: ShaderIrScalarType;
  readonly width: number;
  readonly rows: number;
}

export function shaderValueType(definition: ShaderIrValueTypeDefinition): ShaderIrValueType {
  return normalizeShaderIrValueType(definition, '@authoring', 'type');
}

export function normalizeShaderIrValueType(
  definition: ShaderIrValueTypeDefinition,
  moduleId: string,
  path: string,
): ShaderIrValueType {
  const dataType = typeof definition === 'string' ? definition : definition.dataType;
  const semantic = typeof definition === 'string' ? 'value' : definition.semantic ?? 'value';
  const coordinateSpace = typeof definition === 'string' ? undefined : definition.coordinateSpace;
  const colorSpace = typeof definition === 'string' ? undefined : definition.colorSpace;
  const fromSpace = typeof definition === 'string' ? undefined : definition.fromSpace;
  const toSpace = typeof definition === 'string' ? undefined : definition.toSpace;
  const info = parseShaderIrDataType(dataType, moduleId, `${path}.dataType`);

  if (!['value', 'position', 'direction', 'normal', 'uv', 'color', 'transform'].includes(semantic)) {
    invalid(moduleId, `${path}.semantic`, `Unknown shader semantic ${semantic}.`);
  }
  if (coordinateSpace !== undefined && !SHADER_COORDINATE_SPACES.includes(coordinateSpace)) {
    invalid(moduleId, `${path}.coordinateSpace`, `Unknown coordinate space ${coordinateSpace}.`);
  }
  if (colorSpace !== undefined && !SHADER_COLOR_SPACES.includes(colorSpace)) {
    invalid(moduleId, `${path}.colorSpace`, `Unknown color space ${colorSpace}.`);
  }
  if (fromSpace !== undefined && !SHADER_COORDINATE_SPACES.includes(fromSpace)) {
    invalid(moduleId, `${path}.fromSpace`, `Unknown transform source space ${fromSpace}.`);
  }
  if (toSpace !== undefined && !SHADER_COORDINATE_SPACES.includes(toSpace)) {
    invalid(moduleId, `${path}.toSpace`, `Unknown transform target space ${toSpace}.`);
  }

  if (semantic === 'position') {
    if (info.scalarType !== 'f32' || info.kind !== 'vector' || (info.width !== 3 && info.width !== 4)) {
      invalid(moduleId, path, `Position requires vec3<f32> or vec4<f32>, got ${dataType}.`);
    }
    if (!coordinateSpace) invalid(moduleId, `${path}.coordinateSpace`, 'Position requires an explicit coordinate space.');
  } else if (semantic === 'direction' || semantic === 'normal') {
    if (dataType !== 'vec3<f32>') invalid(moduleId, path, `${semantic} requires vec3<f32>, got ${dataType}.`);
    if (!coordinateSpace) invalid(moduleId, `${path}.coordinateSpace`, `${semantic} requires an explicit coordinate space.`);
  } else if (semantic === 'uv') {
    if (dataType !== 'vec2<f32>') invalid(moduleId, path, `UV requires vec2<f32>, got ${dataType}.`);
    if (!coordinateSpace) invalid(moduleId, `${path}.coordinateSpace`, 'UV requires an explicit coordinate space.');
  } else if (semantic === 'color') {
    if (info.scalarType !== 'f32' || info.kind !== 'vector' || (info.width !== 3 && info.width !== 4)) {
      invalid(moduleId, path, `Color requires vec3<f32> or vec4<f32>, got ${dataType}.`);
    }
    if (!colorSpace) invalid(moduleId, `${path}.colorSpace`, 'Color requires an explicit linear or srgb color space.');
  } else if (semantic === 'transform') {
    if (info.kind !== 'matrix' || info.scalarType !== 'f32') {
      invalid(moduleId, path, `Transform requires an f32 matrix, got ${dataType}.`);
    }
    if (!fromSpace || !toSpace || fromSpace === toSpace) {
      invalid(moduleId, path, 'Transform requires distinct explicit fromSpace and toSpace values.');
    }
  }

  if (semantic !== 'position' && semantic !== 'direction' && semantic !== 'normal' && semantic !== 'uv' && coordinateSpace !== undefined) {
    invalid(moduleId, `${path}.coordinateSpace`, `${semantic} values cannot carry a coordinate space.`);
  }
  if (semantic !== 'color' && colorSpace !== undefined) {
    invalid(moduleId, `${path}.colorSpace`, `${semantic} values cannot carry a color space.`);
  }
  if (semantic !== 'transform' && (fromSpace !== undefined || toSpace !== undefined)) {
    invalid(moduleId, path, `${semantic} values cannot carry transform from/to spaces.`);
  }

  return Object.freeze({
    dataType,
    semantic,
    ...(coordinateSpace === undefined ? {} : { coordinateSpace }),
    ...(colorSpace === undefined ? {} : { colorSpace }),
    ...(fromSpace === undefined ? {} : { fromSpace }),
    ...(toSpace === undefined ? {} : { toSpace }),
  });
}

export function parseShaderIrDataType(
  dataType: string,
  moduleId = '@authoring',
  path = 'dataType',
): ShaderIrDataTypeInfo {
  if ((SHADER_IR_SCALAR_TYPES as readonly string[]).includes(dataType)) {
    return Object.freeze({
      dataType: dataType as ShaderIrScalarType,
      kind: 'scalar' as const,
      scalarType: dataType as ShaderIrScalarType,
      width: 1,
      rows: 1,
    });
  }
  const vector = /^vec([234])<(bool|i32|u32|f32)>$/.exec(dataType);
  if (vector) {
    const width = Number(vector[1]);
    return Object.freeze({
      dataType: dataType as ShaderIrVectorType,
      kind: 'vector' as const,
      scalarType: vector[2] as ShaderIrScalarType,
      width,
      rows: 1,
    });
  }
  const matrix = /^mat([234])x\1<f32>$/.exec(dataType);
  if (matrix) {
    const width = Number(matrix[1]);
    return Object.freeze({
      dataType: dataType as ShaderIrMatrixType,
      kind: 'matrix' as const,
      scalarType: 'f32' as const,
      width,
      rows: width,
    });
  }
  invalid(moduleId, path, `Unsupported stage 2 shader data type ${dataType}.`);
}

export function shaderIrValueTypeKey(type: ShaderIrValueType): string {
  return [
    type.dataType,
    type.semantic,
    type.coordinateSpace ?? '-',
    type.colorSpace ?? '-',
    type.fromSpace ?? '-',
    type.toSpace ?? '-',
  ].join('|');
}

export function shaderIrValueTypesEqual(left: ShaderIrValueType, right: ShaderIrValueType): boolean {
  return shaderIrValueTypeKey(left) === shaderIrValueTypeKey(right);
}

export function genericShaderIrType(dataType: ShaderIrDataType): ShaderIrValueType {
  return Object.freeze({ dataType, semantic: 'value' });
}

function invalid(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId, path });
}
