import type { ShaderUniformBlockReflection } from './contracts';
import { shaderError } from './diagnostics';

export type ShaderUniformValue = number | readonly number[];

export function packShaderUniformBlock(
  block: ShaderUniformBlockReflection,
  values: Readonly<Record<string, ShaderUniformValue>>,
): ArrayBuffer {
  const unknown = Object.keys(values).filter(name => !block.fields.some(field => field.name === name));
  if (unknown.length > 0) invalid(block.id, unknown[0]!, `Unknown uniform value ${unknown[0]}.`);
  const buffer = new ArrayBuffer(block.byteSize);
  const view = new DataView(buffer);
  for (const field of block.fields) {
    if (!(field.name in values)) invalid(block.id, field.name, `Missing uniform value ${field.name}.`);
    writeField(view, block.id, field, values[field.name]!);
  }
  return buffer;
}

function writeField(
  view: DataView,
  blockId: string,
  field: ShaderUniformBlockReflection['fields'][number],
  value: ShaderUniformValue,
): void {
  const scalar = /^(f32|i32|u32)$/.exec(field.type);
  if (scalar) {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(blockId, field.name, `${field.type} requires one finite number.`);
    writeScalar(view, field.offset, scalar[1]!, value);
    return;
  }
  const vector = /^vec([234])<(f32|i32|u32)>$/.exec(field.type);
  if (vector) {
    const width = Number(vector[1]);
    const values = finiteArray(value, width, blockId, field.name);
    for (let index = 0; index < width; index++) writeScalar(view, field.offset + index * 4, vector[2]!, values[index]!);
    return;
  }
  const matrix = /^mat([234])x\1<f32>$/.exec(field.type);
  if (matrix) {
    const width = Number(matrix[1]);
    const values = finiteArray(value, width * width, blockId, field.name);
    const stride = field.matrixStride ?? width * 4;
    for (let column = 0; column < width; column++) {
      for (let row = 0; row < width; row++) {
        view.setFloat32(field.offset + column * stride + row * 4, values[column * width + row]!, true);
      }
    }
    return;
  }
  invalid(blockId, field.name, `Unsupported uniform type ${field.type}.`);
}

function finiteArray(value: ShaderUniformValue, length: number, blockId: string, field: string): readonly number[] {
  if (!Array.isArray(value) || value.length !== length || value.some(item => !Number.isFinite(item))) {
    invalid(blockId, field, `Uniform ${field} requires ${length} finite numbers.`);
  }
  return value;
}

function writeScalar(view: DataView, offset: number, type: string, value: number): void {
  if (type === 'f32') view.setFloat32(offset, value, true);
  else if (type === 'i32') {
    if (!Number.isInteger(value)) invalid('@scalar', String(offset), 'i32 uniform values must be integers.');
    view.setInt32(offset, value, true);
  } else {
    if (!Number.isInteger(value) || value < 0) invalid('@scalar', String(offset), 'u32 uniform values must be non-negative integers.');
    view.setUint32(offset, value, true);
  }
}

function invalid(blockId: string, field: string, message: string): never {
  shaderError('E_SHADER_UNIFORM_VALUE_INVALID', message, {
    moduleId: blockId,
    path: `uniforms.${field}`,
  });
}

