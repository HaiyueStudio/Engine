import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPU_MOCK_CAPABILITIES,
  GPU_MOCK_CAPABILITY_CONTRACT,
  GpuMockCapabilityError,
  composeGpuMockCapabilities,
  createAuditGpuDevice,
  createRealRendererAuditDevice,
  getAuditGpuDeviceState,
} from './real-renderer-audit-device.mjs';

test('shared GPU mock exposes the complete versioned capability contract', async () => {
  assert.equal(GPU_MOCK_CAPABILITY_CONTRACT.schema, 'haiyue-gpu-mock-capability-contract');
  assert.equal(GPU_MOCK_CAPABILITY_CONTRACT.version, 1);
  assert.deepEqual(GPU_MOCK_CAPABILITIES.ALL, GPU_MOCK_CAPABILITY_CONTRACT.capabilities);

  const device = createAuditGpuDevice();
  const buffer = device.createBuffer({ label: 'contract.buffer', size: 32, mappedAtCreation: true });
  buffer.getMappedRange();
  buffer.unmap();
  await buffer.mapAsync(GPUMapMode.READ);
  const texture = device.createTexture({
    label: 'contract.texture',
    size: [4, 2, 1],
    format: 'rgba8unorm',
  });
  texture.createView();
  device.createSampler({ label: 'contract.sampler' });
  device.createShaderModule({ label: 'contract.shader', code: '' });
  device.createBindGroupLayout({ label: 'contract.bgl', entries: [] });
  device.createBindGroup({ label: 'contract.bg', layout: {}, entries: [] });
  device.createPipelineLayout({ label: 'contract.layout', bindGroupLayouts: [] });
  device.createRenderPipeline({ label: 'contract.render' }).getBindGroupLayout(0);
  device.createComputePipeline({ label: 'contract.compute' }).getBindGroupLayout(0);
  await device.createRenderPipelineAsync({ label: 'contract.render.async' });
  await device.createComputePipelineAsync({ label: 'contract.compute.async' });
  const encoder = device.createCommandEncoder({ label: 'contract.encoder' });
  encoder.beginRenderPass({ label: 'contract.pass', colorAttachments: [] }).end();
  encoder.beginComputePass({ label: 'contract.compute-pass' }).end();
  device.queue.writeBuffer(buffer, 0, new Uint8Array(16));
  device.queue.writeTexture({ texture }, new Uint8Array(24), {}, { width: 2, height: 3 });
  device.queue.copyExternalImageToTexture({}, { texture }, { width: 1, height: 1 });
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  const audit = getAuditGpuDeviceState(device);
  assert.equal(audit.uploadCalls, 3);
  assert.equal(audit.uploadBytes, 40);
  assert.equal(audit.unknownUploadByteCalls, 1);
  assert.equal(audit.getUploadCount('contract.buffer'), 1);
  assert.equal(audit.getCallCount('device.createShaderModule'), 1);
  assert.equal(audit.getCallCount('device.createPipelineLayout'), 1);
  assert.equal(audit.getCallCount('device.createRenderPipeline'), 1);
  assert.equal(audit.getCallCount('device.createComputePipeline'), 1);
  assert.equal(audit.getCallCount('device.createCommandEncoder'), 1);
  assert.equal(audit.snapshot().version, 1);
});

test('GPU mock capabilities compose and missing APIs report actionable diagnostics', () => {
  const capabilities = composeGpuMockCapabilities(
    ['buffer'],
    new Set(['queue']),
    { 'command-encoder': true, texture: false },
  );
  assert.deepEqual(capabilities, ['buffer', 'queue', 'command-encoder']);
  const device = createAuditGpuDevice({ capabilities });
  assert.doesNotThrow(() => device.createBuffer({ size: 4 }));
  assert.throws(
    () => device.createShaderModule({ code: '' }),
    error => {
      assert.ok(error instanceof GpuMockCapabilityError);
      assert.equal(error.capability, 'shader-module');
      assert.equal(error.method, 'device.createShaderModule');
      assert.match(error.message, /contract haiyue-gpu-mock-capability-contract@1/);
      return true;
    },
  );
  assert.throws(() => composeGpuMockCapabilities(['future-api']), /Unknown Mock GPUDevice capability/);
});

test('legacy real-renderer factory is backed by the shared audit contract', () => {
  const device = createRealRendererAuditDevice({ recordLimit: 1 });
  device.createBuffer({ size: 4 });
  device.createTexture({ size: [1, 1], format: 'rgba8unorm' });
  const audit = getAuditGpuDeviceState(device);
  assert.equal(audit.calls.length, 1);
  assert.equal(audit.droppedCallRecords, 1);
  assert.equal(device.__gpuMockCapabilityContract.version, 1);
});
