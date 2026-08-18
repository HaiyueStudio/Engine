import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Geometry2D,
  Material2D,
  Mesh2DRenderer,
} from '../dist/experimental.js';

class CustomMaterial2D extends Material2D {
  static type = 'CustomMaterial2D';
  type = CustomMaterial2D.type;
}

function ensureGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    VERTEX: 1 << 0,
    INDEX: 1 << 1,
    COPY_DST: 1 << 2,
    UNIFORM: 1 << 3,
    STORAGE: 1 << 4,
  };
  globalThis.GPUShaderStage ??= {
    VERTEX: 1 << 0,
    FRAGMENT: 1 << 1,
  };
}

function createMockEngine(log = []) {
  ensureGpuConstants();
  const queue = {
    writeBuffer(buffer, offset, data, dataOffset, size) {
      log.push(['writeBuffer', buffer.label ?? null, offset, dataOffset ?? 0, size ?? data.byteLength ?? data.length]);
    },
  };
  const device = {
    queue,
    createBindGroupLayout(descriptor) {
      log.push(['createBindGroupLayout', descriptor.entries[0]?.buffer?.type ?? null]);
      return { descriptor };
    },
    createShaderModule(descriptor) {
      log.push(['createShaderModule', descriptor.code.length]);
      return { descriptor };
    },
    createPipelineLayout(descriptor) {
      log.push(['createPipelineLayout', descriptor.bindGroupLayouts.length]);
      return { descriptor };
    },
    createBuffer(descriptor) {
      const buffer = {
        label: descriptor.label,
        descriptor,
        destroy() {
          log.push(['destroyBuffer', descriptor.label ?? null, descriptor.size]);
        },
      };
      log.push(['createBuffer', descriptor.label ?? null, descriptor.size, descriptor.usage]);
      return buffer;
    },
    createBindGroup(descriptor) {
      log.push(['createBindGroup', descriptor.entries[0]?.resource?.buffer?.label ?? null]);
      return { descriptor };
    },
    createRenderPipeline(descriptor) {
      log.push(['createRenderPipeline', descriptor.vertex.buffers.length]);
      return { descriptor };
    },
  };
  return {
    device,
    format: 'bgra8unorm',
    reverseZ: false,
    msaaSamples: 1,
    getDepthFormat() {
      return 'depth24plus';
    },
  };
}

function createMockPass(log = []) {
  return {
    setPipeline(pipeline) {
      log.push(['setPipeline', pipeline.descriptor.vertex.buffers.length]);
    },
    setBindGroup(index, bindGroup) {
      log.push(['setBindGroup', index, bindGroup.descriptor.entries[0]?.resource?.buffer?.label ?? null]);
    },
    setVertexBuffer(index, buffer) {
      log.push(['setVertexBuffer', index, buffer.label ?? null]);
    },
    setIndexBuffer(buffer, format) {
      log.push(['setIndexBuffer', buffer.label ?? null, format]);
    },
    drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
      log.push(['drawIndexed', indexCount, instanceCount, firstIndex, baseVertex, firstInstance]);
    },
    draw(vertexCount, instanceCount, firstVertex, firstInstance) {
      log.push(['draw', vertexCount, instanceCount, firstVertex, firstInstance]);
    },
  };
}

test('Mesh2DRenderer stores per-entity data in a shared object table and reuses slots', () => {
  const log = [];
  const engine = createMockEngine(log);
  const renderer = new Mesh2DRenderer();
  renderer.prepare(engine);
  renderer.updateCamera(new Float32Array(16));

  const geometry = new Geometry2D(
    new Float32Array([0, 0, 1, 0, 0, 1]),
    new Uint16Array([0, 1, 2]),
  );
  const material = new Material2D({ color: [1, 0, 0, 1] });
  const matrix = new Float32Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  const pass = createMockPass(log);

  renderer.render(pass, 1, geometry, material, matrix);
  renderer.render(pass, 2, geometry, material, matrix);
  renderer.releaseEntitiesNotIn(new Set([2]));
  renderer.render(pass, 3, geometry, material, matrix);

  const objectTableCreates = log.filter(item => item[0] === 'createBuffer' && item[1] === 'Mesh2DRenderer.objectTable');
  assert.deepEqual(objectTableCreates.map(item => item[2]), [80, 160]);

  const draws = log.filter(item => item[0] === 'drawIndexed');
  assert.deepEqual(draws.map(item => item[5]), [0, 1, 0]);

  const entityUniformCreates = log.filter(item => item[0] === 'createBuffer' && item[1] === null && item[2] === 80);
  assert.equal(entityUniformCreates.length, 0);
});

test('Mesh2DRenderer refreshes geometry buffers when Geometry2D version changes', () => {
  const log = [];
  const engine = createMockEngine(log);
  const renderer = new Mesh2DRenderer();
  renderer.prepare(engine);
  renderer.updateCamera(new Float32Array(16));

  const geometry = new Geometry2D(
    new Float32Array([0, 0, 1, 0, 0, 1]),
    new Uint16Array([0, 1, 2]),
  );
  const material = new Material2D();
  const matrix = new Float32Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  const pass = createMockPass(log);

  renderer.render(pass, 1, geometry, material, matrix);
  geometry.setData(
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    new Uint16Array([0, 1, 2, 0, 2, 3]),
  );
  renderer.render(pass, 1, geometry, material, matrix);

  const vertexBufferCreates = log.filter(item => item[0] === 'createBuffer' && item[1] === null && (item[2] === 24 || item[2] === 32));
  assert.deepEqual(vertexBufferCreates.map(item => item[2]), [24, 32]);

  const destroyedGeometryBuffers = log.filter(item => item[0] === 'destroyBuffer' && item[1] === null);
  assert.ok(destroyedGeometryBuffers.some(item => item[2] === 24), 'expected old vertex buffer to be destroyed');
  assert.ok(destroyedGeometryBuffers.some(item => item[2] === 8), 'expected old index buffer to be destroyed');

  const draws = log.filter(item => item[0] === 'drawIndexed');
  assert.deepEqual(draws.map(item => item[1]), [3, 6]);
});

test('Mesh2DRenderer renderMany batches consecutive compatible material renderers without reordering', () => {
  const log = [];
  const engine = createMockEngine(log);
  const renderer = new Mesh2DRenderer();
  renderer.prepare(engine);
  const geometry = new Geometry2D(new Float32Array([0, 0, 1, 0, 0, 1]));
  const matrix = new Float32Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  const material = new CustomMaterial2D();
  const fallback = new Material2D();
  const pass = createMockPass(log);
  const batches = [];

  renderer.registerMaterialRenderer({
    materialType: CustomMaterial2D.type,
    renderBatch(_context, items) {
      batches.push(items.map(item => item.entityId));
    },
  });

  renderer.renderMany(pass, [
    { entityId: 1, geometry, material, worldMatrix: matrix },
    { entityId: 2, geometry, material, worldMatrix: matrix },
    { entityId: 3, geometry, material: fallback, worldMatrix: matrix },
    { entityId: 4, geometry, material, worldMatrix: matrix },
  ]);

  assert.deepEqual(batches, [[1, 2], [4]]);
  const draws = log.filter(item => item[0] === 'draw');
  assert.equal(draws.length, 1);
  assert.equal(draws[0][1], 3);
});
