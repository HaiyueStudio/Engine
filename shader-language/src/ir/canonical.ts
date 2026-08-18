import { sha256Hex } from '../hash';
import { compareStableText } from '../naming';
import type { ShaderIrEntry, ShaderIrNode, ShaderIrProgram } from './contracts';
import { optimizeShaderIrEntries } from './optimizer';

export function computeShaderIrCanonicalHash(
  program: Omit<ShaderIrProgram, 'canonicalHash'> | ShaderIrProgram,
): string {
  return sha256Hex(JSON.stringify(createShaderIrCanonicalForm(program)));
}

export function createShaderIrCanonicalForm(
  program: Omit<ShaderIrProgram, 'canonicalHash'> | ShaderIrProgram,
): unknown {
  const optimizedEntries = optimizeShaderIrEntries(program.entries).entries;
  return {
    format: program.format,
    version: program.version,
    resources: [...program.resources]
      .sort((left, right) => compareStableText(left.id, right.id))
      .map(resource => ({
        id: resource.id,
        space: resource.space,
        kind: resource.kind,
        visibility: [...resource.visibility],
        valueType: resource.valueType ?? null,
        fields: resource.fields?.map(field => ({
          id: field.id,
          type: field.type,
          semantic: field.semantic ?? 'value',
          coordinateSpace: field.coordinateSpace ?? null,
          colorSpace: field.colorSpace ?? null,
          fromSpace: field.fromSpace ?? null,
          toSpace: field.toSpace ?? null,
        })) ?? null,
        colorSpace: resource.colorSpace ?? null,
        fixedBinding: resource.fixedBinding ?? null,
      })),
    entries: [...optimizedEntries]
      .sort(compareEntries)
      .map(canonicalEntry),
  };
}

export function reachableShaderIrNodes(entry: ShaderIrEntry): readonly ShaderIrNode[] {
  if (!entry.output) return Object.freeze([]);
  const byId = new Map(entry.nodes.map(node => [node.id, node]));
  const visited = new Set<number>();
  const ordered: ShaderIrNode[] = [];
  const visit = (id: number): void => {
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    for (const operand of node.operands) visit(operand);
    visited.add(id);
    ordered.push(node);
  };
  visit(entry.output.nodeId);
  return Object.freeze(ordered);
}

function canonicalEntry(entry: ShaderIrEntry): unknown {
  const nodes = reachableShaderIrNodes(entry);
  const canonicalIds = new Map(nodes.map((node, index) => [node.id, index]));
  return {
    id: entry.id,
    stage: entry.stage,
    name: entry.name,
    inputs: entry.inputs.map(input => ({
      id: input.id,
      type: canonicalType(input.type),
      location: input.location ?? null,
      builtin: input.builtin ?? null,
      interpolation: input.interpolation ?? null,
    })),
    output: entry.output ? {
      type: canonicalType(entry.output.type),
      location: entry.output.location ?? null,
      builtin: entry.output.builtin ?? null,
      node: canonicalIds.get(entry.output.nodeId) ?? null,
    } : null,
    nodes: nodes.map(node => ({
      operation: node.operation,
      type: canonicalType(node.type),
      allowedStages: [...node.allowedStages],
      operands: node.operands.map(operand => canonicalIds.get(operand)),
      payload: Object.fromEntries(Object.entries(node.payload).sort(([left], [right]) => compareStableText(left, right))),
    })),
  };
}

function canonicalType(type: ShaderIrNode['type']): unknown {
  return {
    dataType: type.dataType,
    semantic: type.semantic,
    coordinateSpace: type.coordinateSpace ?? null,
    colorSpace: type.colorSpace ?? null,
    fromSpace: type.fromSpace ?? null,
    toSpace: type.toSpace ?? null,
  };
}

function compareEntries(left: ShaderIrEntry, right: ShaderIrEntry): number {
  return compareStableText(`${left.stage}:${left.name}:${left.id}`, `${right.stage}:${right.name}:${right.id}`);
}
