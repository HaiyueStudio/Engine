import { shaderError } from '../diagnostics';
import type { ShaderIrBuilder, ShaderIrSource, ShaderIrValue } from '../ir/contracts';
import type { ShaderGraphNodeV1, ShaderGraphResourceV1 } from './contracts';

export interface LoweredShaderGraphResource {
  readonly kind: 'resource';
  readonly resource: ShaderGraphResourceV1;
}

export interface LoweredShaderGraphIrValue {
  readonly kind: 'value';
  readonly value: ShaderIrValue;
}

export type LoweredShaderGraphValue = LoweredShaderGraphResource | LoweredShaderGraphIrValue;

export interface ShaderGraphNodeLoweringContext {
  readonly builder: ShaderIrBuilder;
  readonly node: ShaderGraphNodeV1;
  readonly source: ShaderIrSource;
  readonly inputs: Readonly<Record<string, LoweredShaderGraphValue>>;
  memoize(key: string, factory: () => ShaderIrValue): ShaderIrValue;
}

export interface MaterialGraphNodePortV1 {
  readonly id: string;
  readonly direction: 'input' | 'output';
}

export interface MaterialGraphNodeDescriptorV1 {
  readonly id: string;
  readonly version: 1;
  readonly label: string;
  readonly category: 'color' | 'normal' | 'texture' | 'uv';
  readonly ports: readonly MaterialGraphNodePortV1[];
}

interface BuiltinShaderGraphNodeDefinition {
  readonly id: string;
  readonly version: 1;
  readonly label: string;
  readonly category: MaterialGraphNodeDescriptorV1['category'];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  lower(context: ShaderGraphNodeLoweringContext, output: string): ShaderIrValue;
}

const BUILTIN_NODES: readonly BuiltinShaderGraphNodeDefinition[] = Object.freeze([
  Object.freeze({
    id: 'haiyue.uv.noise-distort',
    version: 1 as const,
    label: 'Noise Distort UV',
    category: 'uv' as const,
    inputs: Object.freeze(['position', 'scale', 'strength', 'uv']),
    outputs: Object.freeze(['uv']),
    lower(context: ShaderGraphNodeLoweringContext): ShaderIrValue {
      const builder = context.builder;
      const uv = valueInput(context, 'uv');
      const position = valueInput(context, 'position');
      const scale = valueInput(context, 'scale');
      const strength = valueInput(context, 'strength');
      const phase = builder.multiply(builder.swizzle(position, 'y', context.source), scale, context.source);
      const offset = builder.multiply(builder.sin(phase, context.source), strength, context.source);
      const uvOffset = builder.withSemantic(builder.splat(offset, 2, context.source), uv.type, context.source);
      return builder.add(uv, uvOffset, context.source);
    },
  }),
  Object.freeze({
    id: 'haiyue.texture.sample-2d',
    version: 1 as const,
    label: 'Sample Texture 2D',
    category: 'texture' as const,
    inputs: Object.freeze(['sampler', 'texture', 'uv']),
    outputs: Object.freeze(['alpha', 'color', 'rgbLinear']),
    lower(context: ShaderGraphNodeLoweringContext, output: string): ShaderIrValue {
      const texture = resourceInput(context, 'texture', 'texture-2d');
      const sampler = resourceInput(context, 'sampler', 'sampler');
      const sampled = context.memoize('sample', () =>
        context.builder.textureSample(texture.id, sampler.id, valueInput(context, 'uv'), { source: context.source }));
      if (output === 'color') return sampled;
      if (output === 'alpha') return context.builder.swizzle(sampled, 'a', context.source);
      const linear = texture.colorSpace === 'srgb'
        ? context.builder.srgbToLinear(sampled, context.source)
        : sampled;
      if (linear.type.semantic !== 'color' || linear.type.colorSpace !== 'linear') {
        portError(context, 'rgbLinear requires a sampled color texture declared as srgb or linear.');
      }
      return context.builder.swizzle(linear, 'rgb', context.source);
    },
  }),
  Object.freeze({
    id: 'haiyue.normal.decode-tangent',
    version: 1 as const,
    label: 'Decode Tangent Normal',
    category: 'normal' as const,
    inputs: Object.freeze(['sample', 'scale']),
    outputs: Object.freeze(['normal']),
    lower(context: ShaderGraphNodeLoweringContext): ShaderIrValue {
      const builder = context.builder;
      const sample = valueInput(context, 'sample');
      const scale = valueInput(context, 'scale');
      const two2 = builder.literal('vec2<f32>', [2, 2], context.source);
      const one2 = builder.literal('vec2<f32>', [1, 1], context.source);
      const xy = builder.subtract(builder.multiply(builder.multiply(builder.swizzle(sample, 'xy', context.source), scale, context.source), two2, context.source), one2, context.source);
      const z = builder.subtract(builder.multiply(builder.swizzle(sample, 'z', context.source), builder.literal('f32', 2, context.source), context.source), builder.literal('f32', 1, context.source), context.source);
      const decoded = builder.normalize(builder.construct('vec3<f32>', [xy, z], context.source), context.source);
      return builder.withSemantic(decoded, {
        dataType: 'vec3<f32>', semantic: 'normal', coordinateSpace: 'tangent',
      }, context.source);
    },
  }),
  Object.freeze({
    id: 'haiyue.color.world-height-gradient',
    version: 1 as const,
    label: 'World Height Gradient',
    category: 'color' as const,
    inputs: Object.freeze(['highColor', 'lowColor', 'position', 'range']),
    outputs: Object.freeze(['color']),
    lower(context: ShaderGraphNodeLoweringContext): ShaderIrValue {
      const builder = context.builder;
      const positionY = builder.swizzle(valueInput(context, 'position'), 'y', context.source);
      const range = valueInput(context, 'range');
      const low = builder.swizzle(range, 'x', context.source);
      const high = builder.swizzle(range, 'y', context.source);
      const factor = builder.clamp(
        builder.divide(builder.subtract(positionY, low, context.source), builder.subtract(high, low, context.source), context.source),
        builder.literal('f32', 0, context.source),
        builder.literal('f32', 1, context.source),
        context.source,
      );
      return builder.mix(valueInput(context, 'lowColor'), valueInput(context, 'highColor'), factor, context.source);
    },
  }),
  Object.freeze({
    id: 'haiyue.color.multiply',
    version: 1 as const,
    label: 'Multiply Color',
    category: 'color' as const,
    inputs: Object.freeze(['left', 'right']),
    outputs: Object.freeze(['color']),
    lower(context: ShaderGraphNodeLoweringContext): ShaderIrValue {
      return context.builder.multiply(valueInput(context, 'left'), valueInput(context, 'right'), context.source);
    },
  }),
]);

/** Stable editor-facing catalogue. It deliberately exposes ports, not IR lowering callbacks. */
export function getMaterialGraphNodeCatalogV1(): readonly MaterialGraphNodeDescriptorV1[] {
  return Object.freeze(BUILTIN_NODES.map(node => Object.freeze({
    id: node.id,
    version: node.version,
    label: node.label,
    category: node.category,
    ports: Object.freeze([
      ...node.inputs.map(id => Object.freeze({ id, direction: 'input' as const })),
      ...node.outputs.map(id => Object.freeze({ id, direction: 'output' as const })),
    ]),
  })));
}

export function lowerBuiltinShaderGraphNode(
  context: ShaderGraphNodeLoweringContext,
  output: string,
): ShaderIrValue {
  const definition = BUILTIN_NODES.find(candidate => candidate.id === context.node.type && candidate.version === context.node.typeVersion);
  if (!definition) {
    shaderError('E_SHADER_GRAPH_NODE_UNKNOWN', `Unknown Shader Graph node ${context.node.type}@${context.node.typeVersion}.`, {
      moduleId: '@shader-graph-v1',
      path: context.source.path ?? context.node.id,
      details: { nodeId: context.node.id, nodeType: context.node.type, typeVersion: context.node.typeVersion },
    });
  }
  const actualInputs = Object.keys(context.node.inputs).sort();
  if (actualInputs.join('\0') !== [...definition.inputs].sort().join('\0')) {
    shaderError('E_SHADER_GRAPH_PORT_INVALID', `Node ${context.node.id} inputs do not match ${definition.id}@${definition.version}.`, {
      moduleId: '@shader-graph-v1',
      path: `${context.source.path}.inputs`,
      details: { nodeId: context.node.id, expected: definition.inputs, actual: actualInputs },
    });
  }
  if (!definition.outputs.includes(output)) {
    shaderError('E_SHADER_GRAPH_PORT_INVALID', `Node ${context.node.id} has no output ${output}.`, {
      moduleId: '@shader-graph-v1',
      path: `${context.source.path}.outputs.${output}`,
      details: { nodeId: context.node.id, expected: definition.outputs, actual: output },
    });
  }
  return definition.lower(context, output);
}

export function validateBuiltinShaderGraphNode(node: ShaderGraphNodeV1, path: string): void {
  const definition = BUILTIN_NODES.find(candidate => candidate.id === node.type && candidate.version === node.typeVersion);
  if (!definition) {
    shaderError('E_SHADER_GRAPH_NODE_UNKNOWN', `Unknown Shader Graph node ${node.type}@${node.typeVersion}.`, {
      moduleId: '@shader-graph-v1',
      path,
      details: { nodeId: node.id, nodeType: node.type, typeVersion: node.typeVersion },
    });
  }
  const actualInputs = Object.keys(node.inputs).sort();
  if (actualInputs.join('\0') !== [...definition.inputs].sort().join('\0')) {
    shaderError('E_SHADER_GRAPH_PORT_INVALID', `Node ${node.id} inputs do not match ${definition.id}@${definition.version}.`, {
      moduleId: '@shader-graph-v1',
      path: `${path}.inputs`,
      details: { nodeId: node.id, expected: definition.inputs, actual: actualInputs },
    });
  }
}

function valueInput(context: ShaderGraphNodeLoweringContext, name: string): ShaderIrValue {
  const input = context.inputs[name];
  if (!input || input.kind !== 'value') portError(context, `Input ${name} must be a typed value.`);
  return input.value;
}

function resourceInput(
  context: ShaderGraphNodeLoweringContext,
  name: string,
  kind: ShaderGraphResourceV1['kind'],
): ShaderGraphResourceV1 {
  const input = context.inputs[name];
  if (!input || input.kind !== 'resource' || input.resource.kind !== kind) {
    portError(context, `Input ${name} must reference a ${kind} resource.`);
  }
  return input.resource;
}

function portError(context: ShaderGraphNodeLoweringContext, message: string): never {
  shaderError('E_SHADER_GRAPH_PORT_INVALID', message, {
    moduleId: '@shader-graph-v1',
    path: context.source.path ?? context.node.id,
    details: { nodeId: context.node.id, nodeType: context.node.type },
  });
}
