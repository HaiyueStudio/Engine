import type { ShaderStage } from '../contracts';
import { compareStableText } from '../naming';
import type {
  ShaderIrEntry,
  ShaderIrNode,
  ShaderIrNodeOperation,
  ShaderIrPayloadValue,
  ShaderIrProgram,
  ShaderIrSource,
} from './contracts';
import {
  parseShaderIrDataType,
  shaderIrValueTypeKey,
  shaderIrValueTypesEqual,
  type ShaderIrScalarType,
} from './types';

const IMPLICIT_STATE_OPERATIONS = new Set<ShaderIrNodeOperation>([
  'texture-sample',
  'texture-sample-level',
  'derivative-x',
  'derivative-y',
]);

export interface ShaderIrOptimizationReport {
  readonly schema: 'haiyue-shader-ir-optimization@1';
  readonly inputNodeCount: number;
  readonly reachableNodeCountBeforeOptimization: number;
  readonly outputNodeCount: number;
  readonly constantFoldedNodeCount: number;
  readonly commonSubexpressionEliminatedNodeCount: number;
  readonly eliminatedNodeCount: number;
  readonly protectedOperationCounts: Readonly<{
    textureSample: number;
    textureSampleLevel: number;
    derivativeX: number;
    derivativeY: number;
  }>;
  readonly durationMs: number;
}

export interface OptimizedShaderIrProgram {
  readonly program: ShaderIrProgram;
  readonly report: ShaderIrOptimizationReport;
}

interface EntryOptimization {
  readonly entry: ShaderIrEntry;
  readonly inputNodeCount: number;
  readonly reachableNodeCountBeforeOptimization: number;
  readonly outputNodeCount: number;
  readonly constantFoldedNodeCount: number;
  readonly commonSubexpressionEliminatedNodeCount: number;
  readonly protectedOperationCounts: [number, number, number, number];
}

interface LiteralConstant {
  readonly scalarType: ShaderIrScalarType;
  readonly values: readonly (boolean | number)[];
}

/**
 * Optimizes a validated program without changing its public identity.
 * Canonical hashing uses the same normalization, so the optimized graph retains
 * the input canonical hash while diagnostic source metadata remains out-of-band.
 */
export function optimizeShaderIrProgram(program: ShaderIrProgram): OptimizedShaderIrProgram {
  const startedAt = nowMs();
  const optimized = optimizeShaderIrEntries(program.entries);
  const body = Object.freeze({
    format: program.format,
    version: program.version,
    id: program.id,
    resources: program.resources,
    entries: optimized.entries,
  });
  const optimizedProgram = Object.freeze({ ...body, canonicalHash: program.canonicalHash });
  return Object.freeze({
    program: optimizedProgram,
    report: Object.freeze({
      schema: 'haiyue-shader-ir-optimization@1' as const,
      inputNodeCount: optimized.inputNodeCount,
      reachableNodeCountBeforeOptimization: optimized.reachableNodeCountBeforeOptimization,
      outputNodeCount: optimized.outputNodeCount,
      constantFoldedNodeCount: optimized.constantFoldedNodeCount,
      commonSubexpressionEliminatedNodeCount: optimized.commonSubexpressionEliminatedNodeCount,
      eliminatedNodeCount: optimized.inputNodeCount - optimized.outputNodeCount,
      protectedOperationCounts: Object.freeze({
        textureSample: optimized.protectedOperationCounts[0],
        textureSampleLevel: optimized.protectedOperationCounts[1],
        derivativeX: optimized.protectedOperationCounts[2],
        derivativeY: optimized.protectedOperationCounts[3],
      }),
      durationMs: Math.max(0, nowMs() - startedAt),
    }),
  });
}

export function shaderIrOperationHasImplicitState(operation: ShaderIrNodeOperation): boolean {
  return IMPLICIT_STATE_OPERATIONS.has(operation);
}

export function optimizeShaderIrEntries(entries: readonly ShaderIrEntry[]): {
  readonly entries: readonly ShaderIrEntry[];
  readonly inputNodeCount: number;
  readonly reachableNodeCountBeforeOptimization: number;
  readonly outputNodeCount: number;
  readonly constantFoldedNodeCount: number;
  readonly commonSubexpressionEliminatedNodeCount: number;
  readonly protectedOperationCounts: readonly [number, number, number, number];
} {
  const results = entries.map(optimizeEntry);
  const protectedCounts: [number, number, number, number] = [0, 0, 0, 0];
  for (const result of results) {
    protectedCounts[0] += result.protectedOperationCounts[0];
    protectedCounts[1] += result.protectedOperationCounts[1];
    protectedCounts[2] += result.protectedOperationCounts[2];
    protectedCounts[3] += result.protectedOperationCounts[3];
  }
  return Object.freeze({
    entries: Object.freeze(results.map(result => result.entry)),
    inputNodeCount: sum(results, result => result.inputNodeCount),
    reachableNodeCountBeforeOptimization: sum(results, result => result.reachableNodeCountBeforeOptimization),
    outputNodeCount: sum(results, result => result.outputNodeCount),
    constantFoldedNodeCount: sum(results, result => result.constantFoldedNodeCount),
    commonSubexpressionEliminatedNodeCount: sum(results, result => result.commonSubexpressionEliminatedNodeCount),
    protectedOperationCounts: Object.freeze(protectedCounts),
  });
}

function optimizeEntry(entry: ShaderIrEntry): EntryOptimization {
  const required = requiredNodeIds(entry);
  const oldToIntermediate = new Map<number, number>();
  const intermediate: ShaderIrNode[] = [];
  const expressionIds = new Map<string, number>();
  const protectedCounts: [number, number, number, number] = [0, 0, 0, 0];
  let foldedCount = 0;
  let cseCount = 0;

  for (const node of entry.nodes) {
    if (!required.has(node.id)) continue;
    const operands = node.operands.map(operand => {
      const mapped = oldToIntermediate.get(operand);
      if (mapped === undefined) throw new Error(`Optimizer encountered non-topological operand ${operand} in ${entry.id}.`);
      return mapped;
    });
    const candidate = cloneNode(node, intermediate.length, operands);
    const replacement = safeIdentityReplacement(candidate, intermediate);
    if (replacement !== null) {
      foldedCount += 1;
      oldToIntermediate.set(node.id, replacement);
      mergeNodeSources(intermediate, replacement, nodeSources(candidate));
      continue;
    }
    const folded = foldConstantNode(candidate, intermediate);
    const normalized = folded ?? candidate;
    if (folded) foldedCount += 1;

    if (shaderIrOperationHasImplicitState(normalized.operation)) {
      incrementProtectedCount(protectedCounts, normalized.operation);
      intermediate.push(normalized);
      oldToIntermediate.set(node.id, normalized.id);
      continue;
    }

    const key = expressionKey(normalized);
    const existing = expressionIds.get(key);
    if (existing !== undefined) {
      cseCount += 1;
      oldToIntermediate.set(node.id, existing);
      mergeNodeSources(intermediate, existing, nodeSources(normalized));
      continue;
    }
    expressionIds.set(key, normalized.id);
    intermediate.push(normalized);
    oldToIntermediate.set(node.id, normalized.id);
  }

  const intermediateInputIds = entry.inputs.map(input => oldToIntermediate.get(input.nodeId)!);
  const intermediateOutputId = entry.output ? oldToIntermediate.get(entry.output.nodeId)! : null;
  const compacted = compactNodes(intermediate, intermediateInputIds, intermediateOutputId);
  const inputs = Object.freeze(entry.inputs.map((input, index) => Object.freeze({
    ...input,
    nodeId: compacted.oldToNew.get(intermediateInputIds[index]!)!,
  })));
  const output = entry.output === null ? null : Object.freeze({
    ...entry.output,
    nodeId: compacted.oldToNew.get(intermediateOutputId!)!,
  });
  return Object.freeze({
    entry: Object.freeze({ ...entry, inputs, output, nodes: compacted.nodes }),
    inputNodeCount: entry.nodes.length,
    reachableNodeCountBeforeOptimization: required.size,
    outputNodeCount: compacted.nodes.length,
    constantFoldedNodeCount: foldedCount,
    commonSubexpressionEliminatedNodeCount: cseCount,
    protectedOperationCounts: protectedCounts,
  });
}

function requiredNodeIds(entry: ShaderIrEntry): ReadonlySet<number> {
  const required = new Set(entry.inputs.map(input => input.nodeId));
  const visit = (id: number): void => {
    if (required.has(id)) return;
    const node = entry.nodes[id];
    if (!node) return;
    required.add(id);
    for (const operand of node.operands) visit(operand);
  };
  if (entry.output) visit(entry.output.nodeId);
  return required;
}

function compactNodes(
  nodes: readonly ShaderIrNode[],
  inputIds: readonly number[],
  outputId: number | null,
): { readonly nodes: readonly ShaderIrNode[]; readonly oldToNew: ReadonlyMap<number, number> } {
  const required = new Set(inputIds);
  const visit = (id: number): void => {
    if (required.has(id)) return;
    const node = nodes[id];
    if (!node) return;
    required.add(id);
    for (const operand of node.operands) visit(operand);
  };
  if (outputId !== null) visit(outputId);
  const oldToNew = new Map<number, number>();
  for (const node of nodes) if (required.has(node.id)) oldToNew.set(node.id, oldToNew.size);
  const compacted = nodes.filter(node => required.has(node.id)).map(node => Object.freeze({
    ...node,
    id: oldToNew.get(node.id)!,
    operands: Object.freeze(node.operands.map(operand => oldToNew.get(operand)!)),
  }));
  return Object.freeze({ nodes: Object.freeze(compacted), oldToNew });
}

function cloneNode(node: ShaderIrNode, id: number, operands: readonly number[]): ShaderIrNode {
  return Object.freeze({
    ...node,
    id,
    operands: Object.freeze(operands),
    payload: Object.freeze({ ...node.payload }),
    ...(node.sourceAliases === undefined ? {} : { sourceAliases: Object.freeze([...node.sourceAliases]) }),
  });
}

function foldConstantNode(node: ShaderIrNode, nodes: readonly ShaderIrNode[]): ShaderIrNode | null {
  const operands = node.operands.map(id => literalConstant(nodes[id]));
  if (operands.some(value => value === null)) return null;
  const constants = operands as readonly LiteralConstant[];
  let values: readonly (boolean | number)[] | null = null;
  switch (node.operation) {
    case 'splat':
      values = Array(Number(node.payload.width)).fill(constants[0]!.values[0]!);
      break;
    case 'construct':
      values = constants.flatMap(value => [...value.values]);
      break;
    case 'semantic':
      values = constants[0]!.values;
      break;
    case 'swizzle':
      values = foldSwizzle(constants[0]!.values, String(node.payload.pattern));
      break;
    case 'cast':
      values = foldCast(constants[0]!, parseShaderIrDataType(node.type.dataType).scalarType);
      break;
    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide':
      values = foldArithmetic(node, constants[0]!, constants[1]!);
      break;
    case 'clamp':
      values = foldClamp(node, constants[0]!, constants[1]!, constants[2]!);
      break;
    default:
      return null;
  }
  if (values === null) return null;
  return literalNode(node, values);
}

function safeIdentityReplacement(node: ShaderIrNode, nodes: readonly ShaderIrNode[]): number | null {
  if (node.operation !== 'multiply' && node.operation !== 'divide') return null;
  const left = nodes[node.operands[0]!];
  const right = nodes[node.operands[1]!];
  if (!left || !right) return null;
  if (node.operation === 'divide') {
    return isScalarOne(right) && shaderIrValueTypesEqual(left.type, node.type) ? left.id : null;
  }
  if (isScalarOne(left) && shaderIrValueTypesEqual(right.type, node.type)) return right.id;
  if (isScalarOne(right) && shaderIrValueTypesEqual(left.type, node.type)) return left.id;
  return null;
}

function isScalarOne(node: ShaderIrNode): boolean {
  const constant = literalConstant(node);
  return constant !== null && constant.values.length === 1 && constant.values[0] === 1;
}

function literalConstant(node: ShaderIrNode | undefined): LiteralConstant | null {
  if (!node || node.operation !== 'literal') return null;
  const info = parseShaderIrDataType(node.type.dataType);
  const raw = info.kind === 'scalar' ? [node.payload.value] : node.payload.values;
  if (!Array.isArray(raw)) return null;
  if (raw.some(value => typeof value !== 'boolean' && typeof value !== 'number')) return null;
  return Object.freeze({
    scalarType: info.scalarType,
    values: Object.freeze(raw as (boolean | number)[]),
  });
}

function literalNode(node: ShaderIrNode, values: readonly (boolean | number)[]): ShaderIrNode {
  const info = parseShaderIrDataType(node.type.dataType);
  const payload: Readonly<Record<string, ShaderIrPayloadValue>> = info.kind === 'scalar'
    ? Object.freeze({ value: values[0]! })
    : Object.freeze({ values: Object.freeze(values as readonly number[]) });
  return Object.freeze({
    ...node,
    operation: 'literal' as const,
    operands: Object.freeze([]),
    payload,
    optimization: 'constant-folded' as const,
  });
}

function foldSwizzle(values: readonly (boolean | number)[], pattern: string): readonly (boolean | number)[] | null {
  const components = 'xyzw'.includes(pattern[0] ?? '') ? 'xyzw' : 'rgba';
  const result = [...pattern].map(component => values[components.indexOf(component)]);
  return result.some(value => value === undefined) ? null : result as readonly (boolean | number)[];
}

function foldCast(value: LiteralConstant, outputType: ShaderIrScalarType): readonly (boolean | number)[] | null {
  if (value.scalarType === 'bool' || outputType === 'bool') return value.scalarType === outputType ? value.values : null;
  const converted: number[] = [];
  for (const item of value.values) {
    if (typeof item !== 'number') return null;
    const input = value.scalarType === 'f32' ? Math.fround(item) : item;
    if (!safeFoldedNumber(input)) return null;
    let result: number;
    if (outputType === 'f32') result = Math.fround(input);
    else if (outputType === 'i32') {
      if (!Number.isInteger(input) || input < -0x80000000 || input > 0x7fffffff) return null;
      result = input;
    } else {
      if (!Number.isInteger(input) || input < 0 || input > 0xffffffff) return null;
      result = input;
    }
    if (!safeFoldedNumber(result)) return null;
    converted.push(result);
  }
  return converted;
}

function foldArithmetic(
  node: ShaderIrNode,
  left: LiteralConstant,
  right: LiteralConstant,
): readonly number[] | null {
  const info = parseShaderIrDataType(node.type.dataType);
  if (info.kind === 'matrix' || info.scalarType === 'bool') return null;
  const leftValues = broadcast(left.values, info.width);
  const rightValues = broadcast(right.values, info.width);
  if (!leftValues || !rightValues) return null;
  const result: number[] = [];
  for (let index = 0; index < info.width; index += 1) {
    const folded = foldNumericBinary(
      node.operation as 'add' | 'subtract' | 'multiply' | 'divide',
      info.scalarType,
      leftValues[index]!,
      rightValues[index]!,
    );
    if (folded === null) return null;
    result.push(folded);
  }
  return result;
}

function foldClamp(
  node: ShaderIrNode,
  value: LiteralConstant,
  low: LiteralConstant,
  high: LiteralConstant,
): readonly number[] | null {
  const info = parseShaderIrDataType(node.type.dataType);
  if (info.kind === 'matrix' || info.scalarType === 'bool') return null;
  const values = broadcast(value.values, info.width);
  const lows = broadcast(low.values, info.width);
  const highs = broadcast(high.values, info.width);
  if (!values || !lows || !highs) return null;
  const typedValues = normalizeNumericConstants(values, info.scalarType);
  const typedLows = normalizeNumericConstants(lows, info.scalarType);
  const typedHighs = normalizeNumericConstants(highs, info.scalarType);
  if (!typedValues || !typedLows || !typedHighs) return null;
  const result = typedValues.map((item, index) => Math.min(
    Math.max(item, typedLows[index]!),
    typedHighs[index]!,
  ));
  return result.every(safeFoldedNumber) ? result : null;
}

function foldNumericBinary(
  operation: 'add' | 'subtract' | 'multiply' | 'divide',
  scalarType: Exclude<ShaderIrScalarType, 'bool'>,
  left: boolean | number,
  right: boolean | number,
): number | null {
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  if (operation === 'divide' && (right === 0 || (scalarType === 'i32' && left === -0x80000000 && right === -1))) return null;
  if (scalarType === 'f32') {
    const a = Math.fround(left);
    const b = Math.fround(right);
    const value = Math.fround(operation === 'add' ? a + b : operation === 'subtract' ? a - b : operation === 'multiply' ? a * b : a / b);
    return safeFoldedNumber(value) ? value : null;
  }
  if (scalarType === 'i32') {
    if (!inI32(left) || !inI32(right)) return null;
    if (operation === 'multiply') return Math.imul(left, right);
    if (operation === 'divide') return Math.trunc(left / right) | 0;
    return operation === 'add' ? (left + right) | 0 : (left - right) | 0;
  }
  if (!inU32(left) || !inU32(right)) return null;
  if (operation === 'multiply') return Math.imul(left, right) >>> 0;
  if (operation === 'divide') return Math.trunc(left / right) >>> 0;
  return operation === 'add' ? (left + right) >>> 0 : (left - right) >>> 0;
}

function broadcast(values: readonly (boolean | number)[], width: number): readonly (boolean | number)[] | null {
  if (values.length === width) return values;
  return values.length === 1 ? Object.freeze(Array(width).fill(values[0]!)) : null;
}

function normalizeNumericConstants(
  values: readonly (boolean | number)[],
  scalarType: Exclude<ShaderIrScalarType, 'bool'>,
): readonly number[] | null {
  const result: number[] = [];
  for (const value of values) {
    if (typeof value !== 'number') return null;
    const normalized = scalarType === 'f32' ? Math.fround(value) : value;
    if (!safeFoldedNumber(normalized)) return null;
    if (scalarType === 'i32' && !inI32(normalized)) return null;
    if (scalarType === 'u32' && !inU32(normalized)) return null;
    result.push(normalized);
  }
  return result;
}

function expressionKey(node: ShaderIrNode): string {
  const payload = Object.fromEntries(Object.entries(node.payload).sort(([left], [right]) => compareStableText(left, right)));
  return JSON.stringify([
    node.operation,
    shaderIrValueTypeKey(node.type),
    [...node.allowedStages],
    [...node.operands],
    payload,
  ]);
}

function mergeNodeSources(nodes: ShaderIrNode[], id: number, additions: readonly ShaderIrSource[]): void {
  const node = nodes[id];
  if (!node) return;
  const sources = uniqueSources([...nodeSources(node), ...additions]);
  nodes[id] = Object.freeze({
    ...node,
    ...(sources.length <= 1 ? {} : { sourceAliases: Object.freeze(sources.slice(1)) }),
  });
}

function nodeSources(node: ShaderIrNode): readonly ShaderIrSource[] {
  return Object.freeze([node.source, ...(node.sourceAliases ?? [])]);
}

function uniqueSources(sources: readonly ShaderIrSource[]): ShaderIrSource[] {
  const seen = new Set<string>();
  return sources.filter(source => {
    const key = JSON.stringify(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function incrementProtectedCount(counts: [number, number, number, number], operation: ShaderIrNodeOperation): void {
  if (operation === 'texture-sample') counts[0] += 1;
  else if (operation === 'texture-sample-level') counts[1] += 1;
  else if (operation === 'derivative-x') counts[2] += 1;
  else if (operation === 'derivative-y') counts[3] += 1;
}

function inI32(value: number): boolean {
  return Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
}

function inU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function safeFoldedNumber(value: number): boolean {
  return Number.isFinite(value) && !Object.is(value, -0);
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
  return values.reduce((total, value) => total + read(value), 0);
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}
