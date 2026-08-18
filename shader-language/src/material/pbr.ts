import { shaderError } from '../diagnostics';
import type { ShaderIrBuilder, ShaderIrSource, ShaderIrValue } from '../ir/contracts';
import type { MaterialSurfaceV1Slot, MaterialSurfaceV1Values } from './surface';

const CONSUMED_SURFACE_SLOTS = Object.freeze([
  'baseColor',
  'opacity',
  'normalTS',
  'metallic',
  'roughness',
  'occlusion',
  'emissive',
] as const satisfies readonly MaterialSurfaceV1Slot[]);

const UNSUPPORTED_SURFACE_SLOTS = Object.freeze([
  'transmission',
  'thickness',
  'clearcoat',
  'clearcoatRoughness',
  'clearcoatNormalTS',
  'sheenColor',
  'sheenRoughness',
] as const satisfies readonly MaterialSurfaceV1Slot[]);

const REQUIRED_CAPABILITY_BY_SLOT = Object.freeze({
  transmission: 'framebuffer-transmission',
  thickness: 'volume-thickness',
  clearcoat: 'clearcoat',
  clearcoatRoughness: 'clearcoat',
  clearcoatNormalTS: 'clearcoat',
  sheenColor: 'sheen',
  sheenRoughness: 'sheen',
} as const satisfies Readonly<Record<typeof UNSUPPORTED_SURFACE_SLOTS[number], string>>);

/**
 * Machine-readable truth table for MaterialSurface v1 slots in the generic
 * metallic-roughness graph lowering. A valid Surface slot must appear in
 * exactly one list: consumed, or rejected with the stable diagnostic below.
 */
export const METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT = Object.freeze({
  lightingModel: 'metallic-roughness',
  loweringVersion: 1,
  consumedSlots: CONSUMED_SURFACE_SLOTS,
  unsupportedSlots: UNSUPPORTED_SURFACE_SLOTS,
  unsupportedDiagnosticCode: 'E_SHADER_SURFACE_UNSUPPORTED' as const,
});

export function assertMetallicRoughnessPbrV1SurfaceOutputsSupported(
  authoredSlots: readonly MaterialSurfaceV1Slot[],
): void {
  const unsupportedSlot = authoredSlots.find((slot): slot is typeof UNSUPPORTED_SURFACE_SLOTS[number] => (
    (UNSUPPORTED_SURFACE_SLOTS as readonly MaterialSurfaceV1Slot[]).includes(slot)
  ));
  if (unsupportedSlot === undefined) return;
  shaderError(
    'E_SHADER_SURFACE_UNSUPPORTED',
    `MaterialSurface.${unsupportedSlot} is valid in Surface v1 but is not consumed by metallic-roughness graph lowering v1. Remove outputs.${unsupportedSlot} or use an advanced-PBR lowering; it cannot be silently ignored.`,
    {
      moduleId: '@lighting.metallic-roughness',
      path: `outputs.${unsupportedSlot}`,
      details: Object.freeze({
        slot: unsupportedSlot,
        lightingModel: 'metallic-roughness',
        loweringVersion: 1,
        status: 'unsupported',
        requiredCapability: REQUIRED_CAPABILITY_BY_SLOT[unsupportedSlot],
      }),
    },
  );
}

export interface MaterialPbrGeometryValues {
  readonly worldPosition: ShaderIrValue;
  readonly worldNormal: ShaderIrValue;
  readonly worldTangent?: ShaderIrValue;
  readonly tangentSign?: ShaderIrValue;
}

export interface MaterialPbrSceneValues {
  readonly cameraPosition: ShaderIrValue;
  readonly lightDirection: ShaderIrValue;
  readonly lightColor: ShaderIrValue;
  readonly ambientColor: ShaderIrValue;
  readonly fogColor: ShaderIrValue;
  readonly fogStart: ShaderIrValue;
  readonly fogEnd: ShaderIrValue;
}

export function lowerMetallicRoughnessPbr(
  builder: ShaderIrBuilder,
  surface: MaterialSurfaceV1Values,
  geometry: MaterialPbrGeometryValues,
  scene: MaterialPbrSceneValues,
  fogEnabled: boolean,
): ShaderIrValue {
  const lightingSource: ShaderIrSource = Object.freeze({
    sourceId: '@lighting.metallic-roughness',
    sourceName: 'material/pbr.ts',
  });
  const fogSource: ShaderIrSource = Object.freeze({
    sourceId: 'scene.fog',
    sourceName: 'material/pbr.ts',
  });
  const scalar = (value: number, source = lightingSource): ShaderIrValue => builder.literal('f32', value, source);
  const color = (values: readonly number[], source = lightingSource): ShaderIrValue => builder.literal({
    dataType: 'vec3<f32>', semantic: 'color', colorSpace: 'linear',
  }, values, source);

  const worldNormal = lowerWorldNormal(builder, surface, geometry, lightingSource);
  const normalDirection = builder.withSemantic(worldNormal, {
    dataType: 'vec3<f32>', semantic: 'direction', coordinateSpace: 'world',
  }, lightingSource);
  const viewDirection = builder.normalize(builder.subtract(scene.cameraPosition, geometry.worldPosition, lightingSource), lightingSource);
  const lightDirection = builder.normalize(scene.lightDirection, lightingSource);
  const halfDirection = builder.normalize(builder.add(viewDirection, lightDirection, lightingSource), lightingSource);
  const nDotL = saturate(builder, builder.dot(normalDirection, lightDirection, lightingSource), lightingSource);
  const nDotV = saturate(builder, builder.dot(normalDirection, viewDirection, lightingSource), lightingSource);
  const nDotH = saturate(builder, builder.dot(normalDirection, halfDirection, lightingSource), lightingSource);
  const vDotH = saturate(builder, builder.dot(viewDirection, halfDirection, lightingSource), lightingSource);

  const one = scalar(1);
  const roughnessSquared = builder.multiply(surface.roughness, surface.roughness, lightingSource);
  const alphaSquared = builder.multiply(roughnessSquared, roughnessSquared, lightingSource);
  const nDotHSquared = builder.multiply(nDotH, nDotH, lightingSource);
  const distributionBase = builder.add(builder.multiply(nDotHSquared, builder.subtract(alphaSquared, one, lightingSource), lightingSource), one, lightingSource);
  const distribution = builder.divide(alphaSquared, builder.multiply(scalar(Math.PI), builder.multiply(distributionBase, distributionBase, lightingSource), lightingSource), lightingSource);

  const geometryKBase = builder.add(surface.roughness, one, lightingSource);
  const geometryK = builder.divide(builder.multiply(geometryKBase, geometryKBase, lightingSource), scalar(8), lightingSource);
  const geometryV = geometrySchlick(builder, nDotV, geometryK, lightingSource);
  const geometryL = geometrySchlick(builder, nDotL, geometryK, lightingSource);
  const geometryTerm = builder.multiply(geometryV, geometryL, lightingSource);

  const oneColor = color([1, 1, 1]);
  const f0 = builder.mix(color([0.04, 0.04, 0.04]), surface.baseColor, surface.metallic, lightingSource);
  const fresnelPower = builder.pow(builder.subtract(one, vDotH, lightingSource), scalar(5), lightingSource);
  const fresnel = builder.add(f0, builder.multiply(builder.subtract(oneColor, f0, lightingSource), fresnelPower, lightingSource), lightingSource);
  const specularNumerator = builder.multiply(fresnel, builder.multiply(distribution, geometryTerm, lightingSource), lightingSource);
  const specularDenominator = builder.clamp(
    builder.multiply(scalar(4), builder.multiply(nDotV, nDotL, lightingSource), lightingSource),
    scalar(0.001),
    scalar(4),
    lightingSource,
  );
  const specular = builder.divide(specularNumerator, specularDenominator, lightingSource);
  const diffuseWeight = builder.multiply(builder.subtract(oneColor, fresnel, lightingSource), builder.subtract(one, surface.metallic, lightingSource), lightingSource);
  const diffuse = builder.divide(builder.multiply(builder.multiply(diffuseWeight, surface.baseColor, lightingSource), nDotL, lightingSource), scalar(Math.PI), lightingSource);
  const direct = builder.multiply(builder.add(diffuse, builder.multiply(specular, nDotL, lightingSource), lightingSource), scene.lightColor, lightingSource);
  const ambient = builder.multiply(builder.multiply(surface.baseColor, scene.ambientColor, lightingSource), surface.occlusion, lightingSource);
  let lit = builder.add(builder.add(direct, ambient, lightingSource), surface.emissive, lightingSource);

  if (fogEnabled) {
    const cameraVector = builder.subtract(scene.cameraPosition, geometry.worldPosition, fogSource);
    const distance = builder.sqrt(builder.dot(cameraVector, cameraVector, fogSource), fogSource);
    const factor = saturate(builder, builder.divide(
      builder.subtract(scene.fogEnd, distance, fogSource),
      builder.subtract(scene.fogEnd, scene.fogStart, fogSource),
      fogSource,
    ), fogSource);
    lit = builder.mix(scene.fogColor, lit, factor, fogSource);
  }
  return builder.construct({
    dataType: 'vec4<f32>', semantic: 'color', colorSpace: 'linear',
  }, [lit, surface.opacity], lightingSource);
}

function lowerWorldNormal(
  builder: ShaderIrBuilder,
  surface: MaterialSurfaceV1Values,
  geometry: MaterialPbrGeometryValues,
  source: ShaderIrSource,
): ShaderIrValue {
  if (!geometry.worldTangent || !geometry.tangentSign) return builder.normalize(geometry.worldNormal, source);
  const normalDirection = builder.withSemantic(geometry.worldNormal, {
    dataType: 'vec3<f32>', semantic: 'direction', coordinateSpace: 'world',
  }, source);
  const tangent = builder.normalize(geometry.worldTangent, source);
  const bitangent = builder.multiply(builder.normalize(builder.cross(normalDirection, tangent, source), source), geometry.tangentSign, source);
  const x = builder.multiply(tangent, builder.swizzle(surface.normalTS, 'x', source), source);
  const y = builder.multiply(bitangent, builder.swizzle(surface.normalTS, 'y', source), source);
  const z = builder.multiply(normalDirection, builder.swizzle(surface.normalTS, 'z', source), source);
  const direction = builder.normalize(builder.add(builder.add(x, y, source), z, source), source);
  return builder.withSemantic(direction, {
    dataType: 'vec3<f32>', semantic: 'normal', coordinateSpace: 'world',
  }, source);
}

function geometrySchlick(
  builder: ShaderIrBuilder,
  nDot: ShaderIrValue,
  k: ShaderIrValue,
  source: ShaderIrSource,
): ShaderIrValue {
  const one = builder.literal('f32', 1, source);
  return builder.divide(nDot, builder.add(builder.multiply(nDot, builder.subtract(one, k, source), source), k, source), source);
}

function saturate(builder: ShaderIrBuilder, value: ShaderIrValue, source: ShaderIrSource): ShaderIrValue {
  return builder.clamp(value, builder.literal('f32', 0, source), builder.literal('f32', 1, source), source);
}
