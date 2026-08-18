import type {
  ShaderCapabilityProfile,
  ShaderModule,
  ShaderTarget,
} from './contracts';
import { shaderError } from './diagnostics';
import { compareStableText, moduleSymbolName } from './naming';

export interface LinkedShaderModules {
  readonly modules: readonly ShaderModule[];
  readonly requiredCapabilities: readonly string[];
  readonly symbolNames: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export function linkShaderModules(
  entry: ShaderModule,
  target: ShaderTarget,
  profile: ShaderCapabilityProfile,
  availableCapabilities: readonly string[],
): LinkedShaderModules {
  const modules = resolveModules(entry);
  validateTargetsAndProfiles(modules, target, profile);
  validateImports(modules);
  return Object.freeze({
    modules,
    requiredCapabilities: Object.freeze(validateCapabilities(modules, target, profile, availableCapabilities)),
    symbolNames: createSymbolNames(modules),
  });
}

function resolveModules(entry: ShaderModule): readonly ShaderModule[] {
  const ordered: ShaderModule[] = [];
  const visiting = new Set<string>();
  const visited = new Map<string, ShaderModule>();

  const visit = (module: ShaderModule, path: readonly string[]): void => {
    const previous = visited.get(module.id);
    if (previous) {
      if (previous !== module) {
        shaderError('E_SHADER_MODULE_ID_CONFLICT', `Shader module id ${module.id} resolves to multiple definitions.`, {
          moduleId: module.id,
          details: { path },
        });
      }
      return;
    }
    if (visiting.has(module.id)) {
      shaderError('E_SHADER_DEPENDENCY_CYCLE', `Shader module dependency cycle: ${[...path, module.id].join(' -> ')}.`, {
        moduleId: module.id,
        details: { cycle: [...path, module.id] },
      });
    }
    visiting.add(module.id);
    for (const dependency of [...module.dependencies].sort((left, right) => compareStableText(left.id, right.id))) {
      visit(dependency, [...path, module.id]);
    }
    visiting.delete(module.id);
    visited.set(module.id, module);
    ordered.push(module);
  };
  visit(entry, []);
  return Object.freeze(ordered);
}

function validateTargetsAndProfiles(
  modules: readonly ShaderModule[],
  target: ShaderTarget,
  profile: ShaderCapabilityProfile,
): void {
  for (const module of modules) {
    if (!module.targets.includes(target)) {
      shaderError('E_SHADER_TARGET_UNSUPPORTED', `Module ${module.id} does not support target ${target}.`, {
        moduleId: module.id,
        path: 'targets',
        details: { target, supported: module.targets },
      });
    }
    if (!module.profiles.includes(profile)) {
      shaderError('E_SHADER_TARGET_UNSUPPORTED', `Module ${module.id} does not support profile ${profile}.`, {
        moduleId: module.id,
        path: 'profiles',
        details: { profile, supported: module.profiles },
      });
    }
  }
}

function validateImports(modules: readonly ShaderModule[]): void {
  const byId = new Map(modules.map(module => [module.id, module]));
  for (const module of modules) {
    const directDependencies = new Set(module.dependencies.map(dependency => dependency.id));
    for (const imported of module.imports) {
      if (!directDependencies.has(imported.from)) {
        shaderError('E_SHADER_IMPORT_MISSING', `Module ${module.id} imports ${imported.from}.${imported.symbol} without a direct dependency.`, {
          moduleId: module.id,
          path: `imports.${imported.from}.${imported.symbol}`,
        });
      }
      const provider = byId.get(imported.from);
      const symbol = provider?.symbols.find(candidate =>
        candidate.id === imported.symbol && candidate.visibility === 'export');
      if (!provider || !symbol) {
        shaderError('E_SHADER_IMPORT_MISSING', `Module ${module.id} imports missing export ${imported.from}.${imported.symbol}.`, {
          moduleId: module.id,
          path: `imports.${imported.from}.${imported.symbol}`,
        });
      }
      for (const stage of imported.stages) {
        if (!module.stages.includes(stage) || !symbol.stages.includes(stage)) {
          shaderError('E_SHADER_STAGE_MISMATCH', `Import ${imported.from}.${imported.symbol} is not available to ${module.id} in ${stage}.`, {
            moduleId: module.id,
            path: `imports.${imported.from}.${imported.symbol}.stages`,
            details: { stage, providerStages: symbol.stages, consumerStages: module.stages },
          });
        }
      }
    }
  }
}

function validateCapabilities(
  modules: readonly ShaderModule[],
  target: ShaderTarget,
  profile: ShaderCapabilityProfile,
  availableCapabilities: readonly string[],
): string[] {
  const available = new Set<string>([
    `target.${target}`,
    `profile.${profile}`,
    ...availableCapabilities,
    ...modules.flatMap(module => module.provides),
  ]);
  for (const module of modules) {
    for (const required of module.requires) {
      if (!available.has(required)) {
        shaderError('E_SHADER_CAPABILITY_MISSING', `Module ${module.id} requires unavailable capability ${required}.`, {
          moduleId: module.id,
          path: 'requires',
          details: { required, available: [...available].sort() },
        });
      }
    }
    for (const conflict of module.conflicts) {
      if (available.has(conflict)) {
        shaderError('E_SHADER_CAPABILITY_CONFLICT', `Module ${module.id} conflicts with capability ${conflict}.`, {
          moduleId: module.id,
          path: 'conflicts',
          details: { conflict },
        });
      }
    }
  }
  return [...new Set(modules.flatMap(module => module.requires))].sort();
}

function createSymbolNames(modules: readonly ShaderModule[]): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const result = new Map<string, ReadonlyMap<string, string>>();
  const physicalOwners = new Map<string, string>();
  for (const module of modules) {
    const names = new Map<string, string>();
    for (const symbol of module.symbols) {
      const physical = moduleSymbolName(module.id, symbol.id);
      const owner = physicalOwners.get(physical);
      if (owner) {
        shaderError('E_SHADER_SYMBOL_INVALID', `Physical symbol ${physical} collides between ${owner} and ${module.id}.${symbol.id}.`, {
          moduleId: module.id,
          details: { physical, owner },
        });
      }
      physicalOwners.set(physical, `${module.id}.${symbol.id}`);
      names.set(symbol.id, physical);
    }
    result.set(module.id, names);
  }
  return result;
}
