import { createPrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';
import { shaderError } from '../diagnostics';
import { sha256Hex } from '../hash';
import {
  PRODUCTION_COMPUTE_OPERATIONS,
  type CompileProductionComputeFamilyV1Options,
  type CompiledProductionComputeFamilyV1,
  type ComputeDispatchDomainV1,
  type ComputeDispatchScheduleV1,
  type ComputeEffectKindV1,
  type ComputeResourceAccessV1,
  type ComputeResourceKindV1,
  type ProductionComputeFamilyV1,
  type ProductionComputeOperation,
  type ProductionComputePassIrV1,
} from './contracts';
import { emitProductionComputePass, productionComputeModules } from './definitions';

const ID = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/;
const OPERATIONS = new Set<string>(PRODUCTION_COMPUTE_OPERATIONS);
const RESOURCE_KINDS = new Set<ComputeResourceKindV1>(['uniform-buffer', 'storage-buffer']);
const RESOURCE_ACCESS = new Set<ComputeResourceAccessV1>(['read', 'read-write', 'atomic-read-write']);
const EFFECTS = new Set<ComputeEffectKindV1>(['store', 'atomic-add']);
const DOMAINS = new Set<ComputeDispatchDomainV1>(['command-count', 'padded-count', 'instance-count']);
const SCHEDULES = new Set<ComputeDispatchScheduleV1>(['single', 'bitonic-network']);

export function compileProductionComputeFamilyV1(
  source: string,
  options: CompileProductionComputeFamilyV1Options,
): CompiledProductionComputeFamilyV1 {
  validateHash(options.sourceSha256, 'options.sourceSha256');
  if (sha256Hex(source) !== options.sourceSha256) invalid('source', 'Compute family provenance does not match sourceSha256.');
  const family = parseFamily(source);
  const modules = productionComputeModules();
  const computeModuleHash = sha256Hex(Object.entries(modules).map(([id, code]) => `${id}\n${code}`).join('\n'));
  const emitted = family.passes.map(pass => ({
    pass,
    emission: emitProductionComputePass(pass, options.sourcePath, computeModuleHash),
  }));
  const typedModuleHash = sha256Hex(JSON.stringify({
    family: family.canonicalHash,
    abiVersion: family.abiVersion,
    computeModuleHash,
    passIr: family.passes.map(pass => pass.canonicalHash),
  }));
  return Object.freeze({
    family,
    computeModuleHash,
    passes: Object.freeze(Object.fromEntries(emitted.map(({ pass, emission }) => [pass.id, Object.freeze({
      id: pass.id,
      operation: pass.operation,
      ir: pass,
      code: emission.code,
    })]))),
    artifact: createPrecompiledShaderArtifactV2({
      compilerVersion: 'shader-language-stage13',
      source: { kind: 'typed-ir', path: options.sourcePath, sha256: options.sourceSha256 },
      canonicalHash: family.canonicalHash,
      typedModuleHash,
      passes: emitted.map(value => value.emission.artifactPass),
    }),
  });
}

function parseFamily(source: string): ProductionComputeFamilyV1 {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) { invalid('source', `Compute family is not valid JSON: ${String(error)}`); }
  if (!value || typeof value !== 'object') invalid('source', 'Compute family must be an object.');
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== 'haiyue-production-compute-family' || candidate.version !== 1 || candidate.abiVersion !== 1) {
    invalid('format', 'Compute family must use format v1 and ABI v1.');
  }
  if (typeof candidate.id !== 'string' || !ID.test(candidate.id)) invalid('id', 'Family id must be stable.');
  if (!Array.isArray(candidate.passes) || candidate.passes.length === 0) invalid('passes', 'Family must contain passes.');
  const ids = new Set<string>();
  const operations = new Set<string>();
  const passes = candidate.passes.map((entry, index) => parsePass(entry, index, ids, operations));
  if (operations.size !== PRODUCTION_COMPUTE_OPERATIONS.length) invalid('passes', 'Compute family must contain every reviewed operation.');
  const body = Object.freeze({
    format: 'haiyue-production-compute-family' as const,
    version: 1 as const,
    id: candidate.id,
    abiVersion: 1 as const,
    passes: Object.freeze(passes),
  });
  return Object.freeze({ ...body, canonicalHash: sha256Hex(JSON.stringify(body)) });
}

function parsePass(entry: unknown, index: number, ids: Set<string>, operations: Set<string>): ProductionComputePassIrV1 {
  const path = `passes.${index}`;
  if (!entry || typeof entry !== 'object') invalid(path, 'Pass must be an object.');
  const pass = entry as Record<string, unknown>;
  if (typeof pass.id !== 'string' || !ID.test(pass.id) || ids.has(pass.id)) invalid(`${path}.id`, 'Pass id is invalid or duplicated.');
  if (typeof pass.operation !== 'string' || !OPERATIONS.has(pass.operation) || operations.has(pass.operation)) invalid(`${path}.operation`, 'Operation is invalid or duplicated.');
  if (pass.entryPoint !== 'cs_main') invalid(`${path}.entryPoint`, 'Production compute entry point must be cs_main.');
  const workgroupSize = tuple(pass.workgroupSize, `${path}.workgroupSize`);
  if (workgroupSize[0] > 256 || workgroupSize[1] > 256 || workgroupSize[2] > 64
    || workgroupSize[0] * workgroupSize[1] * workgroupSize[2] > 256) {
    invalid(`${path}.workgroupSize`, 'Workgroup size exceeds the WebGPU portable limit.');
  }
  if (!pass.dispatch || typeof pass.dispatch !== 'object') invalid(`${path}.dispatch`, 'Dispatch policy is required.');
  const dispatchValue = pass.dispatch as Record<string, unknown>;
  if (!DOMAINS.has(dispatchValue.domain as ComputeDispatchDomainV1)) invalid(`${path}.dispatch.domain`, 'Dispatch domain is invalid.');
  if (!SCHEDULES.has(dispatchValue.schedule as ComputeDispatchScheduleV1)) invalid(`${path}.dispatch.schedule`, 'Dispatch schedule is invalid.');
  const ceilDivisor = tuple(dispatchValue.ceilDivisor, `${path}.dispatch.ceilDivisor`);
  if (ceilDivisor.some((value, axis) => value !== workgroupSize[axis])) invalid(`${path}.dispatch.ceilDivisor`, 'Dispatch divisor must match workgroup size.');
  if ((pass.operation === 'gpu-sort-bitonic') !== (dispatchValue.schedule === 'bitonic-network')) {
    invalid(`${path}.dispatch.schedule`, 'Only the bitonic pass may use the bitonic-network schedule.');
  }
  if (!Array.isArray(pass.resources) || pass.resources.length === 0) invalid(`${path}.resources`, 'Resources are required.');
  const bindings = new Set<number>();
  const resourceIds = new Set<string>();
  const resources = pass.resources.map((resource, resourceIndex) => {
    const resourcePath = `${path}.resources.${resourceIndex}`;
    if (!resource || typeof resource !== 'object') invalid(resourcePath, 'Resource must be an object.');
    const item = resource as Record<string, unknown>;
    if (typeof item.id !== 'string' || !ID.test(item.id) || resourceIds.has(item.id)) invalid(`${resourcePath}.id`, 'Resource id is invalid or duplicated.');
    if (!Number.isInteger(item.binding) || (item.binding as number) < 0 || bindings.has(item.binding as number)) invalid(`${resourcePath}.binding`, 'Binding is invalid or duplicated.');
    if (!RESOURCE_KINDS.has(item.kind as ComputeResourceKindV1)) invalid(`${resourcePath}.kind`, 'Resource kind is invalid.');
    if (!RESOURCE_ACCESS.has(item.access as ComputeResourceAccessV1)) invalid(`${resourcePath}.access`, 'Resource access is invalid.');
    if (!Number.isInteger(item.minBindingSize) || (item.minBindingSize as number) < 0) invalid(`${resourcePath}.minBindingSize`, 'minBindingSize must be a non-negative integer.');
    if (item.kind === 'uniform-buffer' && (item.access !== 'read' || (item.minBindingSize as number) < 16)) invalid(resourcePath, 'Uniform buffers are read-only and require a frozen minimum size.');
    if (item.kind === 'storage-buffer' && item.access === 'atomic-read-write' && (item.minBindingSize as number) < 4) invalid(resourcePath, 'Atomic storage requires at least four bytes.');
    bindings.add(item.binding as number);
    resourceIds.add(item.id);
    return Object.freeze({
      id: item.id as string,
      binding: item.binding as number,
      kind: item.kind as ComputeResourceKindV1,
      access: item.access as ComputeResourceAccessV1,
      minBindingSize: item.minBindingSize as number,
    });
  });
  if (!Array.isArray(pass.effects) || pass.effects.length === 0) invalid(`${path}.effects`, 'Compute side effects must be explicit.');
  const effects = pass.effects.map((effect, effectIndex) => {
    const effectPath = `${path}.effects.${effectIndex}`;
    if (!effect || typeof effect !== 'object') invalid(effectPath, 'Effect must be an object.');
    const item = effect as Record<string, unknown>;
    if (!EFFECTS.has(item.kind as ComputeEffectKindV1)) invalid(`${effectPath}.kind`, 'Effect kind is invalid.');
    if (typeof item.resource !== 'string' || !resourceIds.has(item.resource)) invalid(`${effectPath}.resource`, 'Effect references an unknown resource.');
    const resource = resources.find(value => value.id === item.resource)!;
    if (resource.access === 'read') invalid(effectPath, 'Read-only resources cannot receive side effects.');
    if ((item.kind === 'atomic-add') !== (resource.access === 'atomic-read-write')) invalid(effectPath, 'Atomic effects require atomic-read-write access, and atomic resources require atomic effects.');
    return Object.freeze({ kind: item.kind as ComputeEffectKindV1, resource: item.resource as string });
  });
  for (const resource of resources) {
    if (resource.access !== 'read' && !effects.some(effect => effect.resource === resource.id)) invalid(`${path}.effects`, `Writable resource ${resource.id} has no declared effect.`);
  }
  ids.add(pass.id);
  operations.add(pass.operation);
  const body = Object.freeze({
    id: pass.id,
    operation: pass.operation as ProductionComputeOperation,
    entryPoint: 'cs_main' as const,
    workgroupSize: Object.freeze(workgroupSize) as readonly [number, number, number],
    dispatch: Object.freeze({
      domain: dispatchValue.domain as ComputeDispatchDomainV1,
      schedule: dispatchValue.schedule as ComputeDispatchScheduleV1,
      ceilDivisor: Object.freeze(ceilDivisor) as readonly [number, number, number],
    }),
    resources: Object.freeze(resources),
    effects: Object.freeze(effects),
  });
  return Object.freeze({ ...body, canonicalHash: sha256Hex(JSON.stringify(body)) });
}

function tuple(value: unknown, path: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => !Number.isInteger(item) || item < 1)) invalid(path, 'Expected three positive integers.');
  return [value[0] as number, value[1] as number, value[2] as number];
}

function validateHash(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) invalid(path, `${path} must be a SHA-256 digest.`);
}

function invalid(path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId: '@production-compute-family-v1', path });
}
