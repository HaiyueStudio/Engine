import type {
  ComposeShaderModulesOptions,
  ComposedShaderModules,
  ShaderSourceLocation,
  ShaderSourceSpan,
  ShaderGeneratedSourceSpan,
} from './contracts';
import { ShaderComposerError, shaderError } from './diagnostics';
import { sha256Hex } from './hash';
import { linkShaderModules } from './moduleLinker';
import { specializationName } from './naming';
import { allocateShaderResources } from './resourceAllocator';
import {
  formatSpecializationValue,
  generateSpecializationSource,
  resolveShaderSpecializations,
} from './specialization';
import { emitShaderModuleSource, normalizeShaderSource } from './sourceEmission';

const COMPILER_VERSION = '0.1.0-stage1';

export function composeShaderModules(options: ComposeShaderModulesOptions): ComposedShaderModules {
  if (!options.label.trim()) shaderError('E_SHADER_MODULE_INVALID', 'Shader composition label must not be empty.', { path: 'label' });
  const target = options.target ?? 'webgpu-wgsl';
  const profile = options.profile ?? 'webgpu-portable';
  if (target !== 'webgpu-wgsl') {
    shaderError('E_SHADER_TARGET_UNSUPPORTED', `Composer 2.0 stage 1 only emits webgpu-wgsl, not ${target}.`, {
      path: 'target',
      details: { target, implementedTargets: ['webgpu-wgsl'] },
    });
  }

  const linked = linkShaderModules(options.entry, target, profile, options.availableCapabilities ?? []);
  if (options.entry.entryPoints.length === 0) {
    shaderError('E_SHADER_MODULE_INVALID', `Entry module ${options.entry.id} must declare at least one entry point.`, {
      moduleId: options.entry.id,
      path: 'entryPoints',
    });
  }
  const specializations = resolveShaderSpecializations(linked.modules, options.specializationValues ?? {});
  const allocated = allocateShaderResources(linked.modules, options.maxBindingsPerGroup);
  const resourceById = new Map(allocated.resources.map(resource => [resource.definition.id, resource]));
  const specializationNames = new Map([...specializations.keys()].map(id => [id, specializationName(id)]));
  const sourceMap: ShaderSourceSpan[] = [];
  const lines: string[] = [];

  const append = (
    sourceId: string,
    sourceName: string,
    source: string,
    nestedSourceMap: readonly ShaderGeneratedSourceSpan[] = [],
  ): void => {
    const normalized = normalizeShaderSource(source);
    if (!normalized) return;
    lines.push(`// haiyue:module ${sourceId}`);
    const generatedStartLine = lines.length + 1;
    const sourceLines = normalized.split('\n');
    lines.push(...sourceLines);
    sourceMap.push(Object.freeze({
      sourceId,
      sourceName,
      generatedStartLine,
      generatedEndLine: generatedStartLine + sourceLines.length - 1,
    }));
    for (const span of nestedSourceMap) {
      sourceMap.push(Object.freeze({
        sourceId: span.sourceId,
        sourceName: span.sourceName,
        generatedStartLine: generatedStartLine + span.generatedStartLine - 1,
        generatedEndLine: generatedStartLine + span.generatedEndLine - 1,
        ...(span.sourceStartLine === undefined ? {} : { sourceStartLine: span.sourceStartLine }),
        ...(span.sourceStartColumn === undefined ? {} : { sourceStartColumn: span.sourceStartColumn }),
      }));
    }
    lines.push('');
  };

  append('@specializations', 'generated/specializations.wgsl', generateSpecializationSource(specializations, specializationNames));
  append('@resources', 'generated/resources.wgsl', allocated.source);
  for (const module of linked.modules) {
    let source: { readonly code: string; readonly sourceMap?: readonly ShaderGeneratedSourceSpan[] };
    try {
      source = emitShaderModuleSource(
        module,
        linked.modules,
        linked.symbolNames,
        resourceById,
        specializationNames,
      );
    } catch (error) {
      if (error instanceof ShaderComposerError) throw error;
      shaderError('E_SHADER_SOURCE_GENERATION_FAILED', `Source factory for ${module.id} failed.`, {
        moduleId: module.id,
        path: 'source',
        cause: error,
      });
    }
    append(module.id, module.sourceName, source.code, source.sourceMap);
  }
  if (lines[lines.length - 1] === '') lines.pop();
  const code = `${lines.join('\n')}\n`;

  const moduleKey = linked.modules.map(module => `${module.id}@${module.version}`).join('+');
  const specializationKey = [...specializations.entries()]
    .map(([id, entry]) => `${id}=${formatSpecializationValue(entry.definition.type, entry.value)}`)
    .join(',');
  const capabilityKey = linked.requiredCapabilities.join(',');
  const hashInput = JSON.stringify({
    compilerVersion: COMPILER_VERSION,
    target,
    profile,
    moduleKey,
    specializationKey,
    capabilityKey,
    resources: allocated.reflection,
    uniformBlocks: allocated.uniformBlocks,
    entryPoints: options.entry.entryPoints,
    vertexSemantics: [...(options.vertexSemantics ?? [])].sort(),
    varyings: [...(options.varyings ?? [])].sort((left, right) => left.location - right.location),
  }) + `\n${code}`;
  const irHash = sha256Hex(hashInput);
  const variantKey = `hy2|${target}|${profile}|${moduleKey}|${specializationKey}|${irHash.slice(0, 16)}`;
  const passRequirements = Object.freeze([...new Set([
    ...linked.modules.flatMap(module => module.passRequirements),
    ...(options.passRequirements ?? []),
  ])].sort());
  const reflectedSourceMap = Object.freeze(sourceMap.map(span => Object.freeze({
    sourceId: span.sourceId,
    generatedStartLine: span.generatedStartLine,
    generatedEndLine: span.generatedEndLine,
  })));
  const reflection = Object.freeze({
    format: 'haiyue-shader-reflection' as const,
    version: 1 as const,
    compilerVersion: COMPILER_VERSION,
    target,
    profile,
    irHash,
    variantKey,
    entryPoints: Object.freeze(options.entry.entryPoints.map(entryPoint => Object.freeze({
      stage: entryPoint.stage,
      name: entryPoint.name,
    }))),
    resources: allocated.reflection,
    uniformBlocks: allocated.uniformBlocks,
    vertexSemantics: Object.freeze([...new Set(options.vertexSemantics ?? [])].sort()),
    varyings: Object.freeze([...(options.varyings ?? [])].sort((left, right) => left.location - right.location)),
    capabilities: Object.freeze(linked.requiredCapabilities),
    passRequirements,
    sourceMap: reflectedSourceMap,
  });

  return Object.freeze({
    label: options.label,
    code,
    moduleIds: Object.freeze(linked.modules.map(module => module.id)),
    variantKey,
    irHash,
    reflection,
    sourceMap: Object.freeze(sourceMap),
  });
}

export function mapShaderSourceLocation(
  composition: Pick<ComposedShaderModules, 'sourceMap'>,
  generatedLine: number,
  column = 1,
): ShaderSourceLocation | null {
  const span = composition.sourceMap
    .filter(candidate => generatedLine >= candidate.generatedStartLine && generatedLine <= candidate.generatedEndLine)
    .sort((left, right) =>
      (left.generatedEndLine - left.generatedStartLine) - (right.generatedEndLine - right.generatedStartLine))[0];
  if (!span) return null;
  return Object.freeze({
    sourceId: span.sourceId,
    sourceName: span.sourceName,
    line: (span.sourceStartLine ?? 1) + generatedLine - span.generatedStartLine,
    column: generatedLine === span.generatedStartLine
      ? (span.sourceStartColumn ?? 1) + column - 1
      : column,
    generatedLine,
  });
}

export function formatShaderCompilationMessage(
  composition: Pick<ComposedShaderModules, 'label' | 'sourceMap'>,
  message: { readonly message: string; readonly lineNum: number; readonly linePos: number; readonly type: string },
): string {
  const location = mapShaderSourceLocation(composition, message.lineNum, message.linePos);
  const prefix = location
    ? `${location.sourceName}:${location.line}:${location.column}`
    : `${composition.label}:generated:${message.lineNum}:${message.linePos}`;
  return `${prefix} [${message.type}] ${message.message}`;
}
