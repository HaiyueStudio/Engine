import { shaderError } from '../diagnostics';
import type { ShaderIrBuilder, ShaderIrSource, ShaderIrValue } from '../ir/contracts';
import {
  shaderIrValueTypeKey,
  shaderIrValueTypesEqual,
  shaderValueType,
  type ShaderIrValueType,
} from '../ir/types';

export const MATERIAL_SURFACE_V1_SLOTS = [
  'baseColor',
  'opacity',
  'normalTS',
  'metallic',
  'roughness',
  'occlusion',
  'emissive',
  'transmission',
  'thickness',
  'clearcoat',
  'clearcoatRoughness',
  'clearcoatNormalTS',
  'sheenColor',
  'sheenRoughness',
] as const;

export type MaterialSurfaceV1Slot = typeof MATERIAL_SURFACE_V1_SLOTS[number];
export type MaterialSurfaceV1Values = Readonly<Record<MaterialSurfaceV1Slot, ShaderIrValue>>;

const COLOR3_LINEAR = shaderValueType({ dataType: 'vec3<f32>', semantic: 'color', colorSpace: 'linear' });
const NORMAL_TANGENT = shaderValueType({ dataType: 'vec3<f32>', semantic: 'normal', coordinateSpace: 'tangent' });
const SCALAR = shaderValueType('f32');

export const MATERIAL_SURFACE_V1_TYPES: Readonly<Record<MaterialSurfaceV1Slot, ShaderIrValueType>> = Object.freeze({
  baseColor: COLOR3_LINEAR,
  opacity: SCALAR,
  normalTS: NORMAL_TANGENT,
  metallic: SCALAR,
  roughness: SCALAR,
  occlusion: SCALAR,
  emissive: COLOR3_LINEAR,
  transmission: SCALAR,
  thickness: SCALAR,
  clearcoat: SCALAR,
  clearcoatRoughness: SCALAR,
  clearcoatNormalTS: NORMAL_TANGENT,
  sheenColor: COLOR3_LINEAR,
  sheenRoughness: SCALAR,
});

const UNIT_SLOTS = new Set<MaterialSurfaceV1Slot>([
  'opacity', 'metallic', 'roughness', 'occlusion', 'transmission',
  'clearcoat', 'clearcoatRoughness', 'sheenRoughness',
]);

export function lowerMaterialSurfaceV1(
  builder: ShaderIrBuilder,
  authored: Readonly<Partial<Record<MaterialSurfaceV1Slot, ShaderIrValue>>>,
  sourceForSlot: (slot: MaterialSurfaceV1Slot) => ShaderIrSource,
): MaterialSurfaceV1Values {
  const unknown = Object.keys(authored).filter(key => !(MATERIAL_SURFACE_V1_SLOTS as readonly string[]).includes(key));
  if (unknown.length > 0) surfaceError(`Unknown MaterialSurface v1 slot ${unknown[0]}.`, `outputs.${unknown[0]}`);
  const defaults = createDefaults(builder);
  const values = {} as Record<MaterialSurfaceV1Slot, ShaderIrValue>;
  for (const slot of MATERIAL_SURFACE_V1_SLOTS) {
    const source = sourceForSlot(slot);
    const value = authored[slot] ?? defaults[slot];
    const expected = MATERIAL_SURFACE_V1_TYPES[slot];
    if (!shaderIrValueTypesEqual(value.type, expected)) {
      surfaceError(`MaterialSurface.${slot} expects ${shaderIrValueTypeKey(expected)}, got ${shaderIrValueTypeKey(value.type)}.`, `outputs.${slot}`, {
        slot,
        expected: shaderIrValueTypeKey(expected),
        actual: shaderIrValueTypeKey(value.type),
      });
    }
    if (slot === 'normalTS' || slot === 'clearcoatNormalTS') {
      values[slot] = builder.normalize(value, source);
    } else if (UNIT_SLOTS.has(slot)) {
      values[slot] = builder.clamp(value, builder.literal('f32', 0, source), builder.literal('f32', 1, source), source);
    } else if (slot === 'thickness') {
      values[slot] = builder.clamp(value, builder.literal('f32', 0, source), builder.literal('f32', 65504, source), source);
    } else {
      values[slot] = value;
    }
  }
  return Object.freeze(values);
}

function createDefaults(builder: ShaderIrBuilder): MaterialSurfaceV1Values {
  const source: ShaderIrSource = Object.freeze({ sourceId: '@material-surface.defaults', sourceName: 'material-surface-v1' });
  return Object.freeze({
    baseColor: builder.literal(COLOR3_LINEAR, [1, 1, 1], source),
    opacity: builder.literal('f32', 1, source),
    normalTS: builder.literal(NORMAL_TANGENT, [0, 0, 1], source),
    metallic: builder.literal('f32', 0, source),
    roughness: builder.literal('f32', 1, source),
    occlusion: builder.literal('f32', 1, source),
    emissive: builder.literal(COLOR3_LINEAR, [0, 0, 0], source),
    transmission: builder.literal('f32', 0, source),
    thickness: builder.literal('f32', 0, source),
    clearcoat: builder.literal('f32', 0, source),
    clearcoatRoughness: builder.literal('f32', 0, source),
    clearcoatNormalTS: builder.literal(NORMAL_TANGENT, [0, 0, 1], source),
    sheenColor: builder.literal(COLOR3_LINEAR, [0, 0, 0], source),
    sheenRoughness: builder.literal('f32', 0, source),
  });
}

function surfaceError(message: string, path: string, details?: Readonly<Record<string, unknown>>): never {
  shaderError('E_SHADER_SURFACE_INVALID', message, {
    moduleId: '@material-surface-v1',
    path,
    ...(details === undefined ? {} : { details }),
  });
}

