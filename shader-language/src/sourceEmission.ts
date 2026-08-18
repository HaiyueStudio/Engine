import type {
  ShaderGeneratedSource,
  ShaderGeneratedSourceSpan,
  ShaderModule,
  ShaderSourceContext,
} from './contracts';
import { shaderError } from './diagnostics';
import { resourceVariableName } from './naming';
import type { AllocatedShaderResource } from './resourceAllocator';

export function emitShaderModuleSource(
  module: ShaderModule,
  modules: readonly ShaderModule[],
  symbols: ReadonlyMap<string, ReadonlyMap<string, string>>,
  resources: ReadonlyMap<string, AllocatedShaderResource>,
  specializations: ReadonlyMap<string, string>,
): ShaderGeneratedSource {
  const context = createSourceContext(module, modules, symbols, resources, specializations);
  const generated: unknown = module.source(context);
  if (typeof generated !== 'string' && !isGeneratedSource(generated)) {
    shaderError('E_SHADER_SOURCE_GENERATION_FAILED', `Source factory for ${module.id} must return a string or generated source.`, {
      moduleId: module.id,
      path: 'source',
    });
  }
  const rawCode = typeof generated === 'string' ? generated : generated.code;
  const normalized = normalizeShaderSource(rawCode);
  if (!normalized) {
    shaderError('E_SHADER_SOURCE_GENERATION_FAILED', `Source factory for ${module.id} returned empty WGSL.`, {
      moduleId: module.id,
      path: 'source',
    });
  }
  if (containsDirectBinding(normalized)) {
    shaderError('E_SHADER_SOURCE_GENERATION_FAILED', `Module ${module.id} declares @group/@binding directly; resources must be symbolic.`, {
      moduleId: module.id,
      path: 'source',
    });
  }
  validateGeneratedSymbols(module, normalized, symbols.get(module.id) ?? new Map());
  const sourceMap = typeof generated === 'string'
    ? Object.freeze([])
    : validateRelativeSourceMap(module, generated.sourceMap ?? [], normalized);
  return Object.freeze({ code: normalized, sourceMap });
}

export function normalizeShaderSource(source: string): string {
  return source.replace(/\r\n?/g, '\n').trim();
}

function createSourceContext(
  module: ShaderModule,
  modules: readonly ShaderModule[],
  symbols: ReadonlyMap<string, ReadonlyMap<string, string>>,
  resources: ReadonlyMap<string, AllocatedShaderResource>,
  specializations: ReadonlyMap<string, string>,
): ShaderSourceContext {
  const ownSymbols = symbols.get(module.id) ?? new Map();
  const declaredImports = new Set(module.imports.map(imported => `${imported.from}:${imported.symbol}`));
  const ownResources = new Map(module.resources.map(resource => [resource.id, resource]));
  const ownSpecializations = new Set(module.specializations.map(specialization => specialization.id));
  const entryPoints = new Map(module.entryPoints.map(entryPoint => [entryPoint.id, entryPoint.name]));
  const moduleIds = new Set(modules.map(candidate => candidate.id));

  return Object.freeze({
    moduleId: module.id,
    symbol(id: string): string {
      const value = ownSymbols.get(id);
      if (value) return value;
      shaderError('E_SHADER_SYMBOL_INVALID', `Module ${module.id} requested undeclared symbol ${id}.`, {
        moduleId: module.id,
        path: `symbols.${id}`,
      });
    },
    imported(moduleId: string, symbolId: string): string {
      if (!moduleIds.has(moduleId) || !declaredImports.has(`${moduleId}:${symbolId}`)) {
        shaderError('E_SHADER_IMPORT_MISSING', `Module ${module.id} requested undeclared import ${moduleId}.${symbolId}.`, {
          moduleId: module.id,
          path: `imports.${moduleId}.${symbolId}`,
        });
      }
      const value = symbols.get(moduleId)?.get(symbolId);
      if (value) return value;
      shaderError('E_SHADER_IMPORT_MISSING', `Import ${moduleId}.${symbolId} has no linked symbol.`, {
        moduleId: module.id,
        path: `imports.${moduleId}.${symbolId}`,
      });
    },
    resource(id: string): string {
      if (!ownResources.has(id)) {
        shaderError('E_SHADER_RESOURCE_CONFLICT', `Module ${module.id} requested undeclared resource ${id}.`, {
          moduleId: module.id,
          path: `resources.${id}`,
        });
      }
      return resourceVariableName(id);
    },
    uniformField(resourceId: string, fieldId: string): string {
      const definition = ownResources.get(resourceId);
      const allocated = resources.get(resourceId);
      if (!definition || !allocated) {
        shaderError('E_SHADER_RESOURCE_CONFLICT', `Module ${module.id} requested undeclared uniform ${resourceId}.`, {
          moduleId: module.id,
          path: `resources.${resourceId}`,
        });
      }
      if (!definition.fields?.some(field => field.id === fieldId)) {
        shaderError('E_SHADER_RESOURCE_CONFLICT', `Uniform ${resourceId} has no field ${fieldId}.`, {
          moduleId: module.id,
          path: `resources.${resourceId}.fields.${fieldId}`,
        });
      }
      return `${allocated.variableName}.${fieldId}`;
    },
    specialization(id: string): string {
      if (!ownSpecializations.has(id)) {
        shaderError('E_SHADER_SPECIALIZATION_INVALID', `Module ${module.id} requested undeclared specialization ${id}.`, {
          moduleId: module.id,
          path: `specializations.${id}`,
        });
      }
      const value = specializations.get(id);
      if (value) return value;
      shaderError('E_SHADER_SPECIALIZATION_INVALID', `Specialization ${id} was not linked.`, {
        moduleId: module.id,
        path: `specializations.${id}`,
      });
    },
    entryPoint(id: string): string {
      const value = entryPoints.get(id);
      if (value) return value;
      shaderError('E_SHADER_SYMBOL_INVALID', `Module ${module.id} requested undeclared entry point ${id}.`, {
        moduleId: module.id,
        path: `entryPoints.${id}`,
      });
    },
  });
}

function validateGeneratedSymbols(
  module: ShaderModule,
  source: string,
  names: ReadonlyMap<string, string>,
): void {
  for (const symbol of module.symbols) {
    const physical = names.get(symbol.id);
    if (!physical || !new RegExp(`\\b${escapeRegExp(physical)}\\b`).test(source)) {
      shaderError('E_SHADER_SOURCE_GENERATION_FAILED', `Module ${module.id} did not emit declared symbol ${symbol.id}.`, {
        moduleId: module.id,
        path: `symbols.${symbol.id}`,
      });
    }
  }
  for (const entryPoint of module.entryPoints) {
    const pattern = new RegExp(`@${entryPoint.stage}(?:\\s+@[A-Za-z_][A-Za-z0-9_]*(?:\\([^)]*\\))?)*\\s+fn\\s+${escapeRegExp(entryPoint.name)}\\b`);
    if (!pattern.test(source)) {
      shaderError('E_SHADER_SOURCE_GENERATION_FAILED', `Module ${module.id} did not emit ${entryPoint.stage} entry point ${entryPoint.name}.`, {
        moduleId: module.id,
        path: `entryPoints.${entryPoint.id}`,
      });
    }
  }
}

function containsDirectBinding(source: string): boolean {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
  return /@(group|binding)\s*\(/.test(withoutComments);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isGeneratedSource(value: unknown): value is ShaderGeneratedSource {
  return !!value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string';
}

function validateRelativeSourceMap(
  module: ShaderModule,
  sourceMap: readonly ShaderGeneratedSourceSpan[],
  code: string,
): readonly ShaderGeneratedSourceSpan[] {
  const lineCount = code.split('\n').length;
  return Object.freeze(sourceMap.map((span, index) => {
    if (!span || typeof span.sourceId !== 'string' || !span.sourceId.trim()
      || typeof span.sourceName !== 'string' || !span.sourceName.trim()
      || /[\r\n]/.test(span.sourceName)
      || !Number.isInteger(span.generatedStartLine) || !Number.isInteger(span.generatedEndLine)
      || span.generatedStartLine < 1 || span.generatedEndLine < span.generatedStartLine
      || span.generatedEndLine > lineCount
      || (span.sourceStartLine !== undefined && (!Number.isInteger(span.sourceStartLine) || span.sourceStartLine < 1))
      || (span.sourceStartColumn !== undefined && (!Number.isInteger(span.sourceStartColumn) || span.sourceStartColumn < 1))) {
      shaderError('E_SHADER_SOURCE_GENERATION_FAILED', `Module ${module.id} returned an invalid source-map span.`, {
        moduleId: module.id,
        path: `source.sourceMap.${index}`,
        details: { span, lineCount },
      });
    }
    return Object.freeze({ ...span });
  }));
}
