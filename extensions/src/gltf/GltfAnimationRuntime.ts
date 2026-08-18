import { Entity, Geometry3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { mat4 } from 'wgpu-matrix';
import { GltfConservativeBounds } from './GltfConservativeBounds';
import { readAccessorFloat, requiredFiniteArrayValue } from './GltfAccessorReader';
import { gltfDataError } from './GltfLoaderErrors';
import type { GltfAsset } from './GltfSchema';
import type {
  GltfAnimationChannelRuntime,
  GltfAnimationClip,
  GltfAnimationPath,
  GltfAnimationTarget,
  GltfSkinnedPrimitiveRuntime,
} from './GltfLoaderContract';

const conservativeBoundsByGeometry = new WeakMap<Geometry3D, GltfConservativeBounds>();

export function registerGltfConservativeBounds(
  geometry: Geometry3D,
  bounds: GltfConservativeBounds,
): void {
  conservativeBoundsByGeometry.set(geometry, bounds);
}

export function createAnimationClips(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  targets: Map<number, GltfAnimationTarget>,
  skinnedPrimitives: GltfSkinnedPrimitiveRuntime[],
): GltfAnimationClip[] {
  return (gltf.animations ?? []).map((animation, index) => {
    const channels: GltfAnimationChannelRuntime[] = [];
    let duration = 0;
    for (const channel of animation.channels ?? []) {
      const sampler = animation.samplers?.[channel.sampler];
      const nodeIndex = channel.target.node;
      const path = channel.target.path;
      if (!sampler || nodeIndex === undefined || !isAnimationPath(path)) continue;
      const target = targets.get(nodeIndex);
      if (!target) continue;
      const input = readAccessorFloat(gltf, buffers, sampler.input, 1);
      const outputSize = path === 'weights' ? Math.max(target.weights.length, target.morphPrimitives[0]?.positionTargets.length ?? 0, 1) : path === 'rotation' ? 4 : 3;
      const output = path === 'weights'
        ? readAccessorFloat(gltf, buffers, sampler.output, 1)
        : readAccessorFloat(gltf, buffers, sampler.output, outputSize);
      duration = Math.max(duration, input[input.length - 1] ?? 0);
      channels.push({
        target,
        path,
        interpolation: sampler.interpolation ?? 'LINEAR',
        valueSize: outputSize,
        input,
        output,
        sampleA: new Float32Array(outputSize),
        sampleB: new Float32Array(outputSize),
        sampleOut: new Float32Array(outputSize),
        quatScratch: new Float32Array(4),
      });
    }
    return {
      name: animation.name || `Animation ${index + 1}`,
      duration,
      channels,
      skinnedPrimitives,
      stateCache: new Map(),
      activeStates: [],
    };
  });
}

function isAnimationPath(path: string | undefined): path is GltfAnimationPath {
  return path === 'translation' || path === 'rotation' || path === 'scale' || path === 'weights';
}

export function applyGltfAnimationClip(clip: GltfAnimationClip, time: number): void {
  if (clip.duration <= 0) return;
  const localTime = ((time % clip.duration) + clip.duration) % clip.duration;
  const states = clip.stateCache;
  const activeStates = clip.activeStates;
  activeStates.length = 0;
  for (const channel of clip.channels) {
    const value = sampleAnimationChannel(channel, localTime, channel.sampleOut);
    if (channel.path === 'weights') {
      applyMorphWeights(channel.target, value);
      continue;
    }
    let state = states.get(channel.target);
    if (!state) {
      state = {
        target: channel.target,
        translation: new Float32Array(3),
        rotation: new Float32Array(4),
        scale: new Float32Array(3),
        matrix: new Float32Array(16),
        active: false,
      };
      states.set(channel.target, state);
    }
    if (!state.active) {
      state.translation.set(channel.target.translation);
      state.rotation.set(channel.target.rotation);
      state.scale.set(channel.target.scale);
      state.active = true;
      activeStates.push(state);
    }
    if (channel.path === 'translation') copyComponents(value, state.translation, 3);
    else if (channel.path === 'scale') copyComponents(value, state.scale, 3);
    else normalizeQuat(value, state.rotation);
  }

  for (const state of activeStates) {
    state.target.transform.localMatrix = composeTrsMatrix(state.translation, state.rotation, state.scale, state.matrix);
    state.active = false;
  }

  for (const skinnedPrimitive of clip.skinnedPrimitives) {
    updateSkinnedPrimitive(skinnedPrimitive);
  }
}

function sampleAnimationChannel(channel: GltfAnimationChannelRuntime, time: number, out: Float32Array): Float32Array {
  const times = channel.input;
  const count = times.length;
  const componentCount = channel.valueSize;
  if (count === 0) {
    fillDefaultAnimationValue(out, componentCount);
    return out;
  }
  const firstTime = requiredFiniteArrayValue(times, 0, 'animation input');
  const lastTime = requiredFiniteArrayValue(times, count - 1, 'animation input');
  if (time <= firstTime) return readAnimationValue(channel, 0, componentCount, out);
  if (time >= lastTime) return readAnimationValue(channel, count - 1, componentCount, out);
  let frame = 0;
  while (frame + 1 < count && requiredFiniteArrayValue(times, frame + 1, 'animation input') < time) frame++;
  const t0 = requiredFiniteArrayValue(times, frame, 'animation input');
  const t1 = requiredFiniteArrayValue(times, frame + 1, 'animation input');
  const alpha = channel.interpolation === 'STEP' ? 0 : (time - t0) / Math.max(0.000001, t1 - t0);
  const a = readAnimationValue(channel, frame, componentCount, channel.sampleA);
  if (channel.interpolation === 'STEP') {
    copyComponents(a, out, componentCount);
    return out;
  }
  const b = readAnimationValue(channel, frame + 1, componentCount, channel.sampleB);
  if (channel.path === 'rotation') return slerpQuat(a, b, alpha, out, channel.quatScratch);
  return lerpArray(a, b, alpha, out, componentCount);
}

function readAnimationValue(channel: GltfAnimationChannelRuntime, frame: number, componentCount: number, out: Float32Array): Float32Array {
  const cubic = channel.interpolation === 'CUBICSPLINE';
  const stride = cubic ? componentCount * 3 : componentCount;
  const offset = frame * stride + (cubic ? componentCount : 0);
  for (let i = 0; i < componentCount; i++) out[i] = channel.output[offset + i] ?? (i === 3 ? 1 : 0);
  return out;
}

function fillDefaultAnimationValue(out: Float32Array, componentCount: number): void {
  for (let i = 0; i < componentCount; i++) out[i] = i === 3 ? 1 : 0;
}

function copyComponents(source: ArrayLike<number>, target: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) target[i] = source[i] ?? 0;
}

function lerpArray(a: ArrayLike<number>, b: ArrayLike<number>, alpha: number, out: Float32Array, componentCount: number): Float32Array {
  for (let i = 0; i < componentCount; i++) {
    const value = a[i] ?? 0;
    out[i] = value + ((b[i] ?? value) - value) * alpha;
  }
  return out;
}

function normalizeQuat(q: ArrayLike<number>, out: Float32Array): Float32Array {
  const qx = q[0] ?? 0;
  const qy = q[1] ?? 0;
  const qz = q[2] ?? 0;
  const qw = q[3] ?? 1;
  const len = Math.hypot(qx, qy, qz, qw) || 1;
  out[0] = qx / len;
  out[1] = qy / len;
  out[2] = qz / len;
  out[3] = qw / len;
  return out;
}

function slerpQuat(aRaw: ArrayLike<number>, bRaw: ArrayLike<number>, alpha: number, out: Float32Array, scratch: Float32Array): Float32Array {
  const a = normalizeQuat(aRaw, out);
  const b = normalizeQuat(bRaw, scratch);
  let bx = b[0] ?? 0;
  let by = b[1] ?? 0;
  let bz = b[2] ?? 0;
  let bw = b[3] ?? 1;
  const ax = a[0] ?? 0;
  const ay = a[1] ?? 0;
  const az = a[2] ?? 0;
  const aw = a[3] ?? 1;
  let dot = ax * bx + ay * by + az * bz + aw * bw;

  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  if (dot > 0.9995) {
    out[0] = ax + (bx - ax) * alpha;
    out[1] = ay + (by - ay) * alpha;
    out[2] = az + (bz - az) * alpha;
    out[3] = aw + (bw - aw) * alpha;
    return normalizeQuat(out, out);
  }

  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta0 = Math.sin(theta0);
  const theta = theta0 * alpha;
  const sinTheta = Math.sin(theta);
  const s0 = Math.cos(theta) - dot * sinTheta / sinTheta0;
  const s1 = sinTheta / sinTheta0;
  out[0] = ax * s0 + bx * s1;
  out[1] = ay * s0 + by * s1;
  out[2] = az * s0 + bz * s1;
  out[3] = aw * s0 + bw * s1;
  return normalizeQuat(out, out);
}

export function composeTrsMatrix(
  translation: ArrayLike<number>,
  rotation: ArrayLike<number>,
  scale: ArrayLike<number>,
  out = new Float32Array(16),
): Float32Array {
  const rx = rotation[0] ?? 0;
  const ry = rotation[1] ?? 0;
  const rz = rotation[2] ?? 0;
  const rw = rotation[3] ?? 1;
  const len = Math.hypot(rx, ry, rz, rw) || 1;
  const x = rx / len;
  const y = ry / len;
  const z = rz / len;
  const w = rw / len;
  const sx = scale[0] ?? 1;
  const sy = scale[1] ?? 1;
  const sz = scale[2] ?? 1;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = translation[0] ?? 0;
  out[13] = translation[1] ?? 0;
  out[14] = translation[2] ?? 0;
  out[15] = 1;
  return out;
}

export function applyMorphWeights(target: GltfAnimationTarget, weights: ArrayLike<number>): void {
  if (target.morphPrimitives.length === 0) return;
  target.weights.length = weights.length;
  for (let i = 0; i < weights.length; i++) target.weights[i] = weights[i] ?? 0;
  for (const morph of target.morphPrimitives) {
    morph.geometry.setMorphWeights(target.weights);
    updateConservativeMorphBounds(morph.geometry, target.weights);
    if (morph.geometry.morphUseGpu) continue;
    const positions = morph.geometry.positions;
    positions.set(morph.geometry.morphBasePositions ?? morph.basePositions);
    for (let targetIndex = 0; targetIndex < morph.positionTargets.length; targetIndex++) {
      const weight = weights[targetIndex] ?? 0;
      if (weight === 0) continue;
      const delta = morph.positionTargets[targetIndex];
      if (!delta || delta.length !== positions.length) {
        throw gltfDataError('Morph POSITION target does not match the base position count.');
      }
      for (let i = 0; i < positions.length; i++) {
        positions[i] = requiredFiniteArrayValue(positions, i, 'morph positions')
          + requiredFiniteArrayValue(delta, i, 'morph POSITION target') * weight;
      }
    }

    const normals = morph.geometry.normals;
    const baseNormals = morph.geometry.morphBaseNormals ?? morph.baseNormals;
    if (normals && baseNormals) {
      normals.set(baseNormals);
      for (let targetIndex = 0; targetIndex < morph.normalTargets.length; targetIndex++) {
        const weight = weights[targetIndex] ?? 0;
        if (weight === 0) continue;
        const delta = morph.normalTargets[targetIndex];
        if (!delta || delta.length !== normals.length) {
          throw gltfDataError('Morph NORMAL target does not match the base normal count.');
        }
        for (let i = 0; i < normals.length; i++) {
          normals[i] = requiredFiniteArrayValue(normals, i, 'morph normals')
            + requiredFiniteArrayValue(delta, i, 'morph NORMAL target') * weight;
        }
      }
    }

    morph.geometry.markDirty();
  }
}

export function updateSkinnedPrimitive(runtime: GltfSkinnedPrimitiveRuntime): void {
  const meshWorldMatrix = updateEntityWorldMatrix(runtime.meshEntity);
  const meshTransform = runtime.meshEntity.getComponent(Transform3D);
  let dirty = runtime.lastMeshWorldVersion !== (meshTransform?.worldVersion ?? 0)
    || runtime.lastGeometryVersion !== runtime.geometry.version;
  for (let jointIndex = 0; jointIndex < runtime.jointTargets.length; jointIndex++) {
    const target = runtime.jointTargets[jointIndex];
    if (!target) continue;
    updateEntityWorldMatrix(target.entity);
    const worldVersion = target.transform.worldVersion;
    if (runtime.lastJointWorldVersions[jointIndex] !== worldVersion) dirty = true;
  }
  if (!dirty) return;

  const inverseMeshWorld = mat4.inverse(meshWorldMatrix, runtime.inverseMeshWorldScratch) as Float32Array;
  for (let jointIndex = 0; jointIndex < runtime.jointTargets.length; jointIndex++) {
    const jointTarget = runtime.jointTargets[jointIndex];
    const inverseBind = runtime.inverseBindMatrices[jointIndex];
    if (!jointTarget || !inverseBind) {
      runtime.jointMatrices.set(IDENTITY_MATRIX, jointIndex * 16);
      continue;
    }
    mat4.multiply(jointTarget.transform.worldMatrix, inverseBind, runtime.jointMatrixScratch);
    mat4.multiply(inverseMeshWorld, runtime.jointMatrixScratch, runtime.skinMatrixScratch);
    runtime.jointMatrices.set(runtime.skinMatrixScratch, jointIndex * 16);
  }
  runtime.geometry.updateSkinningMatrices(runtime.jointMatrices);
  updateConservativeSkinBounds(runtime.geometry);
  runtime.lastMeshWorldVersion = meshTransform?.worldVersion ?? 0;
  runtime.lastGeometryVersion = runtime.geometry.version;
  for (let jointIndex = 0; jointIndex < runtime.jointTargets.length; jointIndex++) {
    runtime.lastJointWorldVersions[jointIndex] = runtime.jointTargets[jointIndex]?.transform.worldVersion ?? -1;
  }
}

function updateConservativeMorphBounds(geometry: Geometry3D, weights: ArrayLike<number>): void {
  const bounds = conservativeBoundsByGeometry.get(geometry);
  if (!bounds) return;
  bounds.updateMorphWeights(weights);
  geometry.setLocalBounds(geometry.skinning
    ? bounds.getSkinnedBounds(geometry.skinning.jointMatrices, geometry.skinning.joints, geometry.skinning.weights)
    : bounds.getSourceBounds());
}

function updateConservativeSkinBounds(geometry: Geometry3D): void {
  const bounds = conservativeBoundsByGeometry.get(geometry);
  if (!bounds || !geometry.skinning) return;
  geometry.setLocalBounds(bounds.getSkinnedBounds(
    geometry.skinning.jointMatrices,
    geometry.skinning.joints,
    geometry.skinning.weights,
  ));
}

const IDENTITY_MATRIX = mat4.identity() as Float32Array;

function updateEntityWorldMatrix(entity: Entity): Float32Array {
  const transform = entity.getComponent(Transform3D);
  const parent = entity.parent as Entity | null;
  const parentWorld = parent ? updateEntityWorldMatrix(parent) : null;
  if (transform) {
    if (parent) {
      const parentTransform = parent.getComponent(Transform3D);
      transform.updateWorldMatrix(parentTransform?.worldMatrix ?? parentWorld ?? undefined, parentTransform?.worldVersion ?? 0);
    } else {
      transform.updateWorldMatrix(undefined, 0);
    }
    return transform.worldMatrix;
  }
  return parentWorld ?? IDENTITY_MATRIX;
}
