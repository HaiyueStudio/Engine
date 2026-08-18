import type {
  ShaderCapabilityProfile,
  ShaderModule,
  ShaderResourceDefinition,
  ShaderSpecializationDefinition,
  ShaderTarget,
} from './contracts';
import { compileShaderIrProgramToWgsl } from './backend/wgsl';
import type { ShaderIrEntryDefinition, ShaderIrProgram } from './ir/contracts';
import { defineShaderIrProgram } from './ir/program';
import { defineShaderModule } from './module';

export interface TypedShaderModuleDefinition {
  readonly id: string;
  readonly version?: number;
  readonly sourceName?: string;
  readonly resources?: readonly ShaderResourceDefinition[];
  readonly entries: readonly ShaderIrEntryDefinition[];
  readonly requires?: readonly string[];
  readonly provides?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly targets?: readonly ShaderTarget[];
  readonly profiles?: readonly ShaderCapabilityProfile[];
  readonly passRequirements?: readonly string[];
  readonly specializations?: readonly ShaderSpecializationDefinition[];
}

export interface TypedShaderModule {
  readonly ir: ShaderIrProgram;
  readonly module: ShaderModule;
}

export function defineTypedShaderModule(definition: TypedShaderModuleDefinition): TypedShaderModule {
  const ir = defineShaderIrProgram({
    id: definition.id,
    resources: definition.resources ?? [],
    entries: definition.entries,
  });
  const stages = Object.freeze([...new Set(ir.entries.map(entry => entry.stage))]);
  const module = defineShaderModule({
    id: definition.id,
    ...(definition.version === undefined ? {} : { version: definition.version }),
    sourceName: definition.sourceName ?? `${definition.id}.typed.wgsl`,
    stages,
    resources: ir.resources,
    entryPoints: ir.entries.map(entry => ({ id: entry.id, stage: entry.stage, name: entry.name })),
    requires: definition.requires ?? [],
    provides: definition.provides ?? [],
    conflicts: definition.conflicts ?? [],
    targets: definition.targets ?? ['webgpu-wgsl'],
    profiles: definition.profiles ?? ['webgpu-portable', 'webgpu-enhanced'],
    passRequirements: definition.passRequirements ?? [],
    specializations: definition.specializations ?? [],
    source: context => {
      const generated = compileShaderIrProgramToWgsl(ir, {
        resource: id => context.resource(id),
        uniformField: (resourceId, fieldId) => context.uniformField(resourceId, fieldId),
      });
      return Object.freeze({ code: generated.code, sourceMap: generated.sourceMap });
    },
  });
  return Object.freeze({ ir, module });
}
