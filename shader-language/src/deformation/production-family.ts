import { createPrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';
import { shaderError } from '../diagnostics';
import { sha256Hex } from '../hash';
import {
  PRODUCTION_DEFORMATION_OPERATIONS,
  type CompileProductionDeformationFamilyV1Options,
  type CompiledProductionDeformationFamilyV1,
  type ProductionDeformationFamilyV1,
  type ProductionDeformationOperation,
} from './production-contracts';
import { emitProductionDeformationPass, productionDeformationFeatureModules } from './production-definitions';

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const OPERATIONS = new Set<string>(PRODUCTION_DEFORMATION_OPERATIONS);

export function compileProductionDeformationFamilyV1(
  source: string,
  options: CompileProductionDeformationFamilyV1Options,
): CompiledProductionDeformationFamilyV1 {
  validateHash(options.sourceSha256, 'options.sourceSha256');
  if (sha256Hex(source) !== options.sourceSha256) invalid('source', 'Deformation family provenance does not match sourceSha256.');
  const family = parseFamily(source);
  const features = productionDeformationFeatureModules();
  const deformationModuleHash = sha256Hex(`${features.morph}\n${features.skinning}`);
  const emitted = family.passes.map(pass => ({
    ...pass,
    emission: emitProductionDeformationPass(
      pass.id,
      pass.operation,
      options.sourcePath,
      deformationModuleHash,
    ),
  }));
  const typedModuleHash = sha256Hex(JSON.stringify({
    family: family.canonicalHash,
    abiVersion: family.abiVersion,
    deformationModuleHash,
    order: ['morph', 'skin'],
    history: 'current-and-previous-same-deformation',
  }));
  return Object.freeze({
    family,
    deformationModuleHash,
    passes: Object.freeze(Object.fromEntries(emitted.map(pass => [pass.id, Object.freeze({
      id: pass.id,
      operation: pass.operation,
      code: pass.emission.code,
    })]))),
    artifact: createPrecompiledShaderArtifactV2({
      compilerVersion: 'shader-language-stage10',
      source: { kind: 'module-family', path: options.sourcePath, sha256: options.sourceSha256 },
      canonicalHash: family.canonicalHash,
      typedModuleHash,
      passes: emitted.map(pass => pass.emission.artifactPass),
    }),
    featureModules: Object.freeze({ ...features }),
  });
}

function parseFamily(source: string): ProductionDeformationFamilyV1 {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) {
    invalid('source', `Deformation family is not valid JSON: ${String(error)}`);
  }
  if (!value || typeof value !== 'object') invalid('source', 'Deformation family must be an object.');
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== 'haiyue-production-deformation-family' || candidate.version !== 1 || candidate.abiVersion !== 1) {
    invalid('format', 'Deformation family must use format v1 and ABI v1.');
  }
  if (typeof candidate.id !== 'string' || !ID.test(candidate.id)) invalid('id', 'Family id must be stable.');
  if (!Array.isArray(candidate.passes) || candidate.passes.length === 0) invalid('passes', 'Family must contain passes.');
  const ids = new Set<string>();
  const operations = new Set<string>();
  const passes = candidate.passes.map((entry, index) => {
    if (!entry || typeof entry !== 'object') invalid(`passes.${index}`, 'Pass must be an object.');
    const pass = entry as Record<string, unknown>;
    if (typeof pass.id !== 'string' || !ID.test(pass.id) || ids.has(pass.id)) invalid(`passes.${index}.id`, 'Pass id is invalid or duplicated.');
    if (typeof pass.operation !== 'string' || !OPERATIONS.has(pass.operation) || operations.has(pass.operation)) {
      invalid(`passes.${index}.operation`, 'Operation is invalid or duplicated.');
    }
    ids.add(pass.id);
    operations.add(pass.operation);
    return Object.freeze({ id: pass.id, operation: pass.operation as ProductionDeformationOperation });
  });
  if (operations.size !== PRODUCTION_DEFORMATION_OPERATIONS.length) {
    invalid('passes', 'Production deformation family must be migrated atomically with every required operation.');
  }
  const body = Object.freeze({
    format: 'haiyue-production-deformation-family' as const,
    version: 1 as const,
    id: candidate.id,
    abiVersion: 1 as const,
    passes: Object.freeze(passes),
  });
  return Object.freeze({ ...body, canonicalHash: sha256Hex(JSON.stringify(body)) });
}

function validateHash(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) invalid(path, `${path} must be a SHA-256 digest.`);
}

function invalid(path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId: '@production-deformation-family-v1', path });
}
