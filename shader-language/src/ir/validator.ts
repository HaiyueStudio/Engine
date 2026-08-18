import { SHADER_STAGES } from '../contracts';
import { shaderError } from '../diagnostics';
import { computeShaderIrCanonicalHash } from './canonical';
import type { ShaderIrEntry, ShaderIrProgram } from './contracts';
import { shaderIrValueTypesEqual } from './types';

export function validateShaderIrProgram(program: ShaderIrProgram): void {
  if (program.format !== 'haiyue-typed-shader-ir' || program.version !== 1) {
    invalid(program.id, 'format', 'Unsupported Typed Shader IR format/version.');
  }
  if (program.entries.length === 0) invalid(program.id, 'entries', 'Typed Shader IR requires at least one entry.');
  expectUnique(program.resources.map(resource => resource.id), program.id, 'resources');
  expectUnique(program.entries.map(entry => entry.id), program.id, 'entries');
  expectUnique(program.entries.map(entry => entry.name), program.id, 'entry names');
  for (const entry of program.entries) validateEntry(program.id, entry);
  const expectedHash = computeShaderIrCanonicalHash(program);
  if (program.canonicalHash !== expectedHash) {
    invalid(program.id, 'canonicalHash', `Typed Shader IR hash mismatch: expected ${expectedHash}, got ${program.canonicalHash}.`);
  }
}

function validateEntry(moduleId: string, entry: ShaderIrEntry): void {
  if (!SHADER_STAGES.includes(entry.stage)) invalid(moduleId, `${entry.id}.stage`, `Unknown stage ${entry.stage}.`);
  expectUnique(entry.inputs.map(input => input.id), moduleId, `${entry.id}.inputs`);
  const locations = entry.inputs.flatMap(input => input.location === undefined ? [] : [String(input.location)]);
  const builtins = entry.inputs.flatMap(input => input.builtin === undefined ? [] : [input.builtin]);
  expectUnique(locations, moduleId, `${entry.id}.input locations`);
  expectUnique(builtins, moduleId, `${entry.id}.input builtins`);
  const byId = new Map(entry.nodes.map(node => [node.id, node]));
  for (const [index, node] of entry.nodes.entries()) {
    if (node.id !== index) invalid(moduleId, `${entry.id}.nodes.${index}.id`, 'IR node ids must be dense and topological.');
    if (node.allowedStages.length === 0 || !node.allowedStages.includes(entry.stage)) {
      shaderError('E_SHADER_STAGE_VIOLATION', `Node ${node.id} does not allow ${entry.stage}.`, {
        moduleId,
        path: `${entry.id}.nodes.${index}.allowedStages`,
      });
    }
    for (const operand of node.operands) {
      if (!Number.isInteger(operand) || operand < 0 || operand >= node.id || !byId.has(operand)) {
        invalid(moduleId, `${entry.id}.nodes.${index}.operands`, `Node ${node.id} has invalid/non-topological operand ${operand}.`);
      }
    }
  }
  for (const input of entry.inputs) {
    const node = byId.get(input.nodeId);
    if (!node || node.operation !== 'input' || !shaderIrValueTypesEqual(node.type, input.type)) {
      invalid(moduleId, `${entry.id}.inputs.${input.id}`, `Input ${input.id} is not backed by its typed input node.`);
    }
  }
  if (entry.output) {
    const node = byId.get(entry.output.nodeId);
    if (!node || !shaderIrValueTypesEqual(node.type, entry.output.type)) {
      invalid(moduleId, `${entry.id}.output`, 'Entry output node/type is invalid.');
    }
  }
}

function expectUnique(values: readonly string[], moduleId: string, path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(moduleId, path, `Duplicate ${path} value ${value}.`);
    seen.add(value);
  }
}

function invalid(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId, path });
}
