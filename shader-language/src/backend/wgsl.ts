import type {
  ShaderGeneratedSourceSpan,
  ShaderStage,
} from '../contracts';
import { shaderError } from '../diagnostics';
import { compareStableText } from '../naming';
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
import {
  compilationNowMs,
  createShaderCompilationCostEvidence,
  type ShaderCompilationCostEvidence,
  type ShaderCompilationCostOptions,
} from './compilationCost';

export interface ShaderIrWgslResourceResolver {
  resource(resourceId: string): string;
  uniformField(resourceId: string, fieldId: string): string;
}

export interface ShaderIrWgslCompilation {
  readonly code: string;
  readonly sourceMap: readonly ShaderGeneratedSourceSpan[];
  readonly canonicalHash: string;
  readonly entryPoints: readonly { readonly stage: ShaderStage; readonly name: string }[];
  readonly cost: ShaderCompilationCostEvidence;
}

export function compileShaderIrProgramToWgsl(
  program: ShaderIrProgram,
  resources: ShaderIrWgslResourceResolver,
  costOptions: ShaderCompilationCostOptions = {},
): ShaderIrWgslCompilation {
  const totalStartedAt = compilationNowMs();
  const validationStartedAt = compilationNowMs();
  validateShaderIrProgram(program);
  const validationMs = compilationNowMs() - validationStartedAt;
  const optimizationStartedAt = compilationNowMs();
  const optimized = optimizeShaderIrProgram(program);
  const optimizationMs = compilationNowMs() - optimizationStartedAt;
  const optimizedProgram = optimized.program;
  const codeGenerationStartedAt = compilationNowMs();
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

  lines.push(`// haiyue:typed-ir ${program.canonicalHash}`);
  const entries = [...optimizedProgram.entries].sort((left, right) =>
    compareStableText(`${left.stage}:${left.name}:${left.id}`, `${right.stage}:${right.name}:${right.id}`));
  for (const [entryIndex, entry] of entries.entries()) {
    emitEntry(optimizedProgram, entry, entryIndex, resources, append);
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  const code = `${lines.join('\n')}\n`;
  const codeGenerationMs = compilationNowMs() - codeGenerationStartedAt;
  const phaseMs = Object.freeze({
    validation: validationMs,
    optimization: optimizationMs,
    bindingPlan: 0,
    codeGeneration: codeGenerationMs,
    total: compilationNowMs() - totalStartedAt,
  });
  return Object.freeze({
    code,
    sourceMap: Object.freeze(sourceMap),
    canonicalHash: program.canonicalHash,
    entryPoints: Object.freeze(entries.map(entry => Object.freeze({ stage: entry.stage, name: entry.name }))),
    cost: createShaderCompilationCostEvidence(code, optimized.report, phaseMs, costOptions),
  });
}

function emitEntry(
  program: ShaderIrProgram,
  entry: ShaderIrEntry,
  entryIndex: number,
  resources: ShaderIrWgslResourceResolver,
  append: (line: string, source?: ShaderIrSource | readonly ShaderIrSource[]) => void,
): void {
  const parameters = entry.inputs.map(input => {
    const attributes = input.location === undefined
      ? `@builtin(${input.builtin})`
      : `@location(${input.location})${input.interpolation ? ` @interpolate(${input.interpolation})` : ''}`;
    return `${attributes} ${inputName(input.id)} : ${input.type.dataType}`;
  }).join(', ');
  const stageAttribute = entry.stage === 'compute' ? '@compute @workgroup_size(1)' : `@${entry.stage}`;
  const returnType = entry.output
    ? ` -> ${entry.output.location === undefined ? `@builtin(${entry.output.builtin})` : `@location(${entry.output.location})`} ${entry.output.type.dataType}`
    : '';
  append(`${stageAttribute} fn ${entry.name}(${parameters})${returnType} {`, entry.source);

  const nodes = reachableShaderIrNodes(entry);
  const nodeNames = new Map<number, string>();
  const uses = countNodeUses(entry, nodes);
  const consumerSources = collectConsumerSources(entry, nodes);
  for (const input of entry.inputs) nodeNames.set(input.nodeId, inputName(input.id));
  for (const [canonicalIndex, node] of nodes.entries()) {
    if (node.operation === 'input') continue;
    if ((node.operation === 'literal' || node.operation === 'uniform-field' || node.operation === 'semantic')
      && node.optimization === undefined && node.sourceAliases === undefined) {
      nodeNames.set(node.id, emitExpression(program, entry, node, nodeNames, resources));
      continue;
    }
    const expression = emitExpression(program, entry, node, nodeNames, resources);
    if (canInlineExpression(node, uses, consumerSources)) {
      nodeNames.set(node.id, expression);
      continue;
    }
    const variable = `hy_ir_${entryIndex}_${canonicalIndex}`;
    append(`  let ${variable} : ${node.type.dataType} = ${expression};`, nodeSources(node));
    nodeNames.set(node.id, variable);
  }
  if (entry.output) {
    const result = nodeNames.get(entry.output.nodeId);
    if (!result) codegenError(program.id, entry.id, `Output node ${entry.output.nodeId} has no generated value.`);
    append(`  return ${result};`, entry.output.source);
  }
  append('}', entry.source);
}

function countNodeUses(entry: ShaderIrEntry, nodes: readonly ShaderIrNode[]): ReadonlyMap<number, number> {
  const uses = new Map<number, number>();
  for (const node of nodes) {
    for (const operand of node.operands) uses.set(operand, (uses.get(operand) ?? 0) + 1);
  }
  if (entry.output) uses.set(entry.output.nodeId, (uses.get(entry.output.nodeId) ?? 0) + 1);
  return uses;
}

function collectConsumerSources(
  entry: ShaderIrEntry,
  nodes: readonly ShaderIrNode[],
): ReadonlyMap<number, readonly string[]> {
  const sources = new Map<number, string[]>();
  for (const node of nodes) {
    for (const operand of node.operands) {
      const values = sources.get(operand) ?? [];
      values.push(node.source.sourceId);
      sources.set(operand, values);
    }
  }
  if (entry.output) {
    const values = sources.get(entry.output.nodeId) ?? [];
    values.push(entry.output.source.sourceId);
    sources.set(entry.output.nodeId, values);
  }
  return sources;
}

function canInlineExpression(
  node: ShaderIrNode,
  uses: ReadonlyMap<number, number>,
  consumerSources: ReadonlyMap<number, readonly string[]>,
): boolean {
  if (uses.get(node.id) !== 1 || node.sourceAliases !== undefined) return false;
  if (shaderIrOperationHasImplicitState(node.operation)) return false;
  const consumers = consumerSources.get(node.id);
  return consumers?.length === 1 && consumers[0] === node.source.sourceId;
}

function nodeSources(node: ShaderIrNode): readonly ShaderIrSource[] {
  return Object.freeze([node.source, ...(node.sourceAliases ?? [])]);
}

function emitExpression(
  program: ShaderIrProgram,
  entry: ShaderIrEntry,
  node: ShaderIrNode,
  nodeNames: ReadonlyMap<number, string>,
  resources: ShaderIrWgslResourceResolver,
): string {
  const operand = (index: number): string => {
    const nodeId = node.operands[index];
    const name = nodeId === undefined ? undefined : nodeNames.get(nodeId);
    if (!name) codegenError(program.id, entry.id, `Node ${node.id} has unresolved operand ${index}.`);
    return name;
  };
  switch (node.operation) {
    case 'literal':
      return literalExpression(node);
    case 'uniform-field':
      return resources.uniformField(payloadString(node, 'resourceId'), payloadString(node, 'fieldId'));
    case 'splat':
    case 'construct':
      return `${node.type.dataType}(${node.operands.map((_id, index) => operand(index)).join(', ')})`;
    case 'cast':
      return `${payloadString(node, 'dataType')}(${operand(0)})`;
    case 'semantic':
      return operand(0);
    case 'add':
      return `(${operand(0)} + ${operand(1)})`;
    case 'subtract':
      return `(${operand(0)} - ${operand(1)})`;
    case 'multiply':
      return `(${operand(0)} * ${operand(1)})`;
    case 'divide':
      return `(${operand(0)} / ${operand(1)})`;
    case 'dot':
      return `dot(${operand(0)}, ${operand(1)})`;
    case 'cross':
      return `cross(${operand(0)}, ${operand(1)})`;
    case 'normalize':
      return `normalize(${operand(0)})`;
    case 'pow':
      return `pow(${operand(0)}, ${operand(1)})`;
    case 'sqrt':
      return `sqrt(${operand(0)})`;
    case 'mix':
      return `mix(${operand(0)}, ${operand(1)}, ${operand(2)})`;
    case 'clamp':
      return `clamp(${operand(0)}, ${operand(1)}, ${operand(2)})`;
    case 'sin':
      return `sin(${operand(0)})`;
    case 'swizzle':
      return `${operand(0)}.${payloadString(node, 'pattern')}`;
    case 'texture-sample':
      return `textureSample(${resources.resource(payloadString(node, 'textureId'))}, ${resources.resource(payloadString(node, 'samplerId'))}, ${operand(0)})`;
    case 'texture-sample-level':
      return `textureSampleLevel(${resources.resource(payloadString(node, 'textureId'))}, ${resources.resource(payloadString(node, 'samplerId'))}, ${operand(0)}, ${operand(1)})`;
    case 'derivative-x':
      return `dpdx(${operand(0)})`;
    case 'derivative-y':
      return `dpdy(${operand(0)})`;
    case 'transform-position':
      return transformPositionExpression(entry, node, operand(0), operand(1));
    case 'transform-direction':
    case 'transform-normal':
      return transformVectorExpression(entry, node, operand(0), operand(1));
    case 'srgb-to-linear':
      return srgbToLinearExpression(node.type.dataType, operand(0));
    case 'input':
      codegenError(program.id, entry.id, `Input node ${node.id} cannot be emitted as a local expression.`);
  }
}

function transformPositionExpression(
  entry: ShaderIrEntry,
  node: ShaderIrNode,
  matrix: string,
  value: string,
): string {
  const inputNode = entry.nodes[node.operands[1]!];
  if (!inputNode) codegenError('@typed-ir', entry.id, `Missing transform position operand for node ${node.id}.`);
  const input = inputNode.type.dataType === 'vec4<f32>' ? value : `vec4<f32>(${value}, 1.0)`;
  const transformed = `(${matrix} * ${input})`;
  return node.type.dataType === 'vec4<f32>' ? transformed : `${transformed}.xyz`;
}

function transformVectorExpression(
  entry: ShaderIrEntry,
  node: ShaderIrNode,
  matrix: string,
  value: string,
): string {
  const matrixNode = entry.nodes[node.operands[0]!];
  if (!matrixNode) codegenError('@typed-ir', entry.id, `Missing transform matrix operand for node ${node.id}.`);
  const transformed = matrixNode.type.dataType === 'mat3x3<f32>'
    ? `(${matrix} * ${value})`
    : `(${matrix} * vec4<f32>(${value}, 0.0)).xyz`;
  return node.operation === 'transform-normal' ? `normalize(${transformed})` : transformed;
}

function srgbToLinearExpression(dataType: ShaderIrDataType, value: string): string {
  const info = parseShaderIrDataType(dataType);
  const vectorType = `vec${info.width}<f32>`;
  if (info.width === 3) return srgbVectorExpression(vectorType, value);
  if (info.width === 4) return `vec4<f32>(${srgbVectorExpression('vec3<f32>', `${value}.rgb`)}, ${value}.a)`;
  codegenError('@typed-ir', '@srgb', `Unsupported sRGB type ${dataType}.`);
}

function srgbVectorExpression(type: string, value: string): string {
  return `select(${value} / ${type}(12.92), pow((${value} + ${type}(0.055)) / ${type}(1.055), ${type}(2.4)), ${value} > ${type}(0.04045))`;
}

function literalExpression(node: ShaderIrNode): string {
  const info = parseShaderIrDataType(node.type.dataType);
  if (info.kind === 'scalar') return scalarLiteral(info.scalarType, node.payload.value);
  const values = node.payload.values;
  if (!Array.isArray(values)) codegenError('@typed-ir', '@literal', `Node ${node.id} is missing literal values.`);
  return `${node.type.dataType}(${values.map(value => scalarLiteral(info.scalarType, value)).join(', ')})`;
}

function scalarLiteral(type: string, value: ShaderIrPayloadValue | undefined): string {
  if (type === 'bool') {
    if (typeof value !== 'boolean') codegenError('@typed-ir', '@literal', `Expected bool literal, got ${String(value)}.`);
    return value ? 'true' : 'false';
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) codegenError('@typed-ir', '@literal', `Expected numeric literal, got ${String(value)}.`);
  if (type === 'u32') return `${value}u`;
  if (type === 'i32') return `${value}i`;
  const literal = Number.isInteger(value) ? `${value}.0` : String(value);
  return `${literal}f`;
}

function payloadString(node: ShaderIrNode, key: string): string {
  const value = node.payload[key];
  if (typeof value !== 'string') codegenError('@typed-ir', '@payload', `Node ${node.id} payload ${key} must be a string.`);
  return value;
}

function inputName(id: string): string {
  return `hy_in_${id}`;
}

function codegenError(moduleId: string, entryId: string, message: string): never {
  shaderError('E_SHADER_WGSL_CODEGEN', message, { moduleId, path: entryId });
}
