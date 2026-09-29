import { mat4 } from 'wgpu-matrix';
import type { Render3DViewExecutionState } from './Render3DFrameCoordinator';

/** Shared frame packing for pre-light AO and post-light effects. */
export class Render3DPostSceneFrameContext {
  private readonly _frame = {
    viewKey: '',
    frameId: 0,
    cameraId: 0,
    width: 1,
    height: 1,
    reverseZ: false,
    near: 0.1,
    far: 1000,
    isOrthographic: false,
    projectionJitter: new Float32Array(2),
    projectionMatrix: mat4.identity() as Float32Array,
    viewProjectionMatrix: mat4.identity() as Float32Array,
    inverseViewProjectionMatrix: mat4.identity() as Float32Array,
  };
  update(state: Render3DViewExecutionState) {
    const { camera, cameraEntityId, cameraFrame, frameView } = state;
    const frame = this._frame;
    frame.viewKey = frameView.key;
    frame.frameId = cameraFrame.frameId;
    frame.cameraId = cameraEntityId;
    frame.width = frameView.width;
    frame.height = frameView.height;
    frame.reverseZ = cameraFrame.reverseZ;
    frame.near = camera.near;
    frame.far = camera.far;
    frame.isOrthographic = camera.projectionType === 'orthographic';
    frame.projectionJitter.set(cameraFrame.projectionJitter);
    frame.projectionMatrix.set(cameraFrame.projectionMatrix);
    frame.viewProjectionMatrix.set(cameraFrame.viewProjectionMatrix);
    frame.inverseViewProjectionMatrix.set(cameraFrame.inverseViewProjectionMatrix);
    return frame;
  }

}
