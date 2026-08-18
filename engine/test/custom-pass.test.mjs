import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomPass } from '../dist/experimental.js';

function installWebGpuConstants() {
  globalThis.GPUShaderStage ??= {
    VERTEX: 1,
    FRAGMENT: 2,
    COMPUTE: 4,
  };
}

function createMockCustomPassDevice(log) {
  return {
    createShaderModule(descriptor) {
      log.push(['createShaderModule', descriptor.label]);
      return { type: 'shader-module', descriptor };
    },
    createBindGroupLayout(descriptor) {
      const layout = { type: 'bind-group-layout', label: descriptor.label, entries: descriptor.entries };
      log.push(['createBindGroupLayout', descriptor.label, descriptor.entries.map(entry => entry.binding)]);
      return layout;
    },
    createPipelineLayout(descriptor) {
      const layout = { type: 'pipeline-layout', bindGroupLayouts: descriptor.bindGroupLayouts };
      log.push(['createPipelineLayout', descriptor.bindGroupLayouts.map(layout => layout.label)]);
      return layout;
    },
    createRenderPipeline(descriptor) {
      log.push(['createRenderPipeline', descriptor.layout.bindGroupLayouts.map(layout => layout.label)]);
      return { type: 'render-pipeline', descriptor };
    },
    createSampler(descriptor) {
      log.push(['createSampler', descriptor]);
      return { type: 'sampler', descriptor };
    },
    createBindGroup(descriptor) {
      const bindGroup = { type: 'bind-group', label: descriptor.label, layout: descriptor.layout, entries: descriptor.entries };
      log.push(['createBindGroup', descriptor.label ?? '', descriptor.layout.label, descriptor.entries.map(entry => entry.binding)]);
      return bindGroup;
    },
  };
}

function createMockEncoder(log) {
  return {
    beginRenderPass(descriptor) {
      log.push(['beginRenderPass', descriptor.label]);
      return {
        setPipeline(pipeline) {
          log.push(['setPipeline', pipeline.type]);
        },
        setBindGroup(index, bindGroup) {
          log.push(['setBindGroup', index, bindGroup.label ?? 'base']);
        },
        draw(vertexCount) {
          log.push(['draw', vertexCount]);
        },
        end() {
          log.push(['endPass']);
        },
      };
    },
  };
}

test('CustomPass supports static and dynamic extra bind groups', () => {
  installWebGpuConstants();
  const log = [];
  const device = createMockCustomPassDevice(log);
  const uniformBuffer = { type: 'uniform-buffer' };
  const storageBuffer = { type: 'storage-buffer' };
  const src = { createView: () => ({ type: 'src-view' }) };
  const dstView = { type: 'dst-view' };
  let dynamicCalls = 0;

  const pass = new CustomPass({
    label: 'ExtraBindingsPass',
    fragmentCode: `
@group(1) @binding(0) var<uniform> params: vec4<f32>;
@group(2) @binding(0) var<storage, read> weights: array<f32>;
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(srcTex, srcSampler, in.uv) + params;
}
`,
    extraBindings: [
      [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }],
    ],
    extraEntries: [
      [{ binding: 0, resource: { buffer: uniformBuffer } }],
      () => {
        dynamicCalls++;
        return [{ binding: 0, resource: { buffer: storageBuffer } }];
      },
    ],
  });

  pass.prepare(device, 'bgra8unorm', 640, 360);
  pass.apply(createMockEncoder(log), src, dstView, device);

  assert.deepEqual(
    log.find(entry => entry[0] === 'createPipelineLayout')?.[1],
    ['ExtraBindingsPass.bgl', 'ExtraBindingsPass.extraBgl1', 'ExtraBindingsPass.extraBgl2'],
  );
  assert.equal(dynamicCalls, 1);
  assert.deepEqual(
    log.filter(entry => entry[0] === 'setBindGroup').map(entry => [entry[1], entry[2]]),
    [
      [0, 'base'],
      [1, 'ExtraBindingsPass.extraBg1'],
      [2, 'ExtraBindingsPass.extraBg2'],
    ],
  );
});

test('CustomPass validates matching extra binding entries', () => {
  installWebGpuConstants();
  assert.throws(
    () => new CustomPass({
      fragmentCode: '@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
      extraBindings: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    }),
    error => error.code === 'E_RENDER_COMMAND_CONTEXT_INVALID',
  );
});
