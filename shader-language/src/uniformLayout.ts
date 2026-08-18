import type {
  ShaderUniformBlockReflection,
  ShaderUniformFieldDefinition,
  ShaderUniformFieldReflection,
} from './contracts';
import { shaderError } from './diagnostics';

interface WgslHostTypeLayout {
  readonly alignment: number;
  readonly size: number;
  readonly matrixStride?: number;
}

export function createUniformBlockLayout(
  resourceId: string,
  fields: readonly ShaderUniformFieldDefinition[],
): ShaderUniformBlockReflection {
  if (fields.length === 0) {
    shaderError('E_SHADER_MODULE_INVALID', `Uniform block ${resourceId} must declare at least one field.`, {
      path: `resources.${resourceId}.fields`,
    });
  }

  const reflected: ShaderUniformFieldReflection[] = [];
  const names = new Set<string>();
  let offset = 0;
  let maxAlignment = 16;

  for (const field of fields) {
    if (names.has(field.id)) {
      shaderError('E_SHADER_MODULE_INVALID', `Uniform block ${resourceId} declares duplicate field ${field.id}.`, {
        path: `resources.${resourceId}.fields`,
      });
    }
    names.add(field.id);
    const layout = hostTypeLayout(field.type, resourceId, field.id);
    offset = alignTo(offset, layout.alignment);
    reflected.push(Object.freeze({
      name: field.id,
      type: field.type,
      offset,
      size: layout.size,
      ...(layout.matrixStride === undefined ? {} : { matrixStride: layout.matrixStride }),
    }));
    offset += layout.size;
    maxAlignment = Math.max(maxAlignment, layout.alignment);
  }

  return Object.freeze({
    id: resourceId,
    alignment: maxAlignment,
    byteSize: alignTo(offset, maxAlignment),
    fields: Object.freeze(reflected),
  });
}

function hostTypeLayout(type: string, resourceId: string, fieldId: string): WgslHostTypeLayout {
  if (type === 'f32' || type === 'i32' || type === 'u32') return { alignment: 4, size: 4 };

  const vector = /^vec([234])<(f32|i32|u32)>$/.exec(type);
  if (vector) {
    const width = Number(vector[1]);
    if (width === 2) return { alignment: 8, size: 8 };
    if (width === 3) return { alignment: 16, size: 12 };
    return { alignment: 16, size: 16 };
  }

  const matrix = /^mat([234])x\1<f32>$/.exec(type);
  if (matrix) {
    const width = Number(matrix[1]);
    const stride = width === 2 ? 8 : 16;
    return {
      alignment: stride,
      size: stride * width,
      matrixStride: stride,
    };
  }

  shaderError('E_SHADER_MODULE_INVALID', `Uniform field ${resourceId}.${fieldId} uses unsupported v1 host type ${type}.`, {
    path: `resources.${resourceId}.fields.${fieldId}`,
    details: { type },
  });
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
