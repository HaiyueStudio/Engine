import {
  SHADER_STAGES,
  type ShaderResourceDefinition,
  type ShaderStage,
} from '../contracts';
import { ShaderComposerError, shaderError } from '../diagnostics';
import { defineShaderModule } from '../module';
import { ShaderIrBuilderImpl, assertShaderIrIdentifier } from './builder';
import { computeShaderIrCanonicalHash } from './canonical';
import type {
  ShaderIrEntry,
  ShaderIrEntryDefinition,
  ShaderIrEntryInput,
  ShaderIrEntryInputDefinition,
  ShaderIrEntryOutput,
  ShaderIrProgram,
  ShaderIrProgramDefinition,
  ShaderIrSource,
  ShaderIrValue,
} from './contracts';
import { normalizeShaderIrValueType, parseShaderIrDataType, shaderIrValueTypesEqual } from './types';
import { validateShaderIrProgram } from './validator';

export function defineShaderIrProgram(definition: ShaderIrProgramDefinition): ShaderIrProgram {
  const entryStages = SHADER_STAGES.filter(stage => definition.entries.some(entry => entry.stage === stage));
  if (entryStages.length === 0) {
    shaderError('E_SHADER_IR_INVALID', 'Typed Shader IR requires vertex, fragment, or compute entries.', {
      moduleId: definition.id,
      path: 'entries',
    });
  }
  const normalizedResources = normalizeResources(definition.id, entryStages, definition.resources ?? []);
  const entries = Object.freeze(definition.entries.map((entry, index) =>
    buildEntry(definition.id, normalizedResources, entry, index)));
  const body = Object.freeze({
    format: 'haiyue-typed-shader-ir' as const,
    version: 1 as const,
    id: definition.id,
    resources: normalizedResources,
    entries,
  });
  const program = Object.freeze({ ...body, canonicalHash: computeShaderIrCanonicalHash(body) });
  validateShaderIrProgram(program);
  return program;
}

function normalizeResources(
  moduleId: string,
  stages: readonly ShaderStage[],
  resources: readonly ShaderResourceDefinition[],
): readonly ShaderResourceDefinition[] {
  const shell = defineShaderModule({
    id: moduleId,
    stages,
    resources,
    source: () => 'const hyTypedIrResourceValidation : f32 = 0.0;',
  });
  return shell.resources;
}

function buildEntry(
  moduleId: string,
  resources: readonly ShaderResourceDefinition[],
  definition: ShaderIrEntryDefinition,
  index: number,
): ShaderIrEntry {
  assertShaderIrIdentifier(definition.id, moduleId, `entries.${index}.id`);
  assertShaderIrIdentifier(definition.name, moduleId, `entries.${index}.name`);
  if (!SHADER_STAGES.includes(definition.stage)) {
    shaderError('E_SHADER_STAGE_VIOLATION', `Unknown entry stage ${definition.stage}.`, {
      moduleId,
      path: `entries.${index}.stage`,
    });
  }
  if (typeof definition.build !== 'function') invalid(moduleId, `entries.${index}.build`, 'Typed entry requires a build function.');
  const entrySource = normalizeSource(definition.source, moduleId, definition.id, `entries.${index}.source`);
  const builder = new ShaderIrBuilderImpl(moduleId, definition.id, definition.stage, resources);
  const inputs: ShaderIrEntryInput[] = [];
  const values: Record<string, ShaderIrValue> = {};
  for (const [inputIndex, inputDefinition] of (definition.inputs ?? []).entries()) {
    const input = normalizeInput(moduleId, definition, inputDefinition, inputIndex, builder);
    if (values[input.id]) invalid(moduleId, `entries.${index}.inputs`, `Duplicate input ${input.id}.`);
    inputs.push(input);
    values[input.id] = valueForNode(builder, input.nodeId);
  }
  validateUniqueBindings(moduleId, definition.id, inputs);

  let result: ShaderIrValue | null;
  try {
    result = definition.build(builder, Object.freeze({ ...values }));
  } catch (error) {
    if (error instanceof ShaderComposerError) throw error;
    shaderError('E_SHADER_IR_INVALID', `Typed entry builder ${definition.id} failed.`, {
      moduleId,
      path: `entries.${index}.build`,
      cause: error,
    });
  }
  const output = normalizeOutput(moduleId, definition, result, builder, index);
  return Object.freeze({
    id: definition.id,
    stage: definition.stage,
    name: definition.name,
    inputs: Object.freeze(inputs),
    output,
    nodes: builder.snapshotNodes(),
    source: entrySource,
  });
}

function normalizeInput(
  moduleId: string,
  entry: ShaderIrEntryDefinition,
  definition: ShaderIrEntryInputDefinition,
  index: number,
  builder: ShaderIrBuilderImpl,
): ShaderIrEntryInput {
  assertShaderIrIdentifier(definition.id, moduleId, `${entry.id}.inputs.${index}.id`);
  const type = normalizeShaderIrValueType(definition.type, moduleId, `${entry.id}.inputs.${index}.type`);
  const hasLocation = definition.location !== undefined;
  const hasBuiltin = definition.builtin !== undefined;
  if (hasLocation === hasBuiltin) invalid(moduleId, `${entry.id}.inputs.${index}`, 'Entry input requires exactly one location or builtin.');
  if (hasLocation && (!Number.isInteger(definition.location) || definition.location! < 0 || entry.stage === 'compute')) {
    invalid(moduleId, `${entry.id}.inputs.${index}.location`, `Invalid ${entry.stage} input location ${definition.location}.`);
  }
  if (hasBuiltin) validateInputBuiltin(moduleId, entry.stage, definition.builtin!, type, `${entry.id}.inputs.${index}`);
  const info = parseShaderIrDataType(type.dataType, moduleId, `${entry.id}.inputs.${index}.type`);
  let interpolation = definition.interpolation;
  if (hasLocation && entry.stage === 'fragment' && (info.scalarType === 'i32' || info.scalarType === 'u32' || info.scalarType === 'bool')) {
    interpolation = 'flat';
  }
  if (interpolation !== undefined && (!hasLocation || entry.stage !== 'fragment')) {
    invalid(moduleId, `${entry.id}.inputs.${index}.interpolation`, 'Interpolation is only valid for fragment location inputs.');
  }
  const source = normalizeSource(definition.source, moduleId, entry.id, `${entry.id}.inputs.${index}.source`);
  const value = builder.createInput(definition.id, type, source);
  return Object.freeze({
    id: definition.id,
    type,
    ...(definition.location === undefined ? {} : { location: definition.location }),
    ...(definition.builtin === undefined ? {} : { builtin: definition.builtin }),
    ...(interpolation === undefined ? {} : { interpolation }),
    nodeId: builder.nodeId(value),
    source,
  });
}

function normalizeOutput(
  moduleId: string,
  entry: ShaderIrEntryDefinition,
  result: ShaderIrValue | null,
  builder: ShaderIrBuilderImpl,
  index: number,
): ShaderIrEntryOutput | null {
  if (!entry.output) {
    if (entry.stage !== 'compute') invalid(moduleId, `entries.${index}.output`, `${entry.stage} entry requires an output.`);
    if (result !== null) invalid(moduleId, `entries.${index}.build`, 'Compute entry without output must return null.');
    return null;
  }
  if (entry.stage === 'compute') invalid(moduleId, `entries.${index}.output`, 'Stage 2 compute entry cannot return a value.');
  if (!result) invalid(moduleId, `entries.${index}.build`, 'Entry builder must return its declared output value.');
  const type = normalizeShaderIrValueType(entry.output.type, moduleId, `entries.${index}.output.type`);
  assertResultType(moduleId, type, result.type, `entries.${index}.output.type`);
  const hasLocation = entry.output.location !== undefined;
  const hasBuiltin = entry.output.builtin !== undefined;
  if (hasLocation === hasBuiltin) invalid(moduleId, `entries.${index}.output`, 'Entry output requires exactly one location or builtin.');
  if (entry.stage === 'vertex') {
    if (entry.output.builtin !== 'position' || type.dataType !== 'vec4<f32>' || type.semantic !== 'position' || type.coordinateSpace !== 'clip') {
      invalid(moduleId, `entries.${index}.output`, 'Stage 2 vertex output must be @builtin(position) vec4<f32> position|clip.');
    }
  } else if (entry.output.builtin === 'frag_depth') {
    if (type.dataType !== 'f32' || type.semantic !== 'value') invalid(moduleId, `entries.${index}.output`, 'frag_depth requires f32 value.');
  } else if (!hasLocation || !Number.isInteger(entry.output.location) || entry.output.location! < 0) {
    invalid(moduleId, `entries.${index}.output.location`, 'Fragment output requires a non-negative location or frag_depth.');
  }
  const source = normalizeSource(entry.output.source, moduleId, entry.id, `entries.${index}.output.source`);
  return Object.freeze({
    type,
    ...(entry.output.location === undefined ? {} : { location: entry.output.location }),
    ...(entry.output.builtin === undefined ? {} : { builtin: entry.output.builtin }),
    nodeId: builder.nodeId(result, 'output'),
    source,
  });
}

function validateInputBuiltin(
  moduleId: string,
  stage: ShaderStage,
  builtin: NonNullable<ShaderIrEntryInputDefinition['builtin']>,
  type: ReturnType<typeof normalizeShaderIrValueType>,
  path: string,
): void {
  const expected = {
    vertex_index: { stage: 'vertex', dataType: 'u32', semantic: 'value' },
    instance_index: { stage: 'vertex', dataType: 'u32', semantic: 'value' },
    position: { stage: 'fragment', dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'screen' },
    front_facing: { stage: 'fragment', dataType: 'bool', semantic: 'value' },
    global_invocation_id: { stage: 'compute', dataType: 'vec3<u32>', semantic: 'value' },
  }[builtin];
  if (!expected || expected.stage !== stage || expected.dataType !== type.dataType || expected.semantic !== type.semantic
    || ('coordinateSpace' in expected && expected.coordinateSpace !== type.coordinateSpace)) {
    invalid(moduleId, `${path}.builtin`, `Builtin ${builtin} is incompatible with ${stage} ${type.dataType}|${type.semantic}|${type.coordinateSpace ?? '-'}.`);
  }
}

function validateUniqueBindings(moduleId: string, entryId: string, inputs: readonly ShaderIrEntryInput[]): void {
  const locations = new Set<number>();
  const builtins = new Set<string>();
  for (const input of inputs) {
    if (input.location !== undefined) {
      if (locations.has(input.location)) invalid(moduleId, `${entryId}.inputs`, `Duplicate input location ${input.location}.`);
      locations.add(input.location);
    }
    if (input.builtin !== undefined) {
      if (builtins.has(input.builtin)) invalid(moduleId, `${entryId}.inputs`, `Duplicate input builtin ${input.builtin}.`);
      builtins.add(input.builtin);
    }
  }
}

function assertResultType(
  moduleId: string,
  expected: ReturnType<typeof normalizeShaderIrValueType>,
  actual: ShaderIrValue['type'],
  path: string,
): void {
  if (shaderIrValueTypesEqual(expected, actual)) return;
  const code = expected.dataType !== actual.dataType
    ? 'E_SHADER_TYPE_MISMATCH'
    : expected.coordinateSpace !== actual.coordinateSpace
      ? 'E_SHADER_SPACE_MISMATCH'
      : 'E_SHADER_SEMANTIC_MISMATCH';
  shaderError(code, `Entry output expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`, {
    moduleId,
    path,
  });
}

function valueForNode(builder: ShaderIrBuilderImpl, nodeId: number): ShaderIrValue {
  const node = builder.nodes[nodeId];
  if (!node) invalid(builder.moduleId, `${builder.entryId}.nodes.${nodeId}`, 'Missing input node.');
  return builder.createValueForInput(node);
}

function normalizeSource(
  source: ShaderIrSource | undefined,
  moduleId: string,
  entryId: string,
  path: string,
): ShaderIrSource {
  const value = source ?? { sourceId: moduleId, path: `${entryId}.${path}` };
  if (!value.sourceId?.trim()) invalid(moduleId, path, 'IR sourceId must not be empty.');
  if (value.sourceName !== undefined && (!value.sourceName.trim() || /[\r\n]/.test(value.sourceName))) {
    invalid(moduleId, `${path}.sourceName`, 'IR sourceName must be a non-empty single line.');
  }
  if (value.line !== undefined && (!Number.isInteger(value.line) || value.line < 1)) {
    invalid(moduleId, `${path}.line`, 'IR source line must be a positive integer.');
  }
  if (value.column !== undefined && (!Number.isInteger(value.column) || value.column < 1)) {
    invalid(moduleId, `${path}.column`, 'IR source column must be a positive integer.');
  }
  return Object.freeze({ ...value });
}

function invalid(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId, path });
}
