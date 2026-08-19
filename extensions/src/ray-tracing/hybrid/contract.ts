import { RAY_ACCELERATION_ABI_FINGERPRINT, validatePackedAcceleration } from '../acceleration/index.js';
import { hybridDiagnostic } from './diagnostics.js';
import type { RayHybridAoOptions, RayHybridDiagnostic, RayHybridEffect, RayHybridFrameContract, RayHybridFrameInputs, RayHybridOptions, RayHybridReflectionOptions, RayHybridResolvedEffect, RayHybridShadowOptions } from './types.js';

const EFFECTS = Object.freeze(['shadow', 'reflection', 'ao'] as const);
export function createRayHybridFrameContract(inputs: RayHybridFrameInputs, options: RayHybridOptions = {}): RayHybridFrameContract {
  const diagnostics: RayHybridDiagnostic[] = [];
  validateInputs(inputs, diagnostics); validateCoexistence(inputs, options, diagnostics);
  if ((options.transparentPolicy ?? 'skip') !== 'skip') diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_TRANSPARENT_POLICY_UNSUPPORTED', 'Hybrid ray effects V1 only supports transparentPolicy="skip".', {}));
  if (!['composite', 'shadow', 'reflection', 'ao'].includes(options.debugView ?? 'composite')) diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_DEBUG_VIEW_UNSUPPORTED', 'Hybrid debugView is unsupported.', { debugView: String(options.debugView) }));
  if (!['linear', 'srgb'].includes(options.sceneColorSpace ?? 'linear')) diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_COLOR_SPACE_UNSUPPORTED', 'sceneColorSpace must be linear or srgb.', { sceneColorSpace: String(options.sceneColorSpace) }));
  const preferExisting = options.reflection?.enabled && (inputs.existingEffects?.planarReflection || inputs.existingEffects?.ssr) && options.coexistence?.reflection === 'prefer-existing';
  if (preferExisting) diagnostics.push(hybridDiagnostic('reflection', 'info', 'RAY_HYBRID_REFLECTION_PREFER_EXISTING', 'Explicit prefer-existing policy bypassed ray reflection for this frame.', {}));
  const effects = Object.freeze({ shadow: resolve('shadow', inputs, options.shadow ?? {}, diagnostics), reflection: resolve('reflection', inputs, preferExisting ? { ...options.reflection, enabled: false } : options.reflection ?? {}, diagnostics), ao: resolve('ao', inputs, options.ao ?? {}, diagnostics) });
  const failed = diagnostics.some(entry => entry.severity === 'error'); const anyEnabled = EFFECTS.some(effect => effects[effect].enabled);
  return Object.freeze({ status: failed ? 'failed' : anyEnabled ? 'ready' : 'bypassed', width: inputs.width, height: inputs.height, effects,
    debugView: options.debugView ?? 'composite', sceneColorSpace: options.sceneColorSpace ?? 'linear', diagnostics: Object.freeze(diagnostics) });
}
function validateInputs(inputs: RayHybridFrameInputs, diagnostics: RayHybridDiagnostic[]): void {
  if (!Number.isInteger(inputs.width) || inputs.width < 1 || !Number.isInteger(inputs.height) || inputs.height < 1) diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_SIZE_INVALID', 'Hybrid frame dimensions must be positive integers.', { width: inputs.width, height: inputs.height }));
  for (const [name, matrix] of [['inverseViewProjection', inputs.inverseViewProjection], ['viewProjection', inputs.viewProjection]] as const) if (matrix.length !== 16 || matrix.some(value => !Number.isFinite(value))) diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_MATRIX_INVALID', `${name} must contain 16 finite numbers.`, { matrix: name }));
  if (inputs.acceleration.abiFingerprint !== RAY_ACCELERATION_ABI_FINGERPRINT) diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_ACCELERATION_ABI_UNSUPPORTED', 'Acceleration ABI does not match the hybrid ray shader.', { expected: RAY_ACCELERATION_ABI_FINGERPRINT, actual: inputs.acceleration.abiFingerprint }));
  for (const entry of validatePackedAcceleration(inputs.acceleration)) diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_ACCELERATION_INVALID', entry.message, { accelerationCode: entry.code }));
}
function validateCoexistence(inputs: RayHybridFrameInputs, options: RayHybridOptions, diagnostics: RayHybridDiagnostic[]): void {
  const existing = inputs.existingEffects ?? {};
  if (options.shadow?.enabled && existing.shadowMap && options.coexistence?.shadowMap !== 'multiply') diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_SHADOW_MAP_CONFLICT', 'Ray shadow with an existing shadow map requires coexistence.shadowMap="multiply".', {}));
  if (options.ao?.enabled && existing.ssao && options.coexistence?.ssao !== 'multiply') diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_SSAO_CONFLICT', 'Ray AO with existing SSAO requires coexistence.ssao="multiply".', {}));
  if (options.reflection?.enabled && (existing.planarReflection || existing.ssr) && !options.coexistence?.reflection) diagnostics.push(hybridDiagnostic('admission', 'error', 'RAY_HYBRID_REFLECTION_CONFLICT', 'Ray reflection with planar reflection or SSR requires an explicit reflection coexistence policy.', { planarReflection: !!existing.planarReflection, ssr: !!existing.ssr }));
}
function resolve(effect: RayHybridEffect, inputs: RayHybridFrameInputs, raw: RayHybridShadowOptions | RayHybridReflectionOptions | RayHybridAoOptions, diagnostics: RayHybridDiagnostic[]): RayHybridResolvedEffect {
  const enabled = raw.enabled ?? false; const resolution = raw.resolution ?? 'half'; const width = resolution === 'half' ? Math.max(1, Math.ceil(inputs.width / 2)) : inputs.width; const height = resolution === 'half' ? Math.max(1, Math.ceil(inputs.height / 2)) : inputs.height;
  const raysPerPixel = raw.raysPerPixel ?? 1; const rayCount = width * height * raysPerPixel; const maxRaysPerFrame = raw.maxRaysPerFrame ?? 4_194_304;
  const temporalEnabled = raw.temporal?.enabled ?? true; const temporalFeedback = raw.temporal?.feedback ?? 0.15;
  if (!['full', 'half'].includes(resolution)) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_RESOLUTION_UNSUPPORTED', `${effect} resolution must be full or half.`, { effect, resolution }));
  if (![1, 2, 4].includes(raysPerPixel)) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_RAYS_PER_PIXEL_UNSUPPORTED', `${effect} raysPerPixel must be 1, 2, or 4.`, { effect, raysPerPixel }));
  if (enabled && rayCount > maxRaysPerFrame) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_RAY_BUDGET_EXCEEDED', `${effect} requires ${rayCount} rays, exceeding its explicit ${maxRaysPerFrame}-ray budget.`, { effect, required: rayCount, budget: maxRaysPerFrame }));
  if (!Number.isSafeInteger(maxRaysPerFrame) || maxRaysPerFrame < 1) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_RAY_BUDGET_INVALID', `${effect} maxRaysPerFrame must be a positive safe integer.`, { effect, maxRaysPerFrame }));
  if (!Number.isFinite(temporalFeedback) || temporalFeedback < 0 || temporalFeedback > 0.95) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_TEMPORAL_FEEDBACK_INVALID', `${effect} temporal feedback must be in [0, 0.95].`, { effect, temporalFeedback }));
  const parameters = effect === 'shadow' ? numeric({ bias: (raw as RayHybridShadowOptions).bias ?? 0.002, maxDistance: (raw as RayHybridShadowOptions).maxDistance ?? 100, strength: raw.strength ?? 1, angularRadius: (raw as RayHybridShadowOptions).angularRadius ?? 0 })
    : effect === 'reflection' ? numeric({ bias: (raw as RayHybridReflectionOptions).bias ?? 0.002, maxDistance: (raw as RayHybridReflectionOptions).maxDistance ?? 100, strength: raw.strength ?? 1, maxRoughness: (raw as RayHybridReflectionOptions).maxRoughness ?? 0.6 })
      : numeric({ bias: raw.bias ?? 0.002, radius: (raw as RayHybridAoOptions).radius ?? 1, strength: raw.strength ?? 1 });
  const parameterValues: Readonly<Record<string, number>> = parameters;
  for (const [parameter, value] of Object.entries(parameterValues)) if (!Number.isFinite(value) || value < 0) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_PARAMETER_INVALID', `${effect}.${parameter} must be finite and non-negative.`, { effect, parameter, value }));
  if (parameterValues.strength! > 1) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_STRENGTH_INVALID', `${effect}.strength must be in [0, 1].`, { effect, value: parameterValues.strength! }));
  const distance = effect === 'ao' ? parameterValues.radius! : parameterValues.maxDistance!;
  if (!(distance > 0)) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_DISTANCE_INVALID', `${effect} trace distance must be positive.`, { effect, value: distance }));
  if (effect === 'reflection' && (!(parameterValues.maxRoughness! > 0) || parameterValues.maxRoughness! > 1)) diagnostics.push(hybridDiagnostic(effect, 'error', 'RAY_HYBRID_MAX_ROUGHNESS_INVALID', 'reflection.maxRoughness must be in (0, 1].', { value: parameterValues.maxRoughness! }));
  const r = inputs.revision; const historyKey = [inputs.viewId, inputs.width, inputs.height, inputs.acceleration.fingerprint, r.scene, r.camera, r.depth, r.normal, r.material, r.sceneColor, resolution, raysPerPixel, temporalEnabled, temporalFeedback, ...Object.values(parameters)].join('|');
  return Object.freeze({ effect, enabled, resolution, width, height, raysPerPixel, rayCount, maxRaysPerFrame, temporalEnabled, temporalFeedback, historyKey, parameters });
}
function numeric<T extends Record<string, number>>(value: T): Readonly<T> { return Object.freeze(value); }
