import { createPrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';
import { shaderError } from '../diagnostics';
import { sha256Hex } from '../hash';
import {
  BUILTIN_POSTPROCESS_OPERATIONS,
  type BuiltinPostprocessFamilyV1,
  type BuiltinPostprocessOperation,
  type CompileBuiltinPostprocessFamilyV1Options,
  type CompiledBuiltinPostprocessFamilyV1,
} from './builtin-contracts';
import {
  FULLSCREEN_POSTPROCESS_VERTEX_WGSL,
  emitBuiltinPostprocessPass,
} from './builtin-wgsl';

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const OPERATIONS = new Set<string>(BUILTIN_POSTPROCESS_OPERATIONS);

export function compileBuiltinPostprocessFamilyV1(
  source: string,
  options: CompileBuiltinPostprocessFamilyV1Options,
): CompiledBuiltinPostprocessFamilyV1 {
  validateHash(options.sourceSha256, 'options.sourceSha256');
  if (sha256Hex(source) !== options.sourceSha256) {
    invalid('source', 'Builtin postprocess source provenance does not match sourceSha256.');
  }
  const family = parseFamily(source);
  const passGroup = options.passGroup ?? 0;
  if (!Number.isInteger(passGroup) || passGroup !== 0) {
    invalid('options.passGroup', 'Artifact V2 standalone postprocess currently requires physical group 0.');
  }
  const compiledPasses = family.passes.map(pass => emitBuiltinPostprocessPass(
    pass.id,
    pass.operation,
    FULLSCREEN_POSTPROCESS_VERTEX_WGSL,
    passGroup,
    options.sourcePath,
  ));
  const typedModuleHash = sha256Hex(JSON.stringify({
    family: family.canonicalHash,
    standardLibrary: 'builtin-postprocess-v1',
    operations: compiledPasses.map(pass => pass.operation),
  }));
  const artifact = createPrecompiledShaderArtifactV2({
    compilerVersion: 'shader-language-stage8',
    source: { kind: 'module-family', path: options.sourcePath, sha256: options.sourceSha256 },
    canonicalHash: family.canonicalHash,
    typedModuleHash,
    passes: compiledPasses.map(pass => pass.artifactPass),
  });
  return Object.freeze({
    family,
    fullscreenVertexSource: FULLSCREEN_POSTPROCESS_VERTEX_WGSL,
    passes: Object.freeze(Object.fromEntries(compiledPasses.map(pass => [pass.id, Object.freeze({
      id: pass.id,
      operation: pass.operation,
      fragmentSource: pass.fragmentSource,
      code: pass.artifactPass.code,
    })]))),
    artifact,
  });
}

function parseFamily(source: string): BuiltinPostprocessFamilyV1 {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) {
    invalid('source', `Builtin postprocess family is not valid JSON: ${String(error)}`);
  }
  if (!value || typeof value !== 'object') invalid('source', 'Builtin postprocess family must be an object.');
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== 'haiyue-builtin-postprocess-family' || candidate.version !== 1) {
    invalid('format', 'Builtin postprocess family must use haiyue-builtin-postprocess-family v1.');
  }
  if (typeof candidate.id !== 'string' || !ID.test(candidate.id)) invalid('id', 'Family id must be stable.');
  if (!Array.isArray(candidate.passes) || candidate.passes.length === 0) {
    invalid('passes', 'Builtin postprocess family must contain passes.');
  }
  const ids = new Set<string>();
  const operations = new Set<string>();
  const passes = candidate.passes.map((entry, index) => {
    if (!entry || typeof entry !== 'object') invalid(`passes.${index}`, 'Pass must be an object.');
    const pass = entry as Record<string, unknown>;
    if (typeof pass.id !== 'string' || !ID.test(pass.id) || ids.has(pass.id)) {
      invalid(`passes.${index}.id`, `Invalid or duplicate pass id ${String(pass.id)}.`);
    }
    if (typeof pass.operation !== 'string' || !OPERATIONS.has(pass.operation) || operations.has(pass.operation)) {
      invalid(`passes.${index}.operation`, `Unknown or duplicate operation ${String(pass.operation)}.`);
    }
    ids.add(pass.id);
    operations.add(pass.operation);
    return Object.freeze({ id: pass.id, operation: pass.operation as BuiltinPostprocessOperation });
  });
  for (const operation of BUILTIN_POSTPROCESS_OPERATIONS) {
    if (!operations.has(operation)) invalid('passes', `Builtin postprocess family is missing ${operation}.`);
  }
  const body = Object.freeze({
    format: 'haiyue-builtin-postprocess-family' as const,
    version: 1 as const,
    id: candidate.id,
    passes: Object.freeze(passes),
  });
  return Object.freeze({ ...body, canonicalHash: sha256Hex(JSON.stringify(body)) });
}

function validateHash(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) invalid(path, `${path} must be a SHA-256 hex digest.`);
}

function invalid(path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId: '@builtin-postprocess-family-v1', path });
}
