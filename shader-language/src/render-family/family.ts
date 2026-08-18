import { createPrecompiledShaderArtifactV2 } from '../adapter/precompiled-v2';
import { shaderError } from '../diagnostics';
import { sha256Hex } from '../hash';
import {
  BUILTIN_RENDER_FAMILY_KINDS,
  BUILTIN_RENDER_OPERATIONS,
  type BuiltinRenderFamilyKind,
  type BuiltinRenderFamilyV1,
  type BuiltinRenderOperation,
  type CompileBuiltinRenderFamilyV1Options,
  type CompiledBuiltinRenderFamilyV1,
} from './contracts';
import { emitBuiltinRenderPass } from './definitions';

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const FAMILY_KINDS = new Set<string>(BUILTIN_RENDER_FAMILY_KINDS);

export function compileBuiltinRenderFamilyV1(
  source: string,
  options: CompileBuiltinRenderFamilyV1Options,
): CompiledBuiltinRenderFamilyV1 {
  validateHash(options.sourceSha256, 'options.sourceSha256');
  if (sha256Hex(source) !== options.sourceSha256) {
    invalid('source', 'Builtin render family source provenance does not match sourceSha256.');
  }
  const family = parseFamily(source);
  const emitted = family.passes.map(pass => ({
    ...pass,
    emission: emitBuiltinRenderPass(pass.id, pass.operation, options.sourcePath),
  }));
  const typedModuleHash = sha256Hex(JSON.stringify({
    family: family.canonicalHash,
    standardLibrary: `builtin-render-${family.kind}-v1`,
    operations: emitted.map(pass => pass.operation),
  }));
  const artifact = createPrecompiledShaderArtifactV2({
    compilerVersion: 'shader-language-stage9',
    source: { kind: 'module-family', path: options.sourcePath, sha256: options.sourceSha256 },
    canonicalHash: family.canonicalHash,
    typedModuleHash,
    passes: emitted.map(pass => pass.emission.artifactPass),
  });
  return Object.freeze({
    family,
    passes: Object.freeze(Object.fromEntries(emitted.map(pass => [pass.id, Object.freeze({
      id: pass.id,
      operation: pass.operation,
      code: pass.emission.code,
    })]))),
    artifact,
  });
}

function parseFamily(source: string): BuiltinRenderFamilyV1 {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) {
    invalid('source', `Builtin render family is not valid JSON: ${String(error)}`);
  }
  if (!value || typeof value !== 'object') invalid('source', 'Builtin render family must be an object.');
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== 'haiyue-builtin-render-family' || candidate.version !== 1) {
    invalid('format', 'Builtin render family must use haiyue-builtin-render-family v1.');
  }
  if (typeof candidate.id !== 'string' || !ID.test(candidate.id)) invalid('id', 'Family id must be stable.');
  if (typeof candidate.kind !== 'string' || !FAMILY_KINDS.has(candidate.kind)) {
    invalid('kind', `Unknown builtin render family kind ${String(candidate.kind)}.`);
  }
  if (!Array.isArray(candidate.passes) || candidate.passes.length === 0) {
    invalid('passes', 'Builtin render family must contain passes.');
  }
  const kind = candidate.kind as BuiltinRenderFamilyKind;
  const allowed = new Set<string>(BUILTIN_RENDER_OPERATIONS[kind]);
  const ids = new Set<string>();
  const operations = new Set<string>();
  const passes = candidate.passes.map((entry, index) => {
    if (!entry || typeof entry !== 'object') invalid(`passes.${index}`, 'Pass must be an object.');
    const pass = entry as Record<string, unknown>;
    if (typeof pass.id !== 'string' || !ID.test(pass.id) || ids.has(pass.id)) {
      invalid(`passes.${index}.id`, `Invalid or duplicate pass id ${String(pass.id)}.`);
    }
    if (typeof pass.operation !== 'string' || !allowed.has(pass.operation) || operations.has(pass.operation)) {
      invalid(`passes.${index}.operation`, `Unknown, cross-family, or duplicate operation ${String(pass.operation)}.`);
    }
    ids.add(pass.id);
    operations.add(pass.operation);
    return Object.freeze({ id: pass.id, operation: pass.operation as BuiltinRenderOperation });
  });
  const body = Object.freeze({
    format: 'haiyue-builtin-render-family' as const,
    version: 1 as const,
    id: candidate.id,
    kind,
    passes: Object.freeze(passes),
  });
  return Object.freeze({ ...body, canonicalHash: sha256Hex(JSON.stringify(body)) });
}

function validateHash(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) invalid(path, `${path} must be a SHA-256 hex digest.`);
}

function invalid(path: string, message: string): never {
  shaderError('E_SHADER_IR_INVALID', message, { moduleId: '@builtin-render-family-v1', path });
}
