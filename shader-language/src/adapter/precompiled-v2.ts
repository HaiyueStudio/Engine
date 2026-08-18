import { SHADER_RESOURCE_GROUPS } from '../contracts';
import { shaderError } from '../diagnostics';
import { sha256Hex } from '../hash';
import { validateWgslBindingReflection } from './wgsl-reflection-validator';
import type {
  PrecompiledShaderArtifactV2,
  PrecompiledShaderBindingLayoutV2,
  PrecompiledShaderPassV2,
} from './precompiled-artifact-contract';
export type {
  PrecompiledShaderArtifactV2,
  PrecompiledShaderBindingLayoutV2,
  PrecompiledShaderBindingV2,
  PrecompiledShaderBindGroupV2,
  PrecompiledShaderLayoutOwnerV2,
  PrecompiledShaderPassV2,
  PrecompiledShaderRenderTargetV2,
  PrecompiledShaderSourceMapEntryV2,
  PrecompiledShaderStage,
  PrecompiledShaderStageEntriesV2,
  PrecompiledShaderUniformBlockV2,
  PrecompiledShaderUniformFieldV2,
  PrecompiledShaderVaryingV2,
  PrecompiledShaderVertexAttributeV2,
  PrecompiledShaderVertexBufferV2,
} from './precompiled-artifact-contract';

export interface PrecompiledShaderPassV2Definition extends Omit<PrecompiledShaderPassV2, 'canonicalHash'> {}

export interface PrecompiledShaderArtifactV2Definition {
  readonly compilerVersion: string;
  readonly source: PrecompiledShaderArtifactV2['source'];
  readonly canonicalHash: string;
  readonly typedModuleHash: string;
  readonly passes: readonly PrecompiledShaderPassV2Definition[];
}

/**
 * Creates the backend-neutral delivery envelope consumed by engine runtime adapters.
 * Binding layouts must already come from compiler reflection; this function never parses WGSL.
 */
export function createPrecompiledShaderArtifactV2(
  definition: PrecompiledShaderArtifactV2Definition,
): PrecompiledShaderArtifactV2 {
  validateHash(definition.source.sha256, 'source.sha256');
  validateHash(definition.canonicalHash, 'canonicalHash');
  validateHash(definition.typedModuleHash, 'typedModuleHash');
  if (!definition.compilerVersion.trim()) invalid('compilerVersion', 'Compiler version must be non-empty.');
  if (!definition.source.path.trim()) invalid('source.path', 'Artifact source path must be non-empty.');
  if (definition.passes.length === 0) invalid('passes', 'Artifact must contain at least one pass.');

  const passes: Record<string, PrecompiledShaderPassV2> = {};
  for (const pass of definition.passes) {
    if (!pass.id.trim()) invalid('passes.id', 'Pass id must be non-empty.');
    if (passes[pass.id]) invalid(`passes.${pass.id}`, `Duplicate pass id ${pass.id}.`);
    validatePass(pass);
    const body = clonePass(pass);
    passes[pass.id] = Object.freeze({
      ...body,
      canonicalHash: sha256Hex(JSON.stringify(body)),
    });
  }

  const body = Object.freeze({
    format: 'haiyue-precompiled-shader-artifact' as const,
    version: 2 as const,
    compilerVersion: definition.compilerVersion,
    source: Object.freeze({ ...definition.source }),
    canonicalHash: definition.canonicalHash,
    typedModuleHash: definition.typedModuleHash,
    passes: Object.freeze(passes),
  });
  return Object.freeze({ ...body, artifactHash: sha256Hex(JSON.stringify(body)) });
}

function clonePass(pass: PrecompiledShaderPassV2Definition): Omit<PrecompiledShaderPassV2, 'canonicalHash'> {
  return Object.freeze({
    id: pass.id,
    code: pass.code,
    entryPoints: Object.freeze({ ...pass.entryPoints }),
    bindGroups: Object.freeze(pass.bindGroups.map(group => Object.freeze({
      ...group,
      bindings: Object.freeze(group.bindings.map(binding => Object.freeze({
        ...binding,
        visibility: Object.freeze([...binding.visibility]),
        layout: Object.freeze({ ...binding.layout }),
      }))),
    }))),
    uniformBlocks: Object.freeze(pass.uniformBlocks.map(block => Object.freeze({
      ...block,
      fields: Object.freeze(block.fields.map(field => Object.freeze({ ...field }))),
    }))),
    vertexBuffers: Object.freeze(pass.vertexBuffers.map(buffer => Object.freeze({
      ...buffer,
      attributes: Object.freeze(buffer.attributes.map(attribute => Object.freeze({ ...attribute }))),
    }))),
    varyings: Object.freeze(pass.varyings.map(varying => Object.freeze({ ...varying }))),
    renderTargets: Object.freeze(pass.renderTargets.map(target => Object.freeze({ ...target }))),
    capabilities: Object.freeze([...pass.capabilities]),
    passRequirements: Object.freeze([...pass.passRequirements]),
    sourceMap: Object.freeze(pass.sourceMap.map(entry => Object.freeze({ ...entry }))),
  });
}

function validatePass(pass: PrecompiledShaderPassV2Definition): void {
  if (!pass.code.trim()) invalid(`passes.${pass.id}.code`, 'Pass code must be non-empty.');
  const render = Boolean(pass.entryPoints.vertex && pass.entryPoints.fragment);
  const compute = Boolean(pass.entryPoints.compute);
  if (render === compute) {
    invalid(`passes.${pass.id}.entryPoints`, 'Pass must define either vertex+fragment or compute entry points.');
  }
  if ((pass.entryPoints.vertex && !pass.entryPoints.fragment)
    || (!pass.entryPoints.vertex && pass.entryPoints.fragment)) {
    invalid(`passes.${pass.id}.entryPoints`, 'Render pass requires both vertex and fragment entry points.');
  }
  if (render && pass.renderTargets.length === 0) {
    invalid(`passes.${pass.id}.renderTargets`, 'Render pass must declare at least one render target class.');
  }
  if (compute && pass.renderTargets.length !== 0) {
    invalid(`passes.${pass.id}.renderTargets`, 'Compute pass cannot declare render targets.');
  }

  const groups = pass.bindGroups;
  if (groups.length === 0) invalid(`passes.${pass.id}.bindGroups`, 'Pass must declare its pipeline layout groups.');
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (group.physicalGroup !== index) {
      invalid(`passes.${pass.id}.bindGroups`, 'Physical groups must be contiguous and start at group 0.');
    }
    if (group.logicalGroup !== SHADER_RESOURCE_GROUPS[group.logicalSpace]) {
      invalid(
        `passes.${pass.id}.bindGroups.${index}.logicalGroup`,
        `${group.logicalSpace} must retain logical group ${SHADER_RESOURCE_GROUPS[group.logicalSpace]}.`,
      );
    }
    const bindings = new Set<number>();
    for (const binding of group.bindings) {
      if (!binding.id.trim()) invalid(`passes.${pass.id}.bindGroups.${index}.bindings`, 'Binding id must be non-empty.');
      if (!Number.isInteger(binding.binding) || binding.binding < 0 || bindings.has(binding.binding)) {
        invalid(`passes.${pass.id}.bindGroups.${index}.bindings`, `Invalid or duplicate binding ${binding.binding}.`);
      }
      bindings.add(binding.binding);
      if (binding.visibility.length === 0 || new Set(binding.visibility).size !== binding.visibility.length) {
        invalid(`passes.${pass.id}.bindGroups.${index}.bindings.${binding.binding}.visibility`, 'Visibility must be non-empty and unique.');
      }
      validateBindingLayout(binding.layout, `passes.${pass.id}.bindGroups.${index}.bindings.${binding.binding}.layout`);
    }
  }

  const targetLocations = new Set<number>();
  for (const target of pass.renderTargets) {
    if (!Number.isInteger(target.location) || target.location < 0 || targetLocations.has(target.location)) {
      invalid(`passes.${pass.id}.renderTargets`, `Invalid or duplicate render target location ${target.location}.`);
    }
    if (!target.formatClass.trim()) invalid(`passes.${pass.id}.renderTargets.${target.location}`, 'Format class must be non-empty.');
    targetLocations.add(target.location);
  }
  validateWgslBindingReflection(pass);
}

function validateBindingLayout(layout: PrecompiledShaderBindingLayoutV2, path: string): void {
  if (layout.kind === 'buffer') {
    if (!Number.isInteger(layout.minBindingSize) || layout.minBindingSize < 0) {
      invalid(`${path}.minBindingSize`, 'Buffer minBindingSize must be a non-negative integer.');
    }
  } else if (layout.kind === 'storage-texture' && !layout.format.trim()) {
    invalid(`${path}.format`, 'Storage texture format must be non-empty.');
  }
}

function validateHash(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) invalid(path, `${path} must be a SHA-256 hex digest.`);
}

function invalid(path: string, message: string): never {
  shaderError('E_SHADER_RESOURCE_CONFLICT', message, {
    moduleId: '@precompiled-shader-artifact-v2',
    path,
  });
}
