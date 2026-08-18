import { Camera2D, Entity, Transform2D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { type IEngine } from '@haiyue/engine/core';
import { mat4 } from 'wgpu-matrix';

export interface Camera2DScratch {
  viewMatrix: Float32Array;
  viewProjMatrix: Float32Array;
}

export function createCamera2DScratch(): Camera2DScratch {
  return {
    viewMatrix: mat4.identity() as Float32Array,
    viewProjMatrix: mat4.identity() as Float32Array,
  };
}

export function compute2DViewProjection(
  engine: IEngine,
  cameraEntity: Entity,
  camera: Camera2D,
  scratch: Camera2DScratch = createCamera2DScratch(),
): Float32Array {
  camera.resize(engine.displayWidth, engine.displayHeight);
  const transform = cameraEntity.getComponent(Transform3D);
  if (!transform) return camera.projectionMatrix;
  transform.updateWorldMatrix();
  const viewMatrix = mat4.inverse(transform.worldMatrix, scratch.viewMatrix) as Float32Array;
  return mat4.multiply(camera.projectionMatrix, viewMatrix, scratch.viewProjMatrix) as Float32Array;
}

export function write2DCameraBuffer(queue: GPUQueue, buffer: GPUBuffer, viewProj: Float32Array): void {
  queue.writeBuffer(buffer, 0, viewProj.buffer as ArrayBuffer, viewProj.byteOffset, viewProj.byteLength);
}

export const IDENTITY_2D_WORLD_MATRIX = mat4.identity() as Float32Array;

export type WorldMatrix2DFrameCache = Map<Entity, Float32Array>;

export function get2DEntityWorldMatrix(entity: Entity, cache?: WorldMatrix2DFrameCache): Float32Array {
  const cached = cache?.get(entity);
  if (cached) return cached;

  const transform2D = entity.getComponent(Transform2D);
  if (transform2D) {
    const parent = entity.parent as Entity | null;
    const parentMatrix = parent ? get2DEntityWorldMatrix(parent, cache) : undefined;
    const parentTransform2D = parent?.getComponent(Transform2D);
    const parentTransform3D = parent?.getComponent(Transform3D);
    transform2D.updateWorldMatrix(parentMatrix, parentTransform2D?.worldVersion ?? parentTransform3D?.worldVersion ?? 0);
    cache?.set(entity, transform2D.worldMatrix);
    return transform2D.worldMatrix;
  }

  const transform3D = entity.getComponent(Transform3D);
  if (transform3D) {
    const parent = entity.parent as Entity | null;
    const parentMatrix = parent ? get2DEntityWorldMatrix(parent, cache) : undefined;
    const parentTransform2D = parent?.getComponent(Transform2D);
    const parentTransform3D = parent?.getComponent(Transform3D);
    transform3D.updateWorldMatrix(parentMatrix, parentTransform2D?.worldVersion ?? parentTransform3D?.worldVersion ?? 0);
    cache?.set(entity, transform3D.worldMatrix);
    return transform3D.worldMatrix;
  }

  cache?.set(entity, IDENTITY_2D_WORLD_MATRIX);
  return IDENTITY_2D_WORLD_MATRIX;
}
