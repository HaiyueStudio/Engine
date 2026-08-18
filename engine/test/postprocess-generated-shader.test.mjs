import test from 'node:test';
import assert from 'node:assert/strict';
import { GrayscalePass } from '../dist/postprocess.js';

test('GrayscalePass materializes its module and layout exclusively through Artifact V2 runtime', () => {
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  const log = [];
  const device = {
    createShaderModule(descriptor) { log.push(['module', descriptor]); return { descriptor }; },
    createBindGroupLayout(descriptor) { log.push(['bgl', descriptor]); return { descriptor }; },
    createPipelineLayout(descriptor) { log.push(['layout', descriptor]); return { descriptor }; },
    createSampler(descriptor) { log.push(['sampler', descriptor]); return { descriptor }; },
  };
  const pass = new GrayscalePass();
  pass.prepare(device, 'rgba8unorm', 4, 4);
  assert.equal(log.filter(entry => entry[0] === 'module').length, 1);
  assert.equal(log.filter(entry => entry[0] === 'bgl').length, 1);
  assert.equal(log.filter(entry => entry[0] === 'layout').length, 1);
  assert.deepEqual(log.find(entry => entry[0] === 'bgl')[1].entries, [
    {
      binding: 0, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
    },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ]);
});
