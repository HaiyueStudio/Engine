import {
  SHADER_RESOURCE_GROUPS,
  SHADER_STAGES,
  type ShaderModule,
  type ShaderResourceDefinition,
  type ShaderResourceReflection,
  type ShaderResourceSpace,
  type ShaderStage,
  type ShaderUniformBlockReflection,
} from './contracts';
import { shaderError } from './diagnostics';
import { compareStableText, resourceVariableName, uniformStructName } from './naming';
import { createUniformBlockLayout } from './uniformLayout';

export interface AllocatedShaderResource {
  readonly definition: ShaderResourceDefinition;
  readonly group: number;
  readonly binding: number;
  readonly variableName: string;
  readonly valueType: string;
  readonly visibility: readonly ShaderStage[];
  readonly moduleIds: readonly string[];
  readonly uniformBlock: ShaderUniformBlockReflection | null;
}

export interface AllocatedShaderResources {
  readonly resources: readonly AllocatedShaderResource[];
  readonly reflection: readonly ShaderResourceReflection[];
  readonly uniformBlocks: readonly ShaderUniformBlockReflection[];
  readonly source: string;
}

const RESOURCE_KIND_ORDER = [
  'uniform-buffer',
  'storage-buffer-read',
  'storage-buffer-read-write',
  'texture',
  'storage-texture',
  'sampler',
] as const;

export function allocateShaderResources(
  modules: readonly ShaderModule[],
  limits: number | Partial<Record<ShaderResourceSpace, number>> = 64,
): AllocatedShaderResources {
  const collected = new Map<string, {
    definition: ShaderResourceDefinition;
    visibility: Set<ShaderStage>;
    moduleIds: Set<string>;
  }>();

  for (const module of modules) {
    for (const resource of module.resources) {
      const existing = collected.get(resource.id);
      if (!existing) {
        collected.set(resource.id, {
          definition: resource,
          visibility: new Set(resource.visibility),
          moduleIds: new Set([module.id]),
        });
        continue;
      }
      if (resourceSignature(existing.definition) !== resourceSignature(resource)) {
        shaderError('E_SHADER_RESOURCE_CONFLICT', `Resource ${resource.id} has incompatible declarations in ${[...existing.moduleIds, module.id].join(', ')}.`, {
          moduleId: module.id,
          path: `resources.${resource.id}`,
          details: { owners: [...existing.moduleIds, module.id] },
        });
      }
      for (const stage of resource.visibility) existing.visibility.add(stage);
      existing.moduleIds.add(module.id);
    }
  }

  const ordered = [...collected.values()].sort((left, right) => {
    const groupDifference = SHADER_RESOURCE_GROUPS[left.definition.space] - SHADER_RESOURCE_GROUPS[right.definition.space];
    if (groupDifference !== 0) return groupDifference;
    const kindDifference = RESOURCE_KIND_ORDER.indexOf(left.definition.kind) - RESOURCE_KIND_ORDER.indexOf(right.definition.kind);
    return kindDifference || compareStableText(left.definition.id, right.definition.id);
  });
  const occupied = new Map<number, Map<number, string>>();
  for (const item of ordered) {
    if (item.definition.fixedBinding === undefined) continue;
    reserveBinding(occupied, item.definition, item.definition.fixedBinding, limits);
  }

  const allocated: AllocatedShaderResource[] = [];
  for (const item of ordered) {
    const definition = item.definition;
    const group = SHADER_RESOURCE_GROUPS[definition.space];
    const binding = definition.fixedBinding ?? allocateBinding(occupied, definition, limits);
    const uniformBlock = definition.fields
      ? createUniformBlockLayout(definition.id, definition.fields)
      : null;
    const valueType = uniformBlock ? uniformStructName(definition.id) : requireValueType(definition);
    allocated.push(Object.freeze({
      definition,
      group,
      binding,
      variableName: resourceVariableName(definition.id),
      valueType,
      visibility: Object.freeze(SHADER_STAGES.filter(stage => item.visibility.has(stage))),
      moduleIds: Object.freeze([...item.moduleIds].sort()),
      uniformBlock,
    }));
  }

  const reflection = allocated.map(resource => Object.freeze({
    id: resource.definition.id,
    space: resource.definition.space,
    group: resource.group,
    binding: resource.binding,
    kind: resource.definition.kind,
    visibility: resource.visibility,
  }));
  const uniformBlocks = allocated.flatMap(resource => resource.uniformBlock ? [resource.uniformBlock] : []);
  return Object.freeze({
    resources: Object.freeze(allocated),
    reflection: Object.freeze(reflection),
    uniformBlocks: Object.freeze(uniformBlocks),
    source: allocated.map(resourceDeclaration).join('\n\n'),
  });
}

function reserveBinding(
  occupied: Map<number, Map<number, string>>,
  resource: ShaderResourceDefinition,
  binding: number,
  limits: number | Partial<Record<ShaderResourceSpace, number>>,
): void {
  const group = SHADER_RESOURCE_GROUPS[resource.space];
  const limit = bindingLimit(limits, resource.space);
  if (binding >= limit) {
    shaderError('E_SHADER_RESOURCE_LIMIT', `Resource ${resource.id} binding ${binding} exceeds ${resource.space} limit ${limit}.`, {
      path: `resources.${resource.id}.fixedBinding`,
      details: { group, binding, limit },
    });
  }
  let groupBindings = occupied.get(group);
  if (!groupBindings) {
    groupBindings = new Map();
    occupied.set(group, groupBindings);
  }
  const owner = groupBindings.get(binding);
  if (owner && owner !== resource.id) {
    shaderError('E_SHADER_BINDING_CONFLICT', `Resources ${owner} and ${resource.id} both reserve @group(${group}) @binding(${binding}).`, {
      path: `resources.${resource.id}.fixedBinding`,
      details: { group, binding, owner, contender: resource.id },
    });
  }
  groupBindings.set(binding, resource.id);
}

function allocateBinding(
  occupied: Map<number, Map<number, string>>,
  resource: ShaderResourceDefinition,
  limits: number | Partial<Record<ShaderResourceSpace, number>>,
): number {
  const group = SHADER_RESOURCE_GROUPS[resource.space];
  const limit = bindingLimit(limits, resource.space);
  const groupBindings = occupied.get(group) ?? new Map<number, string>();
  occupied.set(group, groupBindings);
  for (let binding = 0; binding < limit; binding++) {
    if (groupBindings.has(binding)) continue;
    groupBindings.set(binding, resource.id);
    return binding;
  }
  shaderError('E_SHADER_RESOURCE_LIMIT', `Resource space ${resource.space} exceeds its ${limit}-binding limit while allocating ${resource.id}.`, {
    path: `resources.${resource.id}`,
    details: { group, limit, allocated: [...groupBindings.values()] },
  });
}

function bindingLimit(
  limits: number | Partial<Record<ShaderResourceSpace, number>>,
  space: ShaderResourceSpace,
): number {
  const value = typeof limits === 'number' ? limits : limits[space] ?? 64;
  if (!Number.isInteger(value) || value < 1) {
    shaderError('E_SHADER_RESOURCE_LIMIT', `Invalid binding limit ${value} for ${space}.`, {
      path: `maxBindingsPerGroup.${space}`,
    });
  }
  return value;
}

function resourceDeclaration(resource: AllocatedShaderResource): string {
  const header = `@group(${resource.group}) @binding(${resource.binding})`;
  const variable = resource.variableName;
  const type = resource.valueType;
  let declaration: string;
  switch (resource.definition.kind) {
    case 'uniform-buffer':
      declaration = `${header} var<uniform> ${variable} : ${type};`;
      break;
    case 'storage-buffer-read':
      declaration = `${header} var<storage, read> ${variable} : ${type};`;
      break;
    case 'storage-buffer-read-write':
      declaration = `${header} var<storage, read_write> ${variable} : ${type};`;
      break;
    default:
      declaration = `${header} var ${variable} : ${type};`;
      break;
  }
  if (!resource.uniformBlock) return declaration;
  const fields = resource.uniformBlock.fields.map((field, index) =>
    `  ${index === 0 ? '@align(16) ' : ''}${field.name} : ${field.type},`).join('\n');
  return `struct ${type} {\n${fields}\n}\n${declaration}`;
}

function resourceSignature(resource: ShaderResourceDefinition): string {
  return JSON.stringify({
    space: resource.space,
    kind: resource.kind,
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
  });
}

function requireValueType(resource: ShaderResourceDefinition): string {
  if (resource.valueType !== undefined) return resource.valueType;
  shaderError('E_SHADER_MODULE_INVALID', `Resource ${resource.id} is missing valueType.`, {
    path: `resources.${resource.id}.valueType`,
  });
}
