import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDeformableMesh2DData, encodeDeformableMesh2DData } from '@haiyue/animation-spec/deformable2d';
import { sampleDeformableMesh2DDrawable } from '../dist/deformable-animation.js';

test('deformable sampler interpolates positions and opacity, flips screen Y, and steps render order', () => {
  const data = decodeDeformableMesh2DData(encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: 1, frameRate: 1, times: new Float32Array([0, 1]),
    drawables: [{
      id: 'mesh', textureIndex: 0, blendMode: 'normal', culling: false, masks: [],
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      positions: new Float32Array([0, 10, 20, 10, 0, 30, 10, 20, 30, 20, 10, 40]),
      opacities: new Float32Array([1, 0]), renderOrders: new Float32Array([2, 9]),
    }],
  }));
  const target = new Float32Array(6);
  const sample = sampleDeformableMesh2DDrawable(data.times, data.drawables[0], 0.5, target);
  assert.deepEqual([...target], [5, -15, 25, -15, 5, -35]);
  assert.equal(sample.opacity, 0.5);
  assert.equal(sample.renderOrder, 2);
  assert.equal(sample.progress, 0.5);
});
