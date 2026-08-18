import {
  SHADER_CAPABILITY_PROFILES,
  SHADER_COLOR_SPACES,
  type ShaderDiagnosticCode,
} from '../contracts';
import { shaderError } from '../diagnostics';
import {
  SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS,
  SHADER_GRAPH_V1_ROOT_FIELDS,
  SHADER_GRAPH_V1_UNSUPPORTED_ROOT_FIELDS,
  type ParseShaderGraphV1Options,
  type ShaderGraphKind,
  type ShaderGraphLiteralValueV1,
  type ShaderGraphNodeV1,
  type ShaderGraphResourceFrequency,
  type ShaderGraphResourceKind,
  type ShaderGraphResourceV1,
  type ShaderGraphSourceLocation,
  type ShaderGraphV1,
  type ShaderGraphValueV1,
} from './contracts';

const ROOT_KEYS = new Set<string>(SHADER_GRAPH_V1_ROOT_FIELDS);
const RESOURCE_KEYS = new Set(['id', 'space', 'kind', 'valueType', 'frequency', 'colorSpace']);
const NODE_KEYS = new Set(['id', 'type', 'typeVersion', 'inputs', 'metadata']);
const RESOURCE_ID = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const NODE_TYPE = /^[a-z][a-z0-9.-]*$/;
const FEATURE_ID = /^[a-z][a-z0-9.-]*$/;
const RESOURCE_KINDS: readonly ShaderGraphResourceKind[] = [
  'uniform', 'texture-2d', 'texture-cube', 'sampler', 'storage-read', 'storage-read-write',
];
const FREQUENCIES: readonly ShaderGraphResourceFrequency[] = ['material', 'draw', 'frame', 'pass'];
const GRAPH_KINDS: readonly ShaderGraphKind[] = ['material', 'postprocess', 'compute'];

export function parseShaderGraphV1(
  input: string | unknown,
  options: ParseShaderGraphV1Options = {},
): ShaderGraphV1 {
  const sourceName = options.sourceName ?? 'shader.graph.json';
  const sourceText = typeof input === 'string' ? input : null;
  let raw: unknown = input;
  if (sourceText !== null) {
    try {
      raw = JSON.parse(sourceText) as unknown;
    } catch (cause) {
      graphError('E_SHADER_GRAPH_INVALID', 'Shader Graph JSON is not valid JSON.', '$', sourceName, { cause: String(cause) });
    }
  }
  const root = objectValue(raw, '$', sourceName);
  validateRootKeys(root, sourceName);
  if (root.format !== 'haiyue-shader-graph') graphError('E_SHADER_GRAPH_INVALID', 'Unsupported Shader Graph format.', 'format', sourceName);
  if (root.version !== 1) graphError('E_SHADER_GRAPH_INVALID', `Unsupported Shader Graph version ${String(root.version)}.`, 'version', sourceName);
  if (!GRAPH_KINDS.includes(root.kind as ShaderGraphKind)) graphError('E_SHADER_GRAPH_INVALID', `Unknown graph kind ${String(root.kind)}.`, 'kind', sourceName);
  if (!SHADER_CAPABILITY_PROFILES.includes(root.profile as never)) {
    graphError('E_SHADER_GRAPH_INVALID', `Unknown capability profile ${String(root.profile)}.`, 'profile', sourceName);
  }

  const resourcesRaw = arrayValue(root.resources, 'resources', sourceName);
  const graphKind = root.kind as ShaderGraphKind;
  const resources = Object.freeze(resourcesRaw.map((value, index) =>
    parseResource(value, index, sourceName, graphKind)));
  expectUnique(resources.map(resource => resource.id), 'resources', sourceName);

  const nodesRaw = arrayValue(root.nodes, 'nodes', sourceName);
  const nodes = Object.freeze(nodesRaw.map((value, index) => parseNode(value, index, sourceName)));
  expectUnique(nodes.map(node => node.id), 'nodes', sourceName);

  const outputsRaw = objectValue(root.outputs, 'outputs', sourceName);
  if (Object.keys(outputsRaw).length === 0) graphError('E_SHADER_GRAPH_INVALID', 'Shader Graph requires at least one output.', 'outputs', sourceName);
  const outputs = Object.freeze(Object.fromEntries(Object.entries(outputsRaw).map(([name, value]) => {
    if (!name) graphError('E_SHADER_GRAPH_INVALID', 'Graph output names cannot be empty.', 'outputs', sourceName);
    return [name, parseValue(value, `outputs.${name}`, sourceName)];
  })));

  const featuresRaw = root.sceneFeatures === undefined ? [] : arrayValue(root.sceneFeatures, 'sceneFeatures', sourceName);
  const sceneFeatures = Object.freeze(featuresRaw.map((value, index) => {
    if (typeof value !== 'string' || !FEATURE_ID.test(value)) {
      graphError('E_SHADER_GRAPH_INVALID', `Invalid scene feature ${String(value)}.`, `sceneFeatures.${index}`, sourceName);
    }
    return value;
  }));
  expectUnique(sceneFeatures, 'sceneFeatures', sourceName);
  const metadata = root.metadata === undefined
    ? Object.freeze({})
    : Object.freeze({ ...objectValue(root.metadata, 'metadata', sourceName) });
  const nodeLocations = Object.freeze(Object.fromEntries(nodes.flatMap(node => {
    const location = sourceText === null ? null : locateNode(sourceText, node.id);
    return location ? [[node.id, location]] : [];
  })));

  return Object.freeze({
    format: 'haiyue-shader-graph' as const,
    version: 1 as const,
    kind: root.kind as ShaderGraphKind,
    profile: root.profile as ShaderGraphV1['profile'],
    resources,
    nodes,
    outputs,
    sceneFeatures,
    metadata,
    sourceName,
    nodeLocations,
  });
}

function parseResource(
  value: unknown,
  index: number,
  sourceName: string,
  graphKind: ShaderGraphKind,
): ShaderGraphResourceV1 {
  const path = `resources.${index}`;
  const resource = objectValue(value, path, sourceName);
  exactKeys(resource, RESOURCE_KEYS, path, sourceName);
  if (typeof resource.id !== 'string' || !RESOURCE_ID.test(resource.id)) graphError('E_SHADER_GRAPH_INVALID', `Invalid graph resource id ${String(resource.id)}.`, `${path}.id`, sourceName);
  const allowedSpace = graphKind === 'material' ? 'material' : 'pass';
  if (resource.space !== allowedSpace) {
    graphError(
      'E_SHADER_GRAPH_INVALID',
      `${graphKind} Graph v1 resources must use ${allowedSpace} space.`,
      `${path}.space`,
      sourceName,
    );
  }
  if (!RESOURCE_KINDS.includes(resource.kind as ShaderGraphResourceKind)) graphError('E_SHADER_GRAPH_INVALID', `Invalid resource kind ${String(resource.kind)}.`, `${path}.kind`, sourceName);
  if (typeof resource.valueType !== 'string' || !resource.valueType.trim()) graphError('E_SHADER_GRAPH_INVALID', 'Resource valueType must be a non-empty string.', `${path}.valueType`, sourceName);
  if (!FREQUENCIES.includes(resource.frequency as ShaderGraphResourceFrequency)) graphError('E_SHADER_GRAPH_INVALID', `Invalid resource frequency ${String(resource.frequency)}.`, `${path}.frequency`, sourceName);
  if (resource.colorSpace !== undefined && !SHADER_COLOR_SPACES.includes(resource.colorSpace as never)) {
    graphError('E_SHADER_GRAPH_INVALID', `Invalid resource colorSpace ${String(resource.colorSpace)}.`, `${path}.colorSpace`, sourceName);
  }
  if (resource.colorSpace !== undefined && resource.kind !== 'texture-2d' && resource.kind !== 'texture-cube') {
    graphError('E_SHADER_GRAPH_INVALID', 'Only sampled textures may declare colorSpace.', `${path}.colorSpace`, sourceName);
  }
  return Object.freeze({
    id: resource.id,
    space: allowedSpace,
    kind: resource.kind as ShaderGraphResourceKind,
    valueType: resource.valueType,
    frequency: resource.frequency as ShaderGraphResourceFrequency,
    ...(resource.colorSpace === undefined ? {} : { colorSpace: resource.colorSpace as NonNullable<ShaderGraphResourceV1['colorSpace']> }),
  });
}

function parseNode(value: unknown, index: number, sourceName: string): ShaderGraphNodeV1 {
  const path = `nodes.${index}`;
  const node = objectValue(value, path, sourceName);
  exactKeys(node, NODE_KEYS, path, sourceName);
  if (typeof node.id !== 'string' || !NODE_ID.test(node.id)) graphError('E_SHADER_GRAPH_INVALID', `Invalid node id ${String(node.id)}.`, `${path}.id`, sourceName);
  if (typeof node.type !== 'string' || !NODE_TYPE.test(node.type)) graphError('E_SHADER_GRAPH_INVALID', `Invalid node type ${String(node.type)}.`, `${path}.type`, sourceName);
  if (!Number.isInteger(node.typeVersion) || (node.typeVersion as number) < 1) graphError('E_SHADER_GRAPH_INVALID', 'Node typeVersion must be a positive integer.', `${path}.typeVersion`, sourceName);
  const inputsRaw = objectValue(node.inputs, `${path}.inputs`, sourceName);
  const inputs = Object.freeze(Object.fromEntries(Object.entries(inputsRaw).map(([name, input]) => {
    if (!name) graphError('E_SHADER_GRAPH_INVALID', 'Node input names cannot be empty.', `${path}.inputs`, sourceName);
    return [name, parseValue(input, `${path}.inputs.${name}`, sourceName)];
  })));
  const metadata = node.metadata === undefined
    ? Object.freeze({})
    : Object.freeze({ ...objectValue(node.metadata, `${path}.metadata`, sourceName) });
  return Object.freeze({
    id: node.id,
    type: node.type,
    typeVersion: node.typeVersion as number,
    inputs,
    metadata,
  });
}

function parseValue(value: unknown, path: string, sourceName: string): ShaderGraphValueV1 {
  const object = objectValue(value, path, sourceName);
  const discriminants = ['literal', 'node', 'semantic', 'resource'].filter(key => key in object);
  if (discriminants.length !== 1) graphError('E_SHADER_GRAPH_INVALID', 'Graph value must contain exactly one literal/node/semantic/resource discriminator.', path, sourceName);
  const discriminator = discriminants[0]!;
  if (discriminator === 'literal') return parseLiteral(object, path, sourceName);
  if (discriminator === 'node') {
    exactKeys(object, new Set(['node', 'output']), path, sourceName);
    if (typeof object.node !== 'string' || !NODE_ID.test(object.node)) graphError('E_SHADER_GRAPH_INVALID', 'Node reference requires a valid node id.', `${path}.node`, sourceName);
    if (typeof object.output !== 'string' || !object.output) graphError('E_SHADER_GRAPH_INVALID', 'Node reference requires a non-empty output.', `${path}.output`, sourceName);
    return Object.freeze({ kind: 'node' as const, node: object.node, output: object.output });
  }
  if (discriminator === 'semantic') {
    exactKeys(object, new Set(['semantic']), path, sourceName);
    if (typeof object.semantic !== 'string' || !RESOURCE_ID.test(object.semantic)) graphError('E_SHADER_GRAPH_INVALID', 'Semantic reference requires a namespaced id.', `${path}.semantic`, sourceName);
    return Object.freeze({ kind: 'semantic' as const, semantic: object.semantic });
  }
  exactKeys(object, new Set(['resource']), path, sourceName);
  if (typeof object.resource !== 'string' || !RESOURCE_ID.test(object.resource)) graphError('E_SHADER_GRAPH_INVALID', 'Resource reference requires a namespaced id.', `${path}.resource`, sourceName);
  return Object.freeze({ kind: 'resource' as const, resource: object.resource });
}

function parseLiteral(object: Record<string, unknown>, path: string, sourceName: string): ShaderGraphLiteralValueV1 {
  exactKeys(object, new Set(['literal']), path, sourceName);
  const literal = objectValue(object.literal, `${path}.literal`, sourceName);
  exactKeys(literal, new Set(['type', 'value', 'space', 'colorSpace']), `${path}.literal`, sourceName);
  if (typeof literal.type !== 'string' || !literal.type.trim()) graphError('E_SHADER_GRAPH_INVALID', 'Literal type must be a non-empty string.', `${path}.literal.type`, sourceName);
  const rawValue = literal.value;
  let normalized: boolean | number | readonly number[];
  if (typeof rawValue === 'boolean') normalized = rawValue;
  else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) normalized = Object.is(rawValue, -0) ? 0 : rawValue;
  else if (Array.isArray(rawValue) && rawValue.length >= 2 && rawValue.length <= 16 && rawValue.every(item => typeof item === 'number' && Number.isFinite(item))) {
    normalized = Object.freeze(rawValue.map(item => Object.is(item, -0) ? 0 : item as number));
  } else graphError('E_SHADER_GRAPH_INVALID', 'Literal value must be a finite scalar or 2–16 finite numbers.', `${path}.literal.value`, sourceName);
  if (literal.space !== undefined && (typeof literal.space !== 'string' || !literal.space)) graphError('E_SHADER_GRAPH_INVALID', 'Literal space must be a non-empty string.', `${path}.literal.space`, sourceName);
  if (literal.colorSpace !== undefined && !SHADER_COLOR_SPACES.includes(literal.colorSpace as never)) graphError('E_SHADER_GRAPH_INVALID', 'Literal colorSpace is invalid.', `${path}.literal.colorSpace`, sourceName);
  return Object.freeze({
    kind: 'literal' as const,
    type: literal.type,
    value: normalized!,
    ...(literal.space === undefined ? {} : { space: literal.space as string }),
    ...(literal.colorSpace === undefined ? {} : { colorSpace: literal.colorSpace as NonNullable<ShaderGraphLiteralValueV1['colorSpace']> }),
  });
}

function objectValue(value: unknown, path: string, sourceName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) graphError('E_SHADER_GRAPH_INVALID', 'Expected an object.', path, sourceName);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string, sourceName: string): readonly unknown[] {
  if (!Array.isArray(value)) graphError('E_SHADER_GRAPH_INVALID', 'Expected an array.', path, sourceName);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, sourceName: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) graphError('E_SHADER_GRAPH_INVALID', `Unknown property ${key}.`, `${path}.${key}`, sourceName);
  }
}

function validateRootKeys(value: Record<string, unknown>, sourceName: string): void {
  for (const field of SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS) {
    if (!(field in value)) {
      graphError('E_SHADER_GRAPH_INVALID', `Shader Graph v1 requires root property ${field}.`, field, sourceName, {
        field,
        status: 'required-in-v1',
      });
    }
  }
  for (const field of Object.keys(value)) {
    if (ROOT_KEYS.has(field)) continue;
    const unsupported = SHADER_GRAPH_V1_UNSUPPORTED_ROOT_FIELDS[
      field as keyof typeof SHADER_GRAPH_V1_UNSUPPORTED_ROOT_FIELDS
    ];
    if (unsupported !== undefined) {
      graphError('E_SHADER_GRAPH_INVALID', `Shader Graph v1 does not support root property ${field}. ${unsupported.guidance}`, `$.${field}`, sourceName, {
        field,
        status: 'unsupported-in-v1',
        currentOwner: unsupported.currentOwner,
        guidance: unsupported.guidance,
      });
    }
    graphError('E_SHADER_GRAPH_INVALID', `Unknown property ${field}.`, `$.${field}`, sourceName);
  }
}

function expectUnique(values: readonly string[], path: string, sourceName: string): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) graphError('E_SHADER_GRAPH_INVALID', `Duplicate ${path} id ${value}.`, `${path}.${index}`, sourceName);
    seen.add(value);
  }
}

function locateNode(source: string, id: string): ShaderGraphSourceLocation | null {
  const pattern = new RegExp(`\\"id\\"\\s*:\\s*${escapeRegExp(JSON.stringify(id))}`);
  const match = pattern.exec(source);
  if (!match || match.index === undefined) return null;
  const before = source.slice(0, match.index);
  const lines = before.split('\n');
  return Object.freeze({ line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function graphError(
  code: Extract<ShaderDiagnosticCode, 'E_SHADER_GRAPH_INVALID'>,
  message: string,
  path: string,
  sourceName: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  shaderError(code, message, {
    moduleId: '@shader-graph-v1',
    path,
    details: { sourceName, ...details },
  });
}
