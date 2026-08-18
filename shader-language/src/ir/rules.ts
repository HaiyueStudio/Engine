import type { ShaderCoordinateSpace } from '../contracts';
import { shaderError } from '../diagnostics';
import {
  genericShaderIrType,
  parseShaderIrDataType,
  shaderIrValueTypeKey,
  type ShaderIrDataType,
  type ShaderIrSemantic,
  type ShaderIrValueType,
} from './types';

export function validateShaderIrLiteral(
  dataType: ShaderIrDataType,
  value: boolean | number | readonly number[],
  moduleId: string,
  path: string,
): boolean | number | readonly number[] {
  const info = parseShaderIrDataType(dataType, moduleId, path);
  const expectedCount = info.width * info.rows;
  if (info.kind === 'scalar') {
    if (Array.isArray(value)) throwShaderIrTypeError(moduleId, path, dataType, `array(${value.length})`);
    validateScalarLiteral(info.scalarType, value as boolean | number, moduleId, path);
    return normalizeNumber(value as boolean | number);
  }
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throwShaderIrTypeError(moduleId, path, `${dataType} with ${expectedCount} values`, Array.isArray(value) ? `array(${value.length})` : typeof value);
  }
  return Object.freeze(value.map((item, index) => {
    validateScalarLiteral(info.scalarType, item, moduleId, `${path}.${index}`);
    return normalizeNumber(item) as number;
  }));
}

export function assertSameShaderIrType(
  left: ShaderIrValueType,
  right: ShaderIrValueType,
  moduleId: string,
  path: string,
): void {
  if (left.dataType !== right.dataType) {
    throwShaderIrTypeError(moduleId, path, shaderIrValueTypeKey(left), shaderIrValueTypeKey(right));
  }
  if (left.coordinateSpace !== right.coordinateSpace || left.fromSpace !== right.fromSpace || left.toSpace !== right.toSpace) {
    shaderError('E_SHADER_SPACE_MISMATCH', `Coordinate/transform-space mismatch: ${shaderIrValueTypeKey(left)} vs ${shaderIrValueTypeKey(right)}.`, {
      moduleId,
      path,
      details: { expected: shaderIrValueTypeKey(left), actual: shaderIrValueTypeKey(right) },
    });
  }
  if (left.semantic !== right.semantic || left.colorSpace !== right.colorSpace) {
    shaderError('E_SHADER_SEMANTIC_MISMATCH', `Semantic mismatch: ${shaderIrValueTypeKey(left)} vs ${shaderIrValueTypeKey(right)}.`, {
      moduleId,
      path,
      details: { expected: shaderIrValueTypeKey(left), actual: shaderIrValueTypeKey(right) },
    });
  }
}

export function isCompatibleShaderIrScalarMultiplier(
  scalar: ShaderIrValueType,
  value: ShaderIrValueType,
): boolean {
  const scalarInfo = parseShaderIrDataType(scalar.dataType);
  const valueInfo = parseShaderIrDataType(value.dataType);
  return scalar.semantic === 'value'
    && scalarInfo.kind === 'scalar'
    && scalarInfo.scalarType !== 'bool'
    && scalarInfo.scalarType === valueInfo.scalarType
    && (valueInfo.kind === 'vector' || valueInfo.kind === 'matrix');
}

export function ensureShaderIrNumeric(type: ShaderIrValueType, moduleId: string, path: string): void {
  const info = parseShaderIrDataType(type.dataType, moduleId, path);
  if (info.scalarType === 'bool') throwShaderIrTypeError(moduleId, path, 'numeric type', type.dataType);
  if (type.semantic === 'transform') {
    shaderError('E_SHADER_SEMANTIC_MISMATCH', 'Transform matrices require an explicit transform/composition operation.', {
      moduleId,
      path,
      details: { type: shaderIrValueTypeKey(type) },
    });
  }
}

export function preservedShaderIrSwizzleType(
  input: ShaderIrValueType,
  dataType: ShaderIrDataType,
): ShaderIrValueType {
  const info = parseShaderIrDataType(dataType);
  if (input.semantic === 'color' && info.kind === 'vector' && (info.width === 3 || info.width === 4)) {
    return Object.freeze({ dataType, semantic: 'color', colorSpace: input.colorSpace! });
  }
  if (input.semantic === 'uv' && dataType === 'vec2<f32>') {
    return Object.freeze({ dataType, semantic: 'uv', coordinateSpace: input.coordinateSpace! });
  }
  if (input.semantic === 'position' && (dataType === 'vec3<f32>' || dataType === 'vec4<f32>')) {
    return Object.freeze({ dataType, semantic: 'position', coordinateSpace: input.coordinateSpace! });
  }
  if ((input.semantic === 'direction' || input.semantic === 'normal') && dataType === 'vec3<f32>') {
    return Object.freeze({ dataType, semantic: input.semantic, coordinateSpace: input.coordinateSpace! });
  }
  return genericShaderIrType(dataType);
}

export function requireShaderIrTransform(
  type: ShaderIrValueType,
  allowed: readonly ShaderIrDataType[],
  fromSpace: ShaderCoordinateSpace,
  toSpace: ShaderCoordinateSpace,
  moduleId: string,
  path: string,
): void {
  if (type.semantic !== 'transform' || !allowed.includes(type.dataType)) {
    throwShaderIrTypeError(moduleId, path, `${allowed.join(' or ')} transform ${fromSpace}->${toSpace}`, shaderIrValueTypeKey(type));
  }
  if (type.fromSpace !== fromSpace || type.toSpace !== toSpace) {
    shaderError('E_SHADER_SPACE_MISMATCH', `Transform maps ${type.fromSpace}->${type.toSpace}, not ${fromSpace}->${toSpace}.`, {
      moduleId,
      path,
      details: { expectedFrom: fromSpace, expectedTo: toSpace, actualFrom: type.fromSpace, actualTo: type.toSpace },
    });
  }
}

export function requireShaderIrSemantic(
  type: ShaderIrValueType,
  semantic: ShaderIrSemantic,
  moduleId: string,
  path: string,
): void {
  if (type.semantic !== semantic) {
    shaderError('E_SHADER_SEMANTIC_MISMATCH', `Expected ${semantic}, got ${shaderIrValueTypeKey(type)}.`, {
      moduleId,
      path,
    });
  }
}

export function requireShaderIrTargetSpace(
  input: ShaderIrValueType,
  toSpace: ShaderCoordinateSpace | undefined,
  moduleId: string,
  path: string,
): ShaderCoordinateSpace {
  if (!toSpace) shaderError('E_SHADER_SPACE_MISMATCH', 'Space transform requires an explicit target space.', { moduleId, path });
  if (toSpace === input.coordinateSpace) {
    shaderError('E_SHADER_SPACE_MISMATCH', `Space transform cannot map ${toSpace} to itself.`, {
      moduleId,
      path,
      details: { fromSpace: input.coordinateSpace, toSpace },
    });
  }
  return toSpace;
}

export function throwShaderIrTypeError(moduleId: string, path: string, expected: string, actual: string): never {
  shaderError('E_SHADER_TYPE_MISMATCH', `Shader type mismatch: expected ${expected}, got ${actual}.`, {
    moduleId,
    path,
    details: { expected, actual },
  });
}

export function throwShaderIrResourceError(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_IR_RESOURCE_INVALID', message, { moduleId, path });
}

function validateScalarLiteral(
  type: string,
  value: boolean | number,
  moduleId: string,
  path: string,
): void {
  if (type === 'bool') {
    if (typeof value !== 'boolean') throwShaderIrTypeError(moduleId, path, 'bool', typeof value);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throwShaderIrTypeError(moduleId, path, type, String(value));
  if ((type === 'i32' || type === 'u32') && !Number.isInteger(value)) throwShaderIrTypeError(moduleId, path, type, String(value));
  if (type === 'u32' && value < 0) throwShaderIrTypeError(moduleId, path, type, String(value));
}

function normalizeNumber(value: boolean | number): boolean | number {
  return typeof value === 'number' && Object.is(value, -0) ? 0 : value;
}
