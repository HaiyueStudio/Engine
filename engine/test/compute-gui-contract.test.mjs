import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deserializeGuiRoot,
  EngineErrorCode,
  GUI_SHAPE_VERTEX_LAYOUT,
  GUI_TEXTURED_VERTEX_LAYOUT,
  GuiBatch,
  GuiImageRenderer,
  GuiRoot,
  GuiTextRenderer,
  recordComputeResourcePass,
  serializeGuiRoot,
  TextureConvolutionProcessor,
} from '../dist/experimental.js';
import { BUILTIN_RENDER_SHADER_ARTIFACT } from '../dist/internal/2d-ui-shader-artifact.js';
import {
  createAuditGpuDevice,
  getAuditGpuDeviceState,
} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

const GUI_SERIALIZATION_FORMAT = 'haiyue.gui';
const GUI_SERIALIZATION_VERSION = 1;

test('compute resource contract requires explicit storage-write consumption dependencies', () => {
  const encoder = {};
  const context = { encoder };
  const resource = {};
  const writer = recordComputeResourcePass(context, {
    label: 'write.commands',
    path: 'fixture.write',
    accesses: [{ resource, use: 'storage-write', path: 'fixture.write.commands' }],
  });

  assert.throws(
    () => recordComputeResourcePass(context, {
      label: 'draw.indirect',
      path: 'fixture.draw',
      accesses: [{ resource, use: 'indirect', path: 'fixture.draw.indirectBuffer' }],
    }),
    error => error.code === EngineErrorCode.ComputeInvalidParameter
      && error.path === 'fixture.draw.indirectBuffer'
      && error.context.previousLabel === 'write.commands',
  );

  assert.doesNotThrow(() => recordComputeResourcePass(context, {
    label: 'draw.indirect',
    path: 'fixture.draw',
    after: [writer],
    accesses: [{ resource, use: 'indirect', path: 'fixture.draw.indirectBuffer' }],
  }));
});

test('compute resource contract covers render/read order, same-pass invalid use, and active render passes', () => {
  const firstContext = { encoder: {} };
  const resource = {};
  const writer = recordComputeResourcePass(firstContext, {
    label: 'write.output',
    path: 'fixture.output',
    accesses: [{ resource, use: 'storage-write', path: 'fixture.output.texture' }],
  });
  assert.doesNotThrow(() => recordComputeResourcePass(firstContext, {
    label: 'render.sample',
    path: 'fixture.render',
    after: [writer],
    accesses: [{ resource, use: 'render-read', path: 'fixture.render.texture' }],
  }));

  assert.throws(
    () => recordComputeResourcePass({ encoder: {} }, {
      label: 'invalid.samePass',
      path: 'fixture.samePass',
      accesses: [
        { resource, use: 'storage-write', path: 'fixture.samePass.write' },
        { resource, use: 'indirect', path: 'fixture.samePass.indirect' },
      ],
    }),
    error => error.code === EngineErrorCode.ComputeInvalidParameter
      && error.path === 'fixture.samePass.indirect',
  );

  assert.throws(
    () => recordComputeResourcePass({ encoder: {}, passEncoder: {} }, {
      label: 'invalid.activeRender',
      path: 'fixture.activeRender',
      accesses: [{ resource: {}, use: 'storage-write', path: 'fixture.activeRender.output' }],
    }),
    error => error.path === 'fixture.activeRender.passEncoder',
  );
});

test('GUI vertex descriptors are the single source for packer bytes and shader reflection', () => {
  const shapeReflection = BUILTIN_RENDER_SHADER_ARTIFACT.passes['gui-shape'].vertexBuffers[0];
  const imageReflection = BUILTIN_RENDER_SHADER_ARTIFACT.passes['gui-image'].vertexBuffers[0];
  const textReflection = BUILTIN_RENDER_SHADER_ARTIFACT.passes['gui-text'].vertexBuffers[0];
  assert.deepEqual(GUI_SHAPE_VERTEX_LAYOUT.gpu, {
    arrayStride: shapeReflection.arrayStride,
    attributes: shapeReflection.attributes.map(({ shaderLocation, offset, format }) => ({ shaderLocation, offset, format })),
  });
  for (const reflection of [imageReflection, textReflection]) {
    assert.deepEqual(GUI_TEXTURED_VERTEX_LAYOUT.gpu, {
      arrayStride: reflection.arrayStride,
      attributes: reflection.attributes.map(({ shaderLocation, offset, format }) => ({ shaderLocation, offset, format })),
    });
  }

  const batch = new GuiBatch();
  batch.addShape({ x: 2, y: 3, width: 5, height: 7, radius: 2, color: [0.1, 0.2, 0.3, 0.4] });
  batch.rebuild();
  const offsets = GUI_SHAPE_VERTEX_LAYOUT.floatOffsets;
  assert.equal(batch.vertexData[offsets.position], 2);
  assert.equal(batch.vertexData[offsets.position + 1], 3);
  assert.ok(Math.abs(batch.vertexData[offsets.color + 2] - 0.3) < 1e-6);
  assert.equal(batch.vertexData[offsets.rect + 2], 5);
  assert.equal(batch.vertexData[offsets.radius], 2);
  assert.equal(batch.vertexData.length >= batch.vertexCount * GUI_SHAPE_VERTEX_LAYOUT.floatsPerVertex, true);
});

test('GUI serialization validates unknown input, format, version, and nested paths', () => {
  const serialized = serializeGuiRoot(new GuiRoot({ id: 'root' }));
  assert.equal(serialized.format, GUI_SERIALIZATION_FORMAT);
  assert.equal(serialized.version, GUI_SERIALIZATION_VERSION);
  assert.equal(deserializeGuiRoot(structuredClone(serialized)).root.id, 'root');

  for (const [payload, path] of [
    [{ ...serialized, format: 'legacy.gui' }, '$.format'],
    [{ ...serialized, version: 2 }, '$.version'],
    [{ ...serialized, version: 1.5 }, '$.version'],
    [{ ...serialized, root: { ...serialized.root, children: [{ type: 'button', props: { text: 3 } }] } }, '$.root.children[0].props.text'],
  ]) {
    assert.throws(
      () => deserializeGuiRoot(payload),
      error => error.code === EngineErrorCode.SceneDataInvalid
        && error.domain === 'serialization'
        && error.path === path
        && error.context.format === GUI_SERIALIZATION_FORMAT,
    );
  }
});

test('compute and GUI owners release idempotently, recover on a new device, and roll back partial prepare', () => {
  const firstDevice = createAuditGpuDevice();
  const engine = createEngine(firstDevice);
  const convolution = new TextureConvolutionProcessor(engine);
  const firstOutput = convolution.process({ sourceView: {}, width: 2, height: 2, kernel: 'identity' });
  firstOutput.destroy();
  convolution.destroy();
  convolution.destroy();
  assert.equal(getAuditGpuDeviceState(firstDevice).snapshot().resources.buffer.live, 0);
  assert.equal(getAuditGpuDeviceState(firstDevice).snapshot().resources.texture.live, 0);

  const secondDevice = createAuditGpuDevice();
  engine.device = secondDevice;
  const secondOutput = convolution.process({ sourceView: {}, width: 1, height: 1, kernel: 'identity' });
  secondOutput.destroy();
  convolution.destroy();
  assert.equal(getAuditGpuDeviceState(secondDevice).snapshot().resources.buffer.live, 0);
  assert.equal(getAuditGpuDeviceState(secondDevice).snapshot().resources.texture.live, 0);

  const imageRenderer = new GuiImageRenderer();
  imageRenderer.prepare(createEngine(firstDevice));
  assert.equal(getAuditGpuDeviceState(firstDevice).getCallCount('device.createSampler'), 1);
  imageRenderer.destroy();
  imageRenderer.destroy();
  imageRenderer.prepare(createEngine(secondDevice));
  imageRenderer.destroy();

  const textRenderer = new GuiTextRenderer();
  textRenderer.prepare(createEngine(secondDevice));
  textRenderer.destroy();
  textRenderer.destroy();

  const faultBase = createAuditGpuDevice();
  const faultDevice = Object.create(faultBase);
  faultDevice.createSampler = () => { throw new Error('sampler fault'); };
  const faultRenderer = new GuiImageRenderer();
  assert.throws(() => faultRenderer.prepare(createEngine(faultDevice)), /sampler fault/);
  const faultResources = getAuditGpuDeviceState(faultBase).snapshot().resources;
  assert.equal(faultResources.buffer.live, 0);
  assert.equal(faultResources.texture.live, 0);
});

function createEngine(device) {
  return {
    device,
    format: 'bgra8unorm',
    displayWidth: 320,
    displayHeight: 180,
    reverseZ: false,
    msaaSamples: 1,
    getDepthFormat: () => 'depth24plus',
  };
}
