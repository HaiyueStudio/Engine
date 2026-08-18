import type {
  ShaderModule,
  ShaderSpecializationDefinition,
  ShaderSpecializationValue,
} from './contracts';
import { shaderError } from './diagnostics';
import { validateSpecializationValue } from './module';
import { compareStableText } from './naming';

export interface ResolvedSpecialization {
  readonly definition: ShaderSpecializationDefinition;
  readonly value: ShaderSpecializationValue;
  readonly moduleIds: readonly string[];
}

export function resolveShaderSpecializations(
  modules: readonly ShaderModule[],
  values: Readonly<Record<string, ShaderSpecializationValue>>,
): ReadonlyMap<string, ResolvedSpecialization> {
  const collected = new Map<string, { definition: ShaderSpecializationDefinition; moduleIds: Set<string> }>();
  for (const module of modules) {
    for (const definition of module.specializations) {
      const existing = collected.get(definition.id);
      if (existing) {
        if (existing.definition.type !== definition.type || existing.definition.defaultValue !== definition.defaultValue) {
          shaderError('E_SHADER_SPECIALIZATION_INVALID', `Specialization ${definition.id} has incompatible declarations.`, {
            moduleId: module.id,
            path: `specializations.${definition.id}`,
            details: { owners: [...existing.moduleIds, module.id] },
          });
        }
        existing.moduleIds.add(module.id);
      } else {
        collected.set(definition.id, { definition, moduleIds: new Set([module.id]) });
      }
    }
  }
  for (const id of Object.keys(values)) {
    if (!collected.has(id)) {
      shaderError('E_SHADER_SPECIALIZATION_INVALID', `Unknown specialization override ${id}.`, {
        path: `specializationValues.${id}`,
      });
    }
  }
  const resolved = new Map<string, ResolvedSpecialization>();
  for (const [id, entry] of [...collected.entries()].sort(([left], [right]) => compareStableText(left, right))) {
    const value = values[id] ?? entry.definition.defaultValue;
    validateSpecializationValue(entry.definition.type, value, [...entry.moduleIds][0] ?? '@composition', `specializationValues.${id}`);
    resolved.set(id, Object.freeze({
      definition: entry.definition,
      value,
      moduleIds: Object.freeze([...entry.moduleIds].sort()),
    }));
  }
  return resolved;
}

export function generateSpecializationSource(
  specializations: ReadonlyMap<string, ResolvedSpecialization>,
  names: ReadonlyMap<string, string>,
): string {
  return [...specializations.entries()].map(([id, entry]) => {
    const name = names.get(id);
    if (!name) shaderError('E_SHADER_SPECIALIZATION_INVALID', `Specialization ${id} has no physical name.`);
    return `const ${name} : ${entry.definition.type} = ${formatSpecializationValue(entry.definition.type, entry.value)};`;
  }).join('\n');
}

export function formatSpecializationValue(
  type: ShaderSpecializationDefinition['type'],
  value: ShaderSpecializationValue,
): string {
  if (type === 'bool') return value ? 'true' : 'false';
  const numeric = value as number;
  if (type === 'u32') return `${numeric}u`;
  if (type === 'i32') return `${numeric}i`;
  return Number.isInteger(numeric) ? `${numeric}.0` : String(numeric);
}
