import { shaderError } from '../diagnostics';
import { sha256Hex } from '../hash';
import type {
  DeformationIrNode,
  DeformationProgramV1,
  DeformationProgramV1Definition,
} from './contracts';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NODES: readonly DeformationIrNode[] = Object.freeze([
  Object.freeze({
    id: 'morph',
    operation: 'morph-target-blend' as const,
    input: 'geometry.base-position-normal',
    output: 'object.morphed-position-normal',
  }),
  Object.freeze({
    id: 'skin',
    operation: 'linear-blend-skinning' as const,
    input: 'object.morphed-position-normal',
    output: 'object.skinned-position-normal',
  }),
  Object.freeze({
    id: 'displacement',
    operation: 'object-normal-sine-displacement' as const,
    input: 'object.skinned-position-normal',
    output: 'object.deformed-position-normal',
  }),
]);

export function defineDeformationProgramV1(
  definition: DeformationProgramV1Definition,
): DeformationProgramV1 {
  if (!IDENTIFIER.test(definition.id)) invalid(definition.id, 'id', 'Deformation id must be a stable identifier.');
  if (!Number.isInteger(definition.morphTargetCount)
    || definition.morphTargetCount < 1
    || definition.morphTargetCount > 4) {
    invalid(definition.id, 'morphTargetCount', 'Stage 4 supports one to four morph targets.');
  }
  if (!Number.isInteger(definition.jointCount)
    || definition.jointCount < 1
    || definition.jointCount > 256) {
    invalid(definition.id, 'jointCount', 'Stage 4 supports one to 256 skin joints.');
  }
  if (definition.displacement?.kind !== 'normal-sine') {
    invalid(definition.id, 'displacement.kind', 'Stage 4 only defines object-space normal-sine displacement.');
  }
  const body = Object.freeze({
    format: 'haiyue-typed-shader-ir' as const,
    version: 1 as const,
    kind: 'vertex-deformation' as const,
    id: definition.id,
    morphTargetCount: definition.morphTargetCount,
    jointCount: definition.jointCount,
    displacement: Object.freeze({ kind: 'normal-sine' as const }),
    nodes: NODES,
  });
  return Object.freeze({
    ...body,
    canonicalHash: sha256Hex(JSON.stringify(body)),
  });
}

function invalid(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId, path: `deformation.${path}` });
}
