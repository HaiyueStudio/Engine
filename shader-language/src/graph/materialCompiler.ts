import type {
  ComposedShaderModules,
  ShaderResourceDefinition,
  ShaderUniformFieldDefinition,
  ShaderVaryingReflection,
} from '../contracts';
import { composeShaderModules } from '../composer';
import { shaderError } from '../diagnostics';
import type { ShaderIrBuilder, ShaderIrEntryInputDefinition, ShaderIrSource, ShaderIrValue } from '../ir/contracts';
import { shaderValueType, type ShaderIrValueTypeDefinition } from '../ir/types';
import {
  METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT,
  assertMetallicRoughnessPbrV1SurfaceOutputsSupported,
  lowerMetallicRoughnessPbr,
} from '../material/pbr';
import {
  MATERIAL_SURFACE_V1_SLOTS,
  lowerMaterialSurfaceV1,
  type MaterialSurfaceV1Slot,
} from '../material/surface';
import { defineTypedShaderModule, type TypedShaderModule } from '../typedModule';
import type {
  ParseShaderGraphV1Options,
  ShaderGraphNodeV1,
  ShaderGraphResourceV1,
  ShaderGraphV1,
  ShaderGraphValueV1,
} from './contracts';
import {
  lowerBuiltinShaderGraphNode,
  validateBuiltinShaderGraphNode,
  type LoweredShaderGraphValue,
} from './nodeRegistry';
import { parseShaderGraphV1 } from './parser';
import { shaderGraphValueType } from './valueTypes';

const MATERIAL_PARAMETERS = 'material.parameters';
const FRAME_SCENE = 'frame.scene';

export const PBR_PILOT_VARIANT_POLICY = Object.freeze({
  specializationAxes: Object.freeze([] as readonly string[]),
  reservedSpecializationAxes: Object.freeze(['clearcoat', 'transmission']),
  reachableSpecializationVariants: 1,
  maximumSpecializationVariants: 4,
  reachablePilotFamilyVariants: 1,
  maximumPilotFamilyVariants: 8,
  dynamicFeatures: Object.freeze(['normal-map', 'uv-noise', 'height-gradient', 'scene.fog']),
  unsupportedSurfaceSlots: METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT.unsupportedSlots,
});

export interface CompileMaterialGraphV1Options extends ParseShaderGraphV1Options {
  readonly id?: string;
  readonly label?: string;
}

export interface CompiledMaterialGraphV1 {
  readonly graph: ShaderGraphV1;
  readonly typed: TypedShaderModule;
  readonly composition: ComposedShaderModules;
  readonly canonicalHash: string;
  readonly vertexSemantics: readonly string[];
  readonly varyings: readonly ShaderVaryingReflection[];
  readonly materialUniformResourceId: string | null;
  readonly variantPolicy: typeof PBR_PILOT_VARIANT_POLICY;
}

interface SemanticDefinition {
  readonly id: string;
  readonly inputId: string;
  readonly location: number;
  readonly vertexSemantic: string;
  readonly type: ShaderIrValueTypeDefinition;
}

const SEMANTICS: readonly SemanticDefinition[] = Object.freeze([
  Object.freeze({ id: 'geometry.uv0', inputId: 'uv0', location: 0, vertexSemantic: 'TEXCOORD_0', type: Object.freeze({ dataType: 'vec2<f32>', semantic: 'uv', coordinateSpace: 'geometry-local' }) }),
  Object.freeze({ id: 'geometry.position.world', inputId: 'worldPosition', location: 1, vertexSemantic: 'POSITION_WORLD', type: Object.freeze({ dataType: 'vec3<f32>', semantic: 'position', coordinateSpace: 'world' }) }),
  Object.freeze({ id: 'geometry.normal.world', inputId: 'worldNormal', location: 2, vertexSemantic: 'NORMAL_WORLD', type: Object.freeze({ dataType: 'vec3<f32>', semantic: 'normal', coordinateSpace: 'world' }) }),
  Object.freeze({ id: 'geometry.tangent.world', inputId: 'worldTangent', location: 3, vertexSemantic: 'TANGENT_WORLD', type: Object.freeze({ dataType: 'vec3<f32>', semantic: 'direction', coordinateSpace: 'world' }) }),
  Object.freeze({ id: 'geometry.tangent.sign', inputId: 'tangentSign', location: 4, vertexSemantic: 'TANGENT_SIGN', type: 'f32' }),
]);

export function compileMaterialGraphV1(
  input: string | unknown,
  options: CompileMaterialGraphV1Options = {},
): CompiledMaterialGraphV1 {
  const graph = parseShaderGraphV1(input, options);
  if (graph.kind !== 'material') graphInvalid(`Graph kind ${graph.kind} cannot be lowered as MaterialSurface.`, 'kind');
  for (const [index, node] of graph.nodes.entries()) validateBuiltinShaderGraphNode(node, `nodes.${index}`);
  for (const [index, resource] of graph.resources.entries()) {
    if (resource.frequency !== 'material') graphInvalid(`Stage 3 material graphs require material-frequency resources, got ${resource.frequency}.`, `resources.${index}.frequency`);
  }
  for (const feature of graph.sceneFeatures) {
    if (feature !== 'scene.fog') graphInvalid(`Unsupported stage 3 scene feature ${feature}.`, `sceneFeatures.${graph.sceneFeatures.indexOf(feature)}`);
  }
  for (const output of Object.keys(graph.outputs)) {
    if (!(MATERIAL_SURFACE_V1_SLOTS as readonly string[]).includes(output)) {
      shaderError('E_SHADER_SURFACE_INVALID', `Unknown MaterialSurface v1 output ${output}.`, {
        moduleId: '@material-surface-v1', path: `outputs.${output}`,
      });
    }
  }
  assertMetallicRoughnessPbrV1SurfaceOutputsSupported(
    Object.keys(graph.outputs) as MaterialSurfaceV1Slot[],
  );

  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const resourceById = new Map(graph.resources.map(resource => [resource.id, resource]));
  validateReferences(graph, nodeById, resourceById);
  const requiredSemanticIds = collectRequiredSemantics(graph, nodeById);
  requiredSemanticIds.add('geometry.position.world');
  requiredSemanticIds.add('geometry.normal.world');
  if (graph.outputs.normalTS !== undefined) {
    requiredSemanticIds.add('geometry.tangent.world');
    requiredSemanticIds.add('geometry.tangent.sign');
  }
  const semanticDefinitions = SEMANTICS.filter(semantic => requiredSemanticIds.has(semantic.id));
  for (const semantic of requiredSemanticIds) {
    if (!SEMANTICS.some(candidate => candidate.id === semantic)) referenceError(`Unsupported geometry semantic ${semantic}.`, `semantics.${semantic}`);
  }

  const uniformFields = createMaterialUniformFields(graph.resources);
  const resources = createCompilerResources(graph.resources, uniformFields);
  const uniformFieldByResource = new Map(graph.resources
    .filter(resource => resource.kind === 'uniform')
    .map(resource => [resource.id, uniformFieldName(resource.id)]));
  const id = options.id ?? 'graph.pbr-composition';
  const entryInputs: readonly ShaderIrEntryInputDefinition[] = Object.freeze(semanticDefinitions.map(semantic => Object.freeze({
    id: semantic.inputId,
    type: semantic.type,
    location: semantic.location,
    source: Object.freeze({ sourceId: semantic.id, sourceName: graph.sourceName }),
  })));
  const typed = defineTypedShaderModule({
    id,
    sourceName: graph.sourceName,
    resources,
    profiles: [graph.profile],
    provides: ['material.surface.v1'],
    entries: [{
      id: 'fragmentMain',
      stage: 'fragment',
      name: 'fragmentMain',
      inputs: entryInputs,
      output: {
        type: { dataType: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' },
        location: 0,
        source: { sourceId: 'graph.output.color', sourceName: graph.sourceName },
      },
      source: { sourceId: 'graph.root', sourceName: graph.sourceName },
      build: (builder, entryValues) => lowerGraphFragment(
        graph,
        builder,
        entryValues,
        semanticDefinitions,
        nodeById,
        resourceById,
        uniformFieldByResource,
      ),
    }],
  });
  const vertexSemantics = Object.freeze(semanticDefinitions.map(semantic => semantic.vertexSemantic));
  const varyings = Object.freeze(semanticDefinitions.map(semantic => Object.freeze({
    semantic: semantic.vertexSemantic,
    location: semantic.location,
    type: shaderValueType(semantic.type).dataType,
    interpolation: 'perspective' as const,
  })));
  const composition = composeShaderModules({
    label: options.label ?? id,
    entry: typed.module,
    profile: graph.profile,
    vertexSemantics,
    varyings,
  });
  return Object.freeze({
    graph,
    typed,
    composition,
    canonicalHash: typed.ir.canonicalHash,
    vertexSemantics,
    varyings,
    materialUniformResourceId: uniformFields.length === 0 ? null : MATERIAL_PARAMETERS,
    variantPolicy: PBR_PILOT_VARIANT_POLICY,
  });
}

function lowerGraphFragment(
  graph: ShaderGraphV1,
  builder: ShaderIrBuilder,
  entryValues: Readonly<Record<string, ShaderIrValue>>,
  semanticDefinitions: readonly SemanticDefinition[],
  nodeById: ReadonlyMap<string, ShaderGraphNodeV1>,
  resourceById: ReadonlyMap<string, ShaderGraphResourceV1>,
  uniformFieldByResource: ReadonlyMap<string, string>,
): ShaderIrValue {
  const semanticValues = new Map(semanticDefinitions.map(semantic => [semantic.id, entryValues[semantic.inputId]!]));
  const nodeCache = new Map<string, ShaderIrValue>();
  const nodeSharedCache = new Map<string, ShaderIrValue>();
  const active = new Set<string>();
  const resolve = (value: ShaderGraphValueV1, path: string): LoweredShaderGraphValue => {
    const source: ShaderIrSource = Object.freeze({ sourceId: `graph.${path}`, sourceName: graph.sourceName, path });
    if (value.kind === 'literal') {
      return Object.freeze({ kind: 'value' as const, value: builder.literal(shaderGraphValueType(value.type, {
        path: `${path}.literal.type`,
        ...(value.space === undefined ? {} : { space: value.space }),
        ...(value.colorSpace === undefined ? {} : { colorSpace: value.colorSpace }),
      }), value.value, source) });
    }
    if (value.kind === 'semantic') {
      const semantic = semanticValues.get(value.semantic);
      if (!semantic) referenceError(`Semantic ${value.semantic} is not available to this material.`, path);
      return Object.freeze({ kind: 'value' as const, value: semantic });
    }
    if (value.kind === 'resource') {
      const resource = resourceById.get(value.resource);
      if (!resource) referenceError(`Unknown graph resource ${value.resource}.`, path);
      if (resource.kind === 'uniform') {
        return Object.freeze({
          kind: 'value' as const,
          value: builder.uniformField(MATERIAL_PARAMETERS, uniformFieldByResource.get(resource.id)!, source),
        });
      }
      return Object.freeze({ kind: 'resource' as const, resource });
    }
    const cacheKey = `${value.node}\0${value.output}`;
    const cached = nodeCache.get(cacheKey);
    if (cached) return Object.freeze({ kind: 'value' as const, value: cached });
    if (active.has(value.node)) referenceError(`Shader Graph contains a cycle through node ${value.node}.`, path);
    const node = nodeById.get(value.node);
    if (!node) referenceError(`Unknown graph node ${value.node}.`, path);
    active.add(value.node);
    const nodeIndex = graph.nodes.indexOf(node);
    const location = graph.nodeLocations[node.id];
    const nodeSource: ShaderIrSource = Object.freeze({
      sourceId: `graph.${node.id}`,
      sourceName: graph.sourceName,
      path: `nodes.${nodeIndex}`,
      ...(location === undefined ? {} : { line: location.line, column: location.column }),
    });
    const inputs = Object.freeze(Object.fromEntries(Object.entries(node.inputs).map(([name, input]) => [
      name,
      resolve(input, `nodes.${nodeIndex}.inputs.${name}`),
    ])));
    const lowered = lowerBuiltinShaderGraphNode({
      builder,
      node,
      source: nodeSource,
      inputs,
      memoize: (key, factory) => {
        const sharedKey = `${node.id}\0${key}`;
        const shared = nodeSharedCache.get(sharedKey);
        if (shared) return shared;
        const created = factory();
        nodeSharedCache.set(sharedKey, created);
        return created;
      },
    }, value.output);
    active.delete(value.node);
    nodeCache.set(cacheKey, lowered);
    return Object.freeze({ kind: 'value' as const, value: lowered });
  };

  const authored = {} as Partial<Record<MaterialSurfaceV1Slot, ShaderIrValue>>;
  for (const slot of MATERIAL_SURFACE_V1_SLOTS) {
    const value = graph.outputs[slot];
    if (!value) continue;
    const lowered = resolve(value, `outputs.${slot}`);
    if (lowered.kind !== 'value') referenceError(`MaterialSurface.${slot} must resolve to a typed value.`, `outputs.${slot}`);
    authored[slot] = lowered.value;
  }
  const surface = lowerMaterialSurfaceV1(builder, authored, slot => Object.freeze({
    sourceId: `graph.output.${slot}`, sourceName: graph.sourceName, path: `outputs.${slot}`,
  }));
  const frame = (field: string): ShaderIrValue => builder.uniformField(FRAME_SCENE, field, {
    sourceId: `scene.${field}`, sourceName: 'scene-feature-abi', path: `scene.${field}`,
  });
  return lowerMetallicRoughnessPbr(builder, surface, {
    worldPosition: semanticValues.get('geometry.position.world')!,
    worldNormal: semanticValues.get('geometry.normal.world')!,
    ...(semanticValues.has('geometry.tangent.world') ? { worldTangent: semanticValues.get('geometry.tangent.world')! } : {}),
    ...(semanticValues.has('geometry.tangent.sign') ? { tangentSign: semanticValues.get('geometry.tangent.sign')! } : {}),
  }, {
    cameraPosition: frame('cameraPosition'),
    lightDirection: frame('lightDirection'),
    lightColor: frame('lightColor'),
    ambientColor: frame('ambientColor'),
    fogColor: frame('fogColor'),
    fogStart: frame('fogStart'),
    fogEnd: frame('fogEnd'),
  }, graph.sceneFeatures.includes('scene.fog'));
}

function createMaterialUniformFields(resources: readonly ShaderGraphResourceV1[]): readonly ShaderUniformFieldDefinition[] {
  const fields = resources.filter(resource => resource.kind === 'uniform').sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(resource => {
    const type = shaderValueType(shaderGraphValueType(resource.valueType, { path: `resources.${resource.id}.valueType` }));
    return Object.freeze({
      id: uniformFieldName(resource.id),
      type: type.dataType,
      ...(type.semantic === 'value' ? {} : { semantic: type.semantic }),
      ...(type.coordinateSpace === undefined ? {} : { coordinateSpace: type.coordinateSpace }),
      ...(type.colorSpace === undefined ? {} : { colorSpace: type.colorSpace }),
    });
  });
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.id)) graphInvalid(`Uniform field name collision at ${field.id}.`, 'resources');
    names.add(field.id);
  }
  return Object.freeze(fields);
}

function createCompilerResources(
  graphResources: readonly ShaderGraphResourceV1[],
  materialFields: readonly ShaderUniformFieldDefinition[],
): readonly ShaderResourceDefinition[] {
  const resources: ShaderResourceDefinition[] = [{
    id: FRAME_SCENE,
    space: 'frame',
    kind: 'uniform-buffer',
    visibility: ['fragment'],
    fields: [
      { id: 'cameraPosition', type: 'vec3<f32>', semantic: 'position', coordinateSpace: 'world' },
      { id: 'lightDirection', type: 'vec3<f32>', semantic: 'direction', coordinateSpace: 'world' },
      { id: 'lightColor', type: 'vec3<f32>', semantic: 'color', colorSpace: 'linear' },
      { id: 'ambientColor', type: 'vec3<f32>', semantic: 'color', colorSpace: 'linear' },
      { id: 'fogColor', type: 'vec3<f32>', semantic: 'color', colorSpace: 'linear' },
      { id: 'fogStart', type: 'f32' },
      { id: 'fogEnd', type: 'f32' },
    ],
  }];
  if (materialFields.length > 0) resources.push({
    id: MATERIAL_PARAMETERS,
    space: 'material',
    kind: 'uniform-buffer',
    visibility: ['fragment'],
    fields: materialFields,
  });
  for (const resource of graphResources) {
    if (resource.kind === 'uniform') continue;
    if (resource.kind === 'texture-2d') resources.push({
      id: resource.id, space: 'material', kind: 'texture', visibility: ['fragment'], valueType: 'texture_2d<f32>', colorSpace: resource.colorSpace ?? 'data',
    });
    else if (resource.kind === 'sampler') resources.push({
      id: resource.id, space: 'material', kind: 'sampler', visibility: ['fragment'], valueType: 'sampler',
    });
    else graphInvalid(`Stage 3 material compiler does not support ${resource.kind} resource ${resource.id}.`, `resources.${graphResources.indexOf(resource)}.kind`);
  }
  return Object.freeze(resources.map(resource => Object.freeze(resource)));
}

function collectRequiredSemantics(graph: ShaderGraphV1, nodes: ReadonlyMap<string, ShaderGraphNodeV1>): Set<string> {
  const semantics = new Set<string>();
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (value: ShaderGraphValueV1, path: string): void => {
    if (value.kind === 'semantic') { semantics.add(value.semantic); return; }
    if (value.kind !== 'node') return;
    if (active.has(value.node)) referenceError(`Shader Graph contains a cycle through node ${value.node}.`, path);
    if (visited.has(value.node)) return;
    const node = nodes.get(value.node);
    if (!node) referenceError(`Unknown graph node ${value.node}.`, path);
    active.add(value.node);
    for (const [name, input] of Object.entries(node.inputs)) visit(input, `${path}.${value.node}.${name}`);
    active.delete(value.node);
    visited.add(value.node);
  };
  for (const [slot, output] of Object.entries(graph.outputs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) visit(output, `outputs.${slot}`);
  return semantics;
}

function validateReferences(
  graph: ShaderGraphV1,
  nodes: ReadonlyMap<string, ShaderGraphNodeV1>,
  resources: ReadonlyMap<string, ShaderGraphResourceV1>,
): void {
  const validate = (value: ShaderGraphValueV1, path: string): void => {
    if (value.kind === 'node' && !nodes.has(value.node)) referenceError(`Unknown graph node ${value.node}.`, path);
    if (value.kind === 'resource' && !resources.has(value.resource)) referenceError(`Unknown graph resource ${value.resource}.`, path);
  };
  for (const [nodeIndex, node] of graph.nodes.entries()) for (const [name, input] of Object.entries(node.inputs)) validate(input, `nodes.${nodeIndex}.inputs.${name}`);
  for (const [slot, output] of Object.entries(graph.outputs)) validate(output, `outputs.${slot}`);
}

function uniformFieldName(resourceId: string): string {
  return resourceId.slice(resourceId.indexOf('.') + 1).replace(/[^A-Za-z0-9_]/g, '_');
}

function referenceError(message: string, path: string): never {
  shaderError('E_SHADER_GRAPH_REFERENCE_INVALID', message, { moduleId: '@shader-graph-v1', path });
}

function graphInvalid(message: string, path: string): never {
  shaderError('E_SHADER_GRAPH_INVALID', message, { moduleId: '@shader-graph-v1', path });
}
