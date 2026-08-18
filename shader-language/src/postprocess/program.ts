import { shaderError } from '../diagnostics';
import { sha256Hex } from '../hash';
import type {
  MotionBlurPostProcessIrNode,
  MotionBlurPostProcessProgramV1,
  MotionBlurPostProcessProgramV1Definition,
} from './contracts';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const RESOURCE_ID = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;

export function defineMotionBlurPostProcessProgramV1(
  definition: MotionBlurPostProcessProgramV1Definition,
): MotionBlurPostProcessProgramV1 {
  if (!IDENTIFIER.test(definition.id)) invalid(definition.id, 'id', 'Postprocess program id must be stable.');
  for (const [semantic, resourceId] of Object.entries(definition.resources)) {
    if (!RESOURCE_ID.test(resourceId)) {
      invalid(definition.id, `resources.${semantic}`, `Invalid postprocess resource id ${resourceId}.`);
    }
  }
  const resourceIds = Object.values(definition.resources);
  if (new Set(resourceIds).size !== resourceIds.length) {
    invalid(definition.id, 'resources', 'Motion blur resource ids must be unique.');
  }
  const resources = Object.freeze({ ...definition.resources });
  const nodes: readonly MotionBlurPostProcessIrNode[] = Object.freeze([
    node('velocity', 'signed-uv-velocity', [resources.velocity], ['velocity.uv']),
    node('tileMax', 'tile-maximum-8x8', ['velocity.uv'], [resources.tileMax]),
    node('neighborMax', 'neighbor-maximum-3x3', [resources.tileMax], [resources.neighborMax]),
    node(
      'reconstruct',
      'centered-or-stable-reconstruction',
      [resources.sourceColor, 'velocity.uv', resources.neighborMax, resources.parameters],
      ['motionBlur.color'],
    ),
    node('display', 'dynamic-display-mode', ['motionBlur.color', resources.parameters], ['postprocess.color']),
  ]);
  const body = Object.freeze({
    format: 'haiyue-typed-shader-ir' as const,
    version: 1 as const,
    kind: 'postprocess' as const,
    id: definition.id,
    resources,
    nodes,
  });
  return Object.freeze({ ...body, canonicalHash: sha256Hex(JSON.stringify(body)) });
}

function node(
  id: string,
  operation: MotionBlurPostProcessIrNode['operation'],
  inputs: readonly string[],
  outputs: readonly string[],
): MotionBlurPostProcessIrNode {
  return Object.freeze({
    id,
    operation,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
  });
}

function invalid(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId, path: `postprocess.${path}` });
}
