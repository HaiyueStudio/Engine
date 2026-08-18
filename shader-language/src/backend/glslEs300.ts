import type {
  ShaderGeneratedSourceSpan,
  ShaderSourceLocation,
  ShaderStage,
  ShaderUniformBlockReflection,
  ShaderUniformFieldDefinition,
  ShaderUniformFieldReflection,
} from '../contracts';
import { shaderError } from '../diagnostics';
import { sha256Hex } from '../hash';
import { reachableShaderIrNodes } from '../ir/canonical';
import type {
  ShaderIrEntry,
  ShaderIrNode,
  ShaderIrPayloadValue,
  ShaderIrProgram,
  ShaderIrSource,
} from '../ir/contracts';
import { parseShaderIrDataType, type ShaderIrDataType } from '../ir/types';
import { validateShaderIrProgram } from '../ir/validator';
import { optimizeShaderIrProgram, shaderIrOperationHasImplicitState } from '../ir/optimizer';
import { compareStableText } from '../naming';
import {
  compilationNowMs,
  createShaderCompilationCostEvidence,
  type ShaderCompilationCostEvidence,
  type ShaderCompilationCostOptions,
} from './compilationCost';

export interface ShaderIrGlslEs300Options extends ShaderCompilationCostOptions {
  readonly maxUniformBufferBindings?: number;
  readonly maxCombinedTextureUnits?: number;
}

export interface ShaderIrGlslEs300UniformBlock {
  readonly resourceId: string;
  readonly blockName: string;
  readonly instanceName: string;
  readonly binding: number;
  readonly layout: ShaderUniformBlockReflection;
}

export interface ShaderIrGlslEs300SampledTexture {
  readonly textureResourceId: string;
  readonly samplerResourceId: string;
  readonly uniformName: string;
  readonly textureUnit: number;
}

export interface ShaderIrGlslEs300EntryCompilation {
  readonly entryId: string;
  readonly stage: 'vertex' | 'fragment';
  readonly originalEntryPoint: string;
  readonly code: string;
  readonly sourceMap: readonly ShaderGeneratedSourceSpan[];
}

export interface ShaderIrGlslEs300Compilation {
  readonly target: 'webgl2-glsl-es300';
  readonly profile: 'webgl2-compatible';
  readonly canonicalHash: string;
  readonly backendHash: string;
  readonly entries: readonly ShaderIrGlslEs300EntryCompilation[];
  readonly uniformBlocks: readonly ShaderIrGlslEs300UniformBlock[];
  readonly sampledTextures: readonly ShaderIrGlslEs300SampledTexture[];
  readonly cost: ShaderCompilationCostEvidence;
}

interface SamplePair {
  readonly textureResourceId: string;
  readonly samplerResourceId: string;
  readonly key: string;
}

interface BindingPlan {
  readonly uniformBlocks: readonly ShaderIrGlslEs300UniformBlock[];
  readonly uniformBlockByResource: ReadonlyMap<string, ShaderIrGlslEs300UniformBlock>;
  readonly sampledTextures: readonly ShaderIrGlslEs300SampledTexture[];
  readonly sampledTextureByPair: ReadonlyMap<string, ShaderIrGlslEs300SampledTexture>;
}

/**
 * Emits the portable Typed Expression IR subset as complete GLSL ES 3.00 stage sources.
 * This is a codegen feasibility boundary, not a WebGL2 renderer or a WGSL text translator.
 */
export function compileShaderIrProgramToGlslEs300(
  program: ShaderIrProgram,
  options: ShaderIrGlslEs300Options = {},
): ShaderIrGlslEs300Compilation {
  const totalStartedAt = compilationNowMs();
  const validationStartedAt = compilationNowMs();
  validateShaderIrProgram(program);
  const maxUniformBufferBindings = positiveLimit(options.maxUniformBufferBindings ?? 12, 'maxUniformBufferBindings');
  const maxCombinedTextureUnits = positiveLimit(options.maxCombinedTextureUnits ?? 16, 'maxCombinedTextureUnits');
  validatePortableProgram(program);
  const validationMs = compilationNowMs() - validationStartedAt;
  const optimizationStartedAt = compilationNowMs();
  const optimized = optimizeShaderIrProgram(program);
  const optimizationMs = compilationNowMs() - optimizationStartedAt;
  const optimizedProgram = optimized.program;
  const bindingPlanStartedAt = compilationNowMs();
  const plan = createBindingPlan(optimizedProgram, maxUniformBufferBindings, maxCombinedTextureUnits);
  const bindingPlanMs = compilationNowMs() - bindingPlanStartedAt;
  const codeGenerationStartedAt = compilationNowMs();
  const entries = Object.freeze([...optimizedProgram.entries]
    .sort((left, right) => compareStableText(`${left.stage}:${left.name}:${left.id}`, `${right.stage}:${right.name}:${right.id}`))
    .map(entry => emitEntry(optimizedProgram, entry, plan)));
  const body = Object.freeze({
    target: 'webgl2-glsl-es300' as const,
    profile: 'webgl2-compatible' as const,
    canonicalHash: program.canonicalHash,
    entries,
    uniformBlocks: plan.uniformBlocks,
    sampledTextures: plan.sampledTextures,
  });
  const backendHash = sha256Hex(JSON.stringify(body));
  const codeGenerationMs = compilationNowMs() - codeGenerationStartedAt;
  const source = entries.map(entry => entry.code).join('');
  return Object.freeze({
    ...body,
    backendHash,
    cost: createShaderCompilationCostEvidence(source, optimized.report, Object.freeze({
      validation: validationMs,
      optimization: optimizationMs,
      bindingPlan: bindingPlanMs,
      codeGeneration: codeGenerationMs,
      total: compilationNowMs() - totalStartedAt,
    }), options),
  });
}

export function mapGlslEs300SourceLocation(
  entry: Pick<ShaderIrGlslEs300EntryCompilation, 'sourceMap'>,
  generatedLine: number,
  column = 1,
): ShaderSourceLocation | null {
  const span = entry.sourceMap
    .filter(candidate => generatedLine >= candidate.generatedStartLine && generatedLine <= candidate.generatedEndLine)
    .sort((left, right) => (left.generatedEndLine - left.generatedStartLine) - (right.generatedEndLine - right.generatedStartLine))[0];
  if (!span) return null;
  return Object.freeze({
    sourceId: span.sourceId,
    sourceName: span.sourceName,
    line: (span.sourceStartLine ?? 1) + generatedLine - span.generatedStartLine,
    column: generatedLine === span.generatedStartLine ? (span.sourceStartColumn ?? 1) + column - 1 : column,
    generatedLine,
  });
}

function validatePortableProgram(program: ShaderIrProgram): void {
  for (const entry of program.entries) {
    if (entry.stage === 'compute') unsupported(program.id, `${entry.id}.stage`, 'GLSL ES 3.00 feasibility does not support compute entries.');
    if (entry.stage === 'vertex' && entry.output?.builtin !== 'position') {
      unsupported(program.id, `${entry.id}.output`, 'GLSL feasibility requires a vertex position output; cross-stage varying linking is deferred.');
    }
    if (entry.stage === 'fragment' && entry.inputs.some(input => input.builtin === undefined)) {
      unsupported(program.id, `${entry.id}.inputs`, 'Cross-stage user varying linking is deferred from GLSL ES 3.00 feasibility.');
    }
  }
  for (const resource of program.resources) {
    if (resource.kind === 'storage-buffer-read' || resource.kind === 'storage-buffer-read-write' || resource.kind === 'storage-texture') {
      unsupported(program.id, `resources.${resource.id}`, `WebGL2-compatible Typed IR cannot represent ${resource.kind}.`);
    }
    if (resource.kind === 'uniform-buffer' && (!resource.fields || resource.fields.length === 0)) {
      unsupported(program.id, `resources.${resource.id}`, 'GLSL feasibility requires compiler-owned uniform fields; opaque WGSL uniform types cannot be translated.');
    }
    if (resource.kind === 'texture' && resource.valueType !== 'texture_2d<f32>') {
      unsupported(program.id, `resources.${resource.id}.valueType`, `GLSL feasibility supports texture_2d<f32>, got ${resource.valueType}.`);
    }
    if (resource.kind === 'sampler' && resource.valueType !== 'sampler') {
      unsupported(program.id, `resources.${resource.id}.valueType`, `GLSL feasibility supports filtering sampler resources, got ${resource.valueType}.`);
    }
    for (const field of resource.fields ?? []) glslType(field.type, program.id, `resources.${resource.id}.fields.${field.id}.type`);
  }
}

function createBindingPlan(program: ShaderIrProgram, maxUniformBlocks: number, maxTextureUnits: number): BindingPlan {
  const reachable = program.entries.flatMap(entry => [...reachableShaderIrNodes(entry)]);
  const uniformIds = new Set(reachable
    .filter(node => node.operation === 'uniform-field')
    .map(node => payloadString(node, 'resourceId')));
  const uniformResources = program.resources
    .filter(resource => uniformIds.has(resource.id))
    .sort((left, right) => compareStableText(left.id, right.id));
  if (uniformResources.length > maxUniformBlocks) {
    unsupported(program.id, 'resources', `GLSL feasibility requires ${uniformResources.length} uniform blocks, limit is ${maxUniformBlocks}.`);
  }
  const uniformBlocks = Object.freeze(uniformResources.map((resource, binding) => {
    const layout = createStd140UniformBlockLayout(resource.id, resource.fields!);
    return Object.freeze({
      resourceId: resource.id,
      blockName: name('block', resource.id),
      instanceName: name('ubo', resource.id),
      binding,
      layout,
    });
  }));

  const pairs = new Map<string, SamplePair>();
  for (const node of reachable) {
    if (node.operation !== 'texture-sample' && node.operation !== 'texture-sample-level') continue;
    const textureResourceId = payloadString(node, 'textureId');
    const samplerResourceId = payloadString(node, 'samplerId');
    const key = pairKey(textureResourceId, samplerResourceId);
    pairs.set(key, Object.freeze({ textureResourceId, samplerResourceId, key }));
  }
  const orderedPairs = [...pairs.values()].sort((left, right) => compareStableText(left.key, right.key));
  if (orderedPairs.length > maxTextureUnits) {
    unsupported(program.id, 'resources', `GLSL feasibility requires ${orderedPairs.length} combined texture units, limit is ${maxTextureUnits}.`);
  }
  const sampledTextures = Object.freeze(orderedPairs.map((pair, textureUnit) => Object.freeze({
    textureResourceId: pair.textureResourceId,
    samplerResourceId: pair.samplerResourceId,
    uniformName: name('sample', `${pair.textureResourceId}.${pair.samplerResourceId}`),
    textureUnit,
  })));
  return Object.freeze({
    uniformBlocks,
    uniformBlockByResource: new Map(uniformBlocks.map(block => [block.resourceId, block])),
    sampledTextures,
    sampledTextureByPair: new Map(sampledTextures.map(sample => [pairKey(sample.textureResourceId, sample.samplerResourceId), sample])),
  });
}

function createStd140UniformBlockLayout(
  resourceId: string,
  fields: readonly ShaderUniformFieldDefinition[],
): ShaderUniformBlockReflection {
  const reflected: ShaderUniformFieldReflection[] = [];
  let offset = 0;
  for (const field of fields) {
    const layout = std140TypeLayout(field.type, resourceId, field.id);
    offset = alignTo(offset, layout.alignment);
    reflected.push(Object.freeze({
      name: field.id,
      type: field.type,
      offset,
      size: layout.size,
      ...(layout.matrixStride === undefined ? {} : { matrixStride: layout.matrixStride }),
    }));
    offset += layout.size;
  }
  return Object.freeze({
    id: resourceId,
    alignment: 16,
    byteSize: alignTo(offset, 16),
    fields: Object.freeze(reflected),
  });
}

function std140TypeLayout(
  type: string,
  resourceId: string,
  fieldId: string,
): { readonly alignment: number; readonly size: number; readonly matrixStride?: number } {
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
    return { alignment: 16, size: 16 * width, matrixStride: 16 };
  }
  unsupported('@glsl-es300', `resources.${resourceId}.fields.${fieldId}`, `std140 cannot host ${type}.`);
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function emitEntry(program: ShaderIrProgram, entry: ShaderIrEntry, plan: BindingPlan): ShaderIrGlslEs300EntryCompilation {
  if (entry.stage === 'compute') unsupported(program.id, entry.id, 'GLSL ES 3.00 cannot emit compute entries.');
  const lines: string[] = [];
  const sourceMap: ShaderGeneratedSourceSpan[] = [];
  const append = (line: string, source?: ShaderIrSource | readonly ShaderIrSource[]): void => {
    lines.push(line);
    if (!source) return;
    for (const item of Array.isArray(source) ? source : [source]) {
      sourceMap.push(Object.freeze({
        sourceId: item.sourceId,
        sourceName: item.sourceName ?? `${program.id}.typed-ir`,
        generatedStartLine: lines.length,
        generatedEndLine: lines.length,
        ...(item.line === undefined ? {} : { sourceStartLine: item.line }),
        ...(item.column === undefined ? {} : { sourceStartColumn: item.column }),
      }));
    }
  };
  lines.push('#version 300 es');
  lines.push('precision highp float;');
  lines.push('precision highp int;');
  lines.push(`// haiyue:typed-ir ${program.canonicalHash}`);
  lines.push('// haiyue:target webgl2-glsl-es300');
  lines.push('');

  const nodes = reachableShaderIrNodes(entry);
  const usedUniformIds = new Set(nodes.filter(node => node.operation === 'uniform-field').map(node => payloadString(node, 'resourceId')));
  for (const block of plan.uniformBlocks) {
    if (!usedUniformIds.has(block.resourceId)) continue;
    lines.push(`layout(std140) uniform ${block.blockName} {`);
    for (const field of block.layout.fields) lines.push(`  ${glslType(field.type, program.id, `${entry.id}.uniform.${field.name}`)} ${fieldName(field.name)};`);
    lines.push(`} ${block.instanceName};`);
    lines.push('');
  }
  const usedPairs = new Set(nodes
    .filter(node => node.operation === 'texture-sample' || node.operation === 'texture-sample-level')
    .map(node => pairKey(payloadString(node, 'textureId'), payloadString(node, 'samplerId'))));
  for (const sample of plan.sampledTextures) {
    if (usedPairs.has(pairKey(sample.textureResourceId, sample.samplerResourceId))) lines.push(`uniform sampler2D ${sample.uniformName};`);
  }
  if (usedPairs.size > 0) lines.push('');

  for (const input of entry.inputs) {
    if (input.builtin !== undefined) continue;
    const interpolation = entry.stage === 'fragment' && input.interpolation === 'flat' ? 'flat ' : '';
    const location = entry.stage === 'vertex' ? `layout(location=${input.location}) ` : '';
    lines.push(`${location}${interpolation}in ${glslType(input.type.dataType, program.id, `${entry.id}.inputs.${input.id}`)} ${inputName(input.id)};`);
  }
  if (entry.output?.location !== undefined) {
    lines.push(`layout(location=${entry.output.location}) out ${glslType(entry.output.type.dataType, program.id, `${entry.id}.output`)} ${outputName(entry.id)};`);
  }
  if (entry.inputs.some(input => input.builtin === undefined) || entry.output?.location !== undefined) lines.push('');
  append('void main() {', entry.source);

  const nodeNames = new Map<number, string>();
  for (const input of entry.inputs) nodeNames.set(input.nodeId, inputExpression(input, program.id, entry.id));
  const uses = countNodeUses(entry, nodes);
  const consumerSources = collectConsumerSources(entry, nodes);
  for (const [canonicalIndex, node] of nodes.entries()) {
    if (node.operation === 'input') continue;
    if ((node.operation === 'literal' || node.operation === 'uniform-field' || node.operation === 'semantic')
      && node.optimization === undefined && node.sourceAliases === undefined) {
      nodeNames.set(node.id, emitExpression(program, entry, node, nodeNames, plan));
      continue;
    }
    const expression = emitExpression(program, entry, node, nodeNames, plan);
    if (canInlineExpression(node, uses, consumerSources)) {
      nodeNames.set(node.id, expression);
      continue;
    }
    const variable = `hy_ir_${canonicalIndex}`;
    append(`  ${glslType(node.type.dataType, program.id, `${entry.id}.nodes.${node.id}`)} ${variable} = ${expression};`, nodeSources(node));
    nodeNames.set(node.id, variable);
  }
  if (entry.output) {
    const result = nodeNames.get(entry.output.nodeId);
    if (!result) codegenError(program.id, entry.id, `Output node ${entry.output.nodeId} has no generated value.`);
    if (entry.output.builtin === 'position') append(`  gl_Position = ${result};`, entry.output.source);
    else if (entry.output.builtin === 'frag_depth') append(`  gl_FragDepth = ${result};`, entry.output.source);
    else append(`  ${outputName(entry.id)} = ${result};`, entry.output.source);
  }
  append('}', entry.source);
  return Object.freeze({
    entryId: entry.id,
    stage: entry.stage,
    originalEntryPoint: entry.name,
    code: `${lines.join('\n')}\n`,
    sourceMap: Object.freeze(sourceMap),
  });
}

function emitExpression(
  program: ShaderIrProgram,
  entry: ShaderIrEntry,
  node: ShaderIrNode,
  nodeNames: ReadonlyMap<number, string>,
  plan: BindingPlan,
): string {
  const operand = (index: number): string => {
    const nodeId = node.operands[index];
    const value = nodeId === undefined ? undefined : nodeNames.get(nodeId);
    if (!value) codegenError(program.id, entry.id, `Node ${node.id} has unresolved operand ${index}.`);
    return value;
  };
  switch (node.operation) {
    case 'literal': return literalExpression(node);
    case 'uniform-field': {
      const block = plan.uniformBlockByResource.get(payloadString(node, 'resourceId'));
      if (!block) codegenError(program.id, entry.id, `Uniform resource for node ${node.id} has no binding plan.`);
      return `${block.instanceName}.${fieldName(payloadString(node, 'fieldId'))}`;
    }
    case 'splat':
    case 'construct': return `${glslType(node.type.dataType, program.id, entry.id)}(${node.operands.map((_id, index) => operand(index)).join(', ')})`;
    case 'cast': return `${glslType(payloadString(node, 'dataType'), program.id, entry.id)}(${operand(0)})`;
    case 'semantic': return operand(0);
    case 'add': return `(${operand(0)} + ${operand(1)})`;
    case 'subtract': return `(${operand(0)} - ${operand(1)})`;
    case 'multiply': return `(${operand(0)} * ${operand(1)})`;
    case 'divide': return `(${operand(0)} / ${operand(1)})`;
    case 'dot': return `dot(${operand(0)}, ${operand(1)})`;
    case 'cross': return `cross(${operand(0)}, ${operand(1)})`;
    case 'normalize': return `normalize(${operand(0)})`;
    case 'pow': return `pow(${operand(0)}, ${operand(1)})`;
    case 'sqrt': return `sqrt(${operand(0)})`;
    case 'mix': return `mix(${operand(0)}, ${operand(1)}, ${operand(2)})`;
    case 'clamp': return `clamp(${operand(0)}, ${operand(1)}, ${operand(2)})`;
    case 'sin': return `sin(${operand(0)})`;
    case 'swizzle': return `${operand(0)}.${payloadString(node, 'pattern')}`;
    case 'texture-sample':
    case 'texture-sample-level': {
      const sample = plan.sampledTextureByPair.get(pairKey(payloadString(node, 'textureId'), payloadString(node, 'samplerId')));
      if (!sample) codegenError(program.id, entry.id, `Texture sample node ${node.id} has no combined sampler plan.`);
      return node.operation === 'texture-sample'
        ? `texture(${sample.uniformName}, ${operand(0)})`
        : `textureLod(${sample.uniformName}, ${operand(0)}, ${operand(1)})`;
    }
    case 'derivative-x': return `dFdx(${operand(0)})`;
    case 'derivative-y': return `dFdy(${operand(0)})`;
    case 'transform-position': return transformPositionExpression(entry, node, operand(0), operand(1), program.id);
    case 'transform-direction':
    case 'transform-normal': return transformVectorExpression(entry, node, operand(0), operand(1), program.id);
    case 'srgb-to-linear': return srgbToLinearExpression(node.type.dataType, operand(0), program.id);
    case 'input': codegenError(program.id, entry.id, `Input node ${node.id} cannot be emitted as a local expression.`);
  }
}

function transformPositionExpression(entry: ShaderIrEntry, node: ShaderIrNode, matrix: string, value: string, moduleId: string): string {
  const inputNode = entry.nodes[node.operands[1]!];
  if (!inputNode) codegenError(moduleId, entry.id, `Missing transform position operand for node ${node.id}.`);
  const input = inputNode.type.dataType === 'vec4<f32>' ? value : `vec4(${value}, 1.0)`;
  const transformed = `(${matrix} * ${input})`;
  return node.type.dataType === 'vec4<f32>' ? transformed : `${transformed}.xyz`;
}

function transformVectorExpression(entry: ShaderIrEntry, node: ShaderIrNode, matrix: string, value: string, moduleId: string): string {
  const matrixNode = entry.nodes[node.operands[0]!];
  if (!matrixNode) codegenError(moduleId, entry.id, `Missing transform matrix operand for node ${node.id}.`);
  const transformed = matrixNode.type.dataType === 'mat3x3<f32>' ? `(${matrix} * ${value})` : `(${matrix} * vec4(${value}, 0.0)).xyz`;
  return node.operation === 'transform-normal' ? `normalize(${transformed})` : transformed;
}

function srgbToLinearExpression(dataType: ShaderIrDataType, value: string, moduleId: string): string {
  const info = parseShaderIrDataType(dataType);
  if (info.width === 3) return srgbVectorExpression('vec3', value);
  if (info.width === 4) return `vec4(${srgbVectorExpression('vec3', `${value}.rgb`)}, ${value}.a)`;
  codegenError(moduleId, '@srgb', `Unsupported sRGB type ${dataType}.`);
}

function srgbVectorExpression(type: string, value: string): string {
  return `mix(${value} / ${type}(12.92), pow((${value} + ${type}(0.055)) / ${type}(1.055), ${type}(2.4)), greaterThan(${value}, ${type}(0.04045)))`;
}

function literalExpression(node: ShaderIrNode): string {
  const info = parseShaderIrDataType(node.type.dataType);
  if (info.kind === 'scalar') return scalarLiteral(info.scalarType, node.payload.value);
  const values = node.payload.values;
  if (!Array.isArray(values)) codegenError('@typed-ir', '@literal', `Node ${node.id} is missing literal values.`);
  return `${glslType(node.type.dataType, '@typed-ir', '@literal')}(${values.map(value => scalarLiteral(info.scalarType, value)).join(', ')})`;
}

function scalarLiteral(type: string, value: ShaderIrPayloadValue | undefined): string {
  if (type === 'bool') {
    if (typeof value !== 'boolean') codegenError('@typed-ir', '@literal', `Expected bool literal, got ${String(value)}.`);
    return value ? 'true' : 'false';
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) codegenError('@typed-ir', '@literal', `Expected numeric literal, got ${String(value)}.`);
  if (type === 'u32') return `${value}u`;
  if (type === 'i32') return String(value);
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function inputExpression(input: ShaderIrEntry['inputs'][number], moduleId: string, entryId: string): string {
  if (input.builtin === undefined) return inputName(input.id);
  switch (input.builtin) {
    case 'vertex_index': return 'uint(gl_VertexID)';
    case 'instance_index': return 'uint(gl_InstanceID)';
    case 'position': return 'gl_FragCoord';
    case 'front_facing': return 'gl_FrontFacing';
    case 'global_invocation_id': unsupported(moduleId, `${entryId}.inputs.${input.id}`, 'global_invocation_id is unavailable in GLSL ES 3.00.');
  }
}

function glslType(value: string, moduleId: string, path: string): string {
  const scalar = { bool: 'bool', i32: 'int', u32: 'uint', f32: 'float' }[value];
  if (scalar) return scalar;
  const vector = /^vec([234])<(bool|i32|u32|f32)>$/.exec(value);
  if (vector) {
    const prefix = { bool: 'bvec', i32: 'ivec', u32: 'uvec', f32: 'vec' }[vector[2]!];
    return `${prefix}${vector[1]}`;
  }
  const matrix = /^mat([234])x\1<f32>$/.exec(value);
  if (matrix) return `mat${matrix[1]}`;
  unsupported(moduleId, path, `GLSL ES 3.00 feasibility cannot map type ${value}.`);
}

function countNodeUses(entry: ShaderIrEntry, nodes: readonly ShaderIrNode[]): ReadonlyMap<number, number> {
  const uses = new Map<number, number>();
  for (const node of nodes) for (const operand of node.operands) uses.set(operand, (uses.get(operand) ?? 0) + 1);
  if (entry.output) uses.set(entry.output.nodeId, (uses.get(entry.output.nodeId) ?? 0) + 1);
  return uses;
}

function collectConsumerSources(entry: ShaderIrEntry, nodes: readonly ShaderIrNode[]): ReadonlyMap<number, readonly string[]> {
  const sources = new Map<number, string[]>();
  for (const node of nodes) for (const operand of node.operands) {
    const values = sources.get(operand) ?? [];
    values.push(node.source.sourceId);
    sources.set(operand, values);
  }
  if (entry.output) {
    const values = sources.get(entry.output.nodeId) ?? [];
    values.push(entry.output.source.sourceId);
    sources.set(entry.output.nodeId, values);
  }
  return sources;
}

function canInlineExpression(node: ShaderIrNode, uses: ReadonlyMap<number, number>, consumerSources: ReadonlyMap<number, readonly string[]>): boolean {
  if (uses.get(node.id) !== 1 || node.sourceAliases !== undefined || shaderIrOperationHasImplicitState(node.operation)) return false;
  const consumers = consumerSources.get(node.id);
  return consumers?.length === 1 && consumers[0] === node.source.sourceId;
}

function nodeSources(node: ShaderIrNode): readonly ShaderIrSource[] {
  return Object.freeze([node.source, ...(node.sourceAliases ?? [])]);
}

function pairKey(textureResourceId: string, samplerResourceId: string): string { return `${textureResourceId}\u0000${samplerResourceId}`; }
function name(prefix: string, id: string): string { return `hy_${prefix}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`; }
function inputName(id: string): string { return `hy_in_${id}`; }
function outputName(id: string): string { return `hy_out_${id}`; }
function fieldName(id: string): string { return `hy_field_${id}`; }

function payloadString(node: ShaderIrNode, key: string): string {
  const value = node.payload[key];
  if (typeof value !== 'string') codegenError('@typed-ir', '@payload', `Node ${node.id} payload ${key} must be a string.`);
  return value;
}

function positiveLimit(value: number, path: string): number {
  if (!Number.isInteger(value) || value < 1) unsupported('@glsl-es300', path, `${path} must be a positive integer.`);
  return value;
}

function unsupported(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_TARGET_UNSUPPORTED', message, { moduleId, path, details: { target: 'webgl2-glsl-es300', profile: 'webgl2-compatible' } });
}

function codegenError(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_GLSL_CODEGEN', message, { moduleId, path });
}
