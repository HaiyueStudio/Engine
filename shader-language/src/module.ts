import {
  SHADER_CAPABILITY_PROFILES,
  SHADER_STAGES,
  SHADER_TARGETS,
  type ShaderCapabilityProfile,
  type ShaderModule,
  type ShaderModuleDefinition,
  type ShaderResourceDefinition,
  type ShaderSpecializationDefinition,
  type ShaderStage,
  type ShaderSymbolDefinition,
  type ShaderSymbolImport,
  type ShaderTarget,
} from './contracts';
import { shaderError } from './diagnostics';
import { isWgslIdentifier } from './naming';

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const RESOURCE_ID = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export function defineShaderModule(definition: ShaderModuleDefinition): ShaderModule {
  if (!MODULE_ID.test(definition.id)) invalid(definition.id, 'id', `Invalid shader module id ${definition.id}.`);
  const version = definition.version ?? 1;
  if (!Number.isInteger(version) || version < 1) invalid(definition.id, 'version', 'Module version must be a positive integer.');
  if (typeof definition.source !== 'function') invalid(definition.id, 'source', 'Module source must be a source factory.');
  const sourceName = definition.sourceName ?? `${definition.id}.wgsl`;
  if (!sourceName.trim() || /[\r\n]/.test(sourceName)) invalid(definition.id, 'sourceName', 'Module sourceName must be a non-empty single line.');

  const stages = normalizeStages(definition.stages, definition.id, 'stages');
  const symbols = Object.freeze((definition.symbols ?? []).map((symbol, index) => normalizeSymbol(symbol, stages, definition.id, index)));
  expectUnique(symbols.map(symbol => symbol.id), definition.id, 'symbols');

  const imports: readonly ShaderSymbolImport[] = Object.freeze((definition.imports ?? []).map((item, index) => {
    if (!MODULE_ID.test(item.from) || item.from === definition.id) {
      invalid(definition.id, `imports.${index}.from`, `Invalid imported module id ${item.from}.`);
    }
    if (!isWgslIdentifier(item.symbol)) invalid(definition.id, `imports.${index}.symbol`, `Invalid imported symbol ${item.symbol}.`);
    return Object.freeze({
      from: item.from,
      symbol: item.symbol,
      stages: normalizeStages(item.stages ?? stages, definition.id, `imports.${index}.stages`, stages),
    });
  }));
  expectUnique(imports.map(item => `${item.from}:${item.symbol}`), definition.id, 'imports');

  const resources = Object.freeze((definition.resources ?? []).map((resource, index) =>
    normalizeResource(resource, stages, definition.id, index)));
  expectUnique(resources.map(resource => resource.id), definition.id, 'resources');

  const specializations = Object.freeze((definition.specializations ?? []).map((specialization, index) =>
    normalizeSpecialization(specialization, definition.id, index)));
  expectUnique(specializations.map(specialization => specialization.id), definition.id, 'specializations');

  const entryPoints = Object.freeze((definition.entryPoints ?? []).map((entryPoint, index) => {
    if (!isWgslIdentifier(entryPoint.id)) invalid(definition.id, `entryPoints.${index}.id`, `Invalid entry point id ${entryPoint.id}.`);
    if (!isWgslIdentifier(entryPoint.name) || entryPoint.name.startsWith('hy_')) {
      invalid(definition.id, `entryPoints.${index}.name`, `Invalid or reserved entry point name ${entryPoint.name}.`);
    }
    if (!stages.includes(entryPoint.stage)) {
      invalid(definition.id, `entryPoints.${index}.stage`, `Entry point ${entryPoint.id} uses undeclared stage ${entryPoint.stage}.`);
    }
    return Object.freeze({ ...entryPoint });
  }));
  expectUnique(entryPoints.map(entryPoint => entryPoint.id), definition.id, 'entry point ids');
  expectUnique(entryPoints.map(entryPoint => entryPoint.name), definition.id, 'entry point names');

  const targets = normalizeEnumSet(definition.targets ?? ['webgpu-wgsl'], SHADER_TARGETS, definition.id, 'targets');
  const profiles = normalizeEnumSet(definition.profiles ?? ['webgpu-portable', 'webgpu-enhanced'], SHADER_CAPABILITY_PROFILES, definition.id, 'profiles');
  const requires = normalizeCapabilitySet(definition.requires ?? [], definition.id, 'requires');
  const provides = normalizeCapabilitySet(definition.provides ?? [], definition.id, 'provides');
  const conflicts = normalizeCapabilitySet(definition.conflicts ?? [], definition.id, 'conflicts');
  const passRequirements = normalizeCapabilitySet(definition.passRequirements ?? [], definition.id, 'passRequirements');

  return Object.freeze({
    id: definition.id,
    version,
    sourceName,
    stages,
    dependencies: Object.freeze([...(definition.dependencies ?? [])]),
    symbols,
    imports,
    resources,
    specializations,
    requires,
    provides,
    conflicts,
    targets: targets as readonly ShaderTarget[],
    profiles: profiles as readonly ShaderCapabilityProfile[],
    passRequirements,
    entryPoints,
    source: definition.source,
  });
}

function normalizeSymbol(
  symbol: ShaderSymbolDefinition,
  moduleStages: readonly ShaderStage[],
  moduleId: string,
  index: number,
): ShaderSymbolDefinition {
  if (!isWgslIdentifier(symbol.id)) invalid(moduleId, `symbols.${index}.id`, `Invalid shader symbol id ${symbol.id}.`);
  if (!['function', 'struct', 'constant', 'alias'].includes(symbol.kind)) {
    invalid(moduleId, `symbols.${index}.kind`, `Invalid shader symbol kind ${symbol.kind}.`);
  }
  if (symbol.visibility !== 'export' && symbol.visibility !== 'private') {
    invalid(moduleId, `symbols.${index}.visibility`, `Invalid shader symbol visibility ${symbol.visibility}.`);
  }
  return Object.freeze({
    id: symbol.id,
    kind: symbol.kind,
    visibility: symbol.visibility,
    stages: normalizeStages(symbol.stages, moduleId, `symbols.${index}.stages`, moduleStages),
  });
}

function normalizeResource(
  resource: ShaderResourceDefinition,
  moduleStages: readonly ShaderStage[],
  moduleId: string,
  index: number,
): ShaderResourceDefinition {
  const path = `resources.${index}`;
  if (!RESOURCE_ID.test(resource.id)) invalid(moduleId, `${path}.id`, `Invalid shader resource id ${resource.id}.`);
  if (!['frame', 'object', 'material', 'pass'].includes(resource.space)) {
    invalid(moduleId, `${path}.space`, `Invalid resource space ${resource.space}.`);
  }
  if (!['uniform-buffer', 'storage-buffer-read', 'storage-buffer-read-write', 'texture', 'storage-texture', 'sampler'].includes(resource.kind)) {
    invalid(moduleId, `${path}.kind`, `Invalid resource kind ${resource.kind}.`);
  }
  const visibility = normalizeStages(resource.visibility, moduleId, `${path}.visibility`, moduleStages);
  if (resource.fixedBinding !== undefined && (!Number.isInteger(resource.fixedBinding) || resource.fixedBinding < 0)) {
    invalid(moduleId, `${path}.fixedBinding`, `Resource ${resource.id} has invalid fixed binding.`);
  }

  const fields = resource.fields?.map((field, fieldIndex) => {
    if (!isWgslIdentifier(field.id)) invalid(moduleId, `${path}.fields.${fieldIndex}.id`, `Invalid uniform field ${field.id}.`);
    assertWgslType(field.type, moduleId, `${path}.fields.${fieldIndex}.type`);
    return Object.freeze({ ...field });
  });
  if (fields) expectUnique(fields.map(field => field.id), moduleId, `${path}.fields`);

  if (resource.kind === 'uniform-buffer') {
    if (fields && fields.length > 0 && resource.valueType !== undefined) {
      invalid(moduleId, path, `Generated uniform block ${resource.id} cannot also declare valueType.`);
    }
    if ((!fields || fields.length === 0) && resource.valueType === undefined) {
      invalid(moduleId, path, `Uniform resource ${resource.id} requires fields or valueType.`);
    }
  } else {
    if (fields !== undefined) invalid(moduleId, `${path}.fields`, `Only uniform-buffer resources can declare generated fields.`);
    if (resource.valueType === undefined) invalid(moduleId, `${path}.valueType`, `Resource ${resource.id} requires valueType.`);
  }
  if (resource.valueType !== undefined) assertWgslType(resource.valueType, moduleId, `${path}.valueType`);
  if (resource.colorSpace !== undefined) {
    if (resource.kind !== 'texture') invalid(moduleId, `${path}.colorSpace`, `Only sampled textures can declare colorSpace.`);
    if (!['linear', 'srgb', 'data'].includes(resource.colorSpace)) {
      invalid(moduleId, `${path}.colorSpace`, `Resource ${resource.id} has invalid colorSpace ${resource.colorSpace}.`);
    }
  }

  return Object.freeze({
    id: resource.id,
    space: resource.space,
    kind: resource.kind,
    visibility,
    ...(resource.valueType === undefined ? {} : { valueType: resource.valueType }),
    ...(fields === undefined ? {} : { fields: Object.freeze(fields) }),
    ...(resource.colorSpace === undefined ? {} : { colorSpace: resource.colorSpace }),
    ...(resource.fixedBinding === undefined ? {} : { fixedBinding: resource.fixedBinding }),
  });
}

function normalizeSpecialization(
  specialization: ShaderSpecializationDefinition,
  moduleId: string,
  index: number,
): ShaderSpecializationDefinition {
  const path = `specializations.${index}`;
  if (!RESOURCE_ID.test(specialization.id)) invalid(moduleId, `${path}.id`, `Invalid specialization id ${specialization.id}.`);
  if (!['bool', 'i32', 'u32', 'f32'].includes(specialization.type)) {
    invalid(moduleId, `${path}.type`, `Invalid specialization type ${specialization.type}.`);
  }
  validateSpecializationValue(specialization.type, specialization.defaultValue, moduleId, `${path}.defaultValue`);
  return Object.freeze({ ...specialization });
}

export function validateSpecializationValue(
  type: ShaderSpecializationDefinition['type'],
  value: ShaderSpecializationDefinition['defaultValue'],
  moduleId: string,
  path: string,
): void {
  if (type === 'bool') {
    if (typeof value !== 'boolean') invalid(moduleId, path, `Specialization ${path} requires a boolean.`);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(moduleId, path, `Specialization ${path} requires a finite number.`);
  if ((type === 'i32' || type === 'u32') && !Number.isInteger(value)) invalid(moduleId, path, `Specialization ${path} requires an integer.`);
  if (type === 'u32' && value < 0) invalid(moduleId, path, `Specialization ${path} requires a non-negative integer.`);
}

function normalizeStages(
  values: readonly ShaderStage[],
  moduleId: string,
  path: string,
  allowed: readonly ShaderStage[] = SHADER_STAGES,
): readonly ShaderStage[] {
  if (!Array.isArray(values) || values.length === 0) invalid(moduleId, path, `${path} must contain at least one shader stage.`);
  const unique = [...new Set(values)];
  for (const stage of unique) {
    if (!SHADER_STAGES.includes(stage) || !allowed.includes(stage)) {
      invalid(moduleId, path, `${path} contains unsupported stage ${stage}.`);
    }
  }
  return Object.freeze(SHADER_STAGES.filter(stage => unique.includes(stage)));
}

function normalizeCapabilitySet(values: readonly string[], moduleId: string, path: string): readonly string[] {
  for (const [index, value] of values.entries()) {
    if (!CAPABILITY_ID.test(value)) invalid(moduleId, `${path}.${index}`, `Invalid capability id ${value}.`);
  }
  return Object.freeze([...new Set(values)].sort());
}

function normalizeEnumSet<T extends string>(
  values: readonly T[],
  allowed: readonly T[],
  moduleId: string,
  path: string,
): readonly T[] {
  if (values.length === 0) invalid(moduleId, path, `${path} must not be empty.`);
  const unique = [...new Set(values)];
  for (const value of unique) if (!allowed.includes(value)) invalid(moduleId, path, `${path} contains unsupported value ${value}.`);
  return Object.freeze(allowed.filter(value => unique.includes(value)));
}

function assertWgslType(value: string, moduleId: string, path: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_<>, \t]*$/.test(value)) invalid(moduleId, path, `Invalid WGSL resource type ${value}.`);
}

function expectUnique(values: readonly string[], moduleId: string, path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(moduleId, path, `Duplicate ${path} entry ${value}.`);
    seen.add(value);
  }
}

function invalid(moduleId: string, path: string, message: string): never {
  shaderError('E_SHADER_MODULE_INVALID', message, { moduleId, path });
}
