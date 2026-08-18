import { shaderError } from '../diagnostics';
import type {
  ShaderGraphNodeV1,
  ShaderGraphResourceV1,
  ShaderGraphValueV1,
} from '../graph/contracts';
import { parseShaderGraphV1 } from '../graph/parser';
import type {
  CompileMotionBlurGraphV1Options,
  CompiledMotionBlurGraphV1,
  MotionBlurPostProcessResourceIds,
} from './contracts';
import { defineMotionBlurPostProcessProgramV1 } from './program';
import { compileMotionBlurPostProcessV1 } from './wgsl';

const NODE_TYPE = 'haiyue.postprocess.motion-blur';
const PORTS = [
  'sourceColor',
  'depth',
  'velocity',
  'tileMax',
  'neighborMax',
  'sampler',
  'parameters',
  'tileParameters',
] as const;

const EXPECTED_RESOURCES = Object.freeze({
  sourceColor: resource('texture-2d', 'texture_2d<f32>', 'linear'),
  depth: resource('texture-2d', 'texture_2d<f32>', 'data'),
  velocity: resource('texture-2d', 'texture_2d<f32>', 'data'),
  tileMax: resource('texture-2d', 'texture_2d<f32>', 'data'),
  neighborMax: resource('texture-2d', 'texture_2d<f32>', 'data'),
  sampler: resource('sampler', 'sampler'),
  parameters: resource('uniform', 'MotionBlurParams'),
  tileParameters: resource('uniform', 'MotionTileMaxParams'),
});

export function compileMotionBlurGraphV1(
  input: string | unknown,
  options: CompileMotionBlurGraphV1Options = {},
): CompiledMotionBlurGraphV1 {
  const graph = parseShaderGraphV1(input, {
    sourceName: options.sourceName ?? 'motion-blur-postprocess.graph.json',
  });
  if (graph.kind !== 'postprocess') {
    graphError('E_SHADER_GRAPH_INVALID', 'Motion blur compiler requires a postprocess graph.', 'kind');
  }
  if (graph.nodes.length !== 1) {
    graphError('E_SHADER_GRAPH_INVALID', 'Motion blur graph requires exactly one aggregate node.', 'nodes');
  }
  const aggregate = graph.nodes[0]!;
  if (aggregate.type !== NODE_TYPE || aggregate.typeVersion !== 1) {
    graphError(
      'E_SHADER_GRAPH_NODE_UNKNOWN',
      `Unsupported postprocess node ${aggregate.type}@${aggregate.typeVersion}.`,
      'nodes.0.type',
    );
  }
  exactPorts(aggregate);
  if (graph.resources.length !== PORTS.length) {
    graphError('E_SHADER_GRAPH_INVALID', 'Motion blur graph has an unexpected resource declaration count.', 'resources');
  }
  const resources = Object.fromEntries(PORTS.map(port => {
    const value = aggregate.inputs[port]!;
    if (value.kind !== 'resource') {
      graphError('E_SHADER_GRAPH_PORT_INVALID', `Motion blur port ${port} requires a resource.`, `nodes.0.inputs.${port}`);
    }
    const declaration = graph.resources.find(resource => resource.id === value.resource);
    if (!declaration) {
      graphError('E_SHADER_GRAPH_REFERENCE_INVALID', `Unknown resource ${value.resource}.`, `nodes.0.inputs.${port}`);
    }
    assertResource(port, declaration!);
    return [port, value.resource];
  })) as Record<(typeof PORTS)[number], string>;
  if (new Set(Object.values(resources)).size !== PORTS.length) {
    graphError('E_SHADER_RESOURCE_CONFLICT', 'Every motion blur resource port requires a distinct declaration.', 'nodes.0.inputs');
  }
  const output = graph.outputs.color;
  if (!output || output.kind !== 'node' || output.node !== aggregate.id || output.output !== 'color') {
    graphError('E_SHADER_GRAPH_REFERENCE_INVALID', 'Postprocess color must reference the motion blur color output.', 'outputs.color');
  }
  if (Object.keys(graph.outputs).length !== 1) {
    graphError('E_SHADER_GRAPH_PORT_INVALID', 'Motion blur graph exposes only the color output.', 'outputs');
  }
  if (graph.sceneFeatures.length !== 0) {
    graphError('E_SHADER_GRAPH_INVALID', 'Motion blur postprocess does not schedule scene features.', 'sceneFeatures');
  }
  const programResources: MotionBlurPostProcessResourceIds = Object.freeze({
    sourceColor: resources.sourceColor,
    velocity: resources.velocity,
    tileMax: resources.tileMax,
    neighborMax: resources.neighborMax,
    sampler: resources.sampler,
    parameters: resources.parameters,
    tileParameters: resources.tileParameters,
  });
  const program = defineMotionBlurPostProcessProgramV1({
    id: options.id ?? 'postprocess.motion-blur',
    resources: programResources,
  });
  return Object.freeze({
    graph,
    program,
    compilation: compileMotionBlurPostProcessV1(program, options.passGroup === undefined
      ? {}
      : { passGroup: options.passGroup }),
    // Stable tile/neighbor reconstruction deliberately does not need depth.
    // Keeping this explicit proves DCE instead of silently sampling it.
    eliminatedResourceIds: Object.freeze([resources.depth]),
  });
}

function exactPorts(node: ShaderGraphNodeV1): void {
  for (const port of PORTS) {
    if (!(port in node.inputs)) {
      graphError('E_SHADER_GRAPH_PORT_INVALID', `Missing motion blur port ${port}.`, `nodes.0.inputs.${port}`);
    }
  }
  for (const port of Object.keys(node.inputs)) {
    if (!(PORTS as readonly string[]).includes(port)) {
      graphError('E_SHADER_GRAPH_PORT_INVALID', `Unknown motion blur port ${port}.`, `nodes.0.inputs.${port}`);
    }
  }
}

function assertResource(port: (typeof PORTS)[number], actual: ShaderGraphResourceV1): void {
  const expected = EXPECTED_RESOURCES[port];
  if (actual.space !== 'pass'
    || actual.frequency !== 'pass'
    || actual.kind !== expected.kind
    || actual.valueType !== expected.valueType
    || (expected.colorSpace !== undefined && actual.colorSpace !== expected.colorSpace)
    || (expected.colorSpace === undefined && actual.colorSpace !== undefined)) {
    graphError(
      'E_SHADER_GRAPH_PORT_INVALID',
      `Resource ${actual.id} does not match motion blur port ${port}.`,
      `resources.${actual.id}`,
    );
  }
}

function resource(
  kind: ShaderGraphResourceV1['kind'],
  valueType: string,
  colorSpace?: ShaderGraphResourceV1['colorSpace'],
): Pick<ShaderGraphResourceV1, 'kind' | 'valueType' | 'colorSpace'> {
  return Object.freeze({
    kind,
    valueType,
    ...(colorSpace === undefined ? {} : { colorSpace }),
  });
}

function graphError(
  code: 'E_SHADER_GRAPH_INVALID'
    | 'E_SHADER_GRAPH_NODE_UNKNOWN'
    | 'E_SHADER_GRAPH_REFERENCE_INVALID'
    | 'E_SHADER_GRAPH_PORT_INVALID'
    | 'E_SHADER_RESOURCE_CONFLICT',
  message: string,
  path: string,
): never {
  shaderError(code, message, { moduleId: '@motion-blur-graph-v1', path });
}
