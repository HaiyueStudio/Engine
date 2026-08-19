import type { RayAccelerationSnapshot } from '../acceleration/index.js';
import type { RayPackedMaterialScene } from '../material/index.js';
import type { RayPathSceneFacts } from '../renderer/index.js';
import { RAY_PROGRESSIVE_SEQUENCE_ID } from './types.js';
import type { RayProgressiveAccumulationKey, RayProgressiveFrameRevision, RayProgressiveResetReason } from './types.js';

const RESET_ORDER: readonly RayProgressiveResetReason[] = Object.freeze(['initial', 'explicit', 'scene-owner', 'geometry', 'membership', 'transform', 'material', 'camera', 'light', 'viewport', 'quality', 'sampling', 'denoise', 'renderer', 'device']);

export function createRayProgressiveFrameRevision(
  acceleration: RayAccelerationSnapshot,
  materials: RayPackedMaterialScene,
  facts: RayPathSceneFacts,
): RayProgressiveFrameRevision {
  const geometry = fingerprint([...acceleration.blases.values()].sort((a, b) => a.key.localeCompare(b.key)).flatMap(blas => [blas.key, blas.fingerprint]));
  const light = fingerprint([facts.environment.revision, ...facts.lights.map(value => value.revision)]);
  return Object.freeze({
    sceneOwner: `world:${acceleration.source.sourceRevision.worldId}`,
    acceleration: acceleration.packed.fingerprint,
    geometry,
    membership: acceleration.tlas.membershipFingerprint,
    transform: acceleration.tlas.transformFingerprint,
    material: materials.fingerprint,
    camera: facts.camera.revision,
    light,
  });
}

export function createRayProgressiveAccumulationKey(
  revision: RayProgressiveFrameRevision,
  viewport: Readonly<{ width: number; height: number }>,
  quality: Readonly<{ revision: string; maxBounces: number }>,
  sampling: Readonly<{ baseSeed: number }>,
  denoiseRevision: string,
): RayProgressiveAccumulationKey {
  return Object.freeze({ ...revision, viewport: `${viewport.width}x${viewport.height}`, quality: `${quality.revision}:${quality.maxBounces}`, sampling: `${RAY_PROGRESSIVE_SEQUENCE_ID}:${sampling.baseSeed}`, denoise: denoiseRevision });
}

export function classifyRayProgressiveReset(
  previous: RayProgressiveAccumulationKey | null,
  next: RayProgressiveAccumulationKey,
  pending: ReadonlySet<RayProgressiveResetReason> = new Set(),
): readonly RayProgressiveResetReason[] {
  const reasons = new Set<RayProgressiveResetReason>();
  if (!previous) reasons.add('initial'); else {
    if (previous.sceneOwner !== next.sceneOwner) reasons.add('scene-owner'); if (previous.geometry !== next.geometry) reasons.add('geometry');
    if (previous.membership !== next.membership) reasons.add('membership'); if (previous.transform !== next.transform) reasons.add('transform');
    if (previous.material !== next.material) reasons.add('material'); if (previous.camera !== next.camera) reasons.add('camera'); if (previous.light !== next.light) reasons.add('light');
    if (previous.viewport !== next.viewport) reasons.add('viewport'); if (previous.quality !== next.quality) reasons.add('quality'); if (previous.sampling !== next.sampling) reasons.add('sampling'); if (previous.denoise !== next.denoise) reasons.add('denoise');
  }
  for (const reason of pending) reasons.add(reason);
  return Object.freeze(RESET_ORDER.filter(reason => reasons.has(reason)));
}

function fingerprint(values: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of values.join('\u001f')) { hash ^= BigInt(character.charCodeAt(0)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}
