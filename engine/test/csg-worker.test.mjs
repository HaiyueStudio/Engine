import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker as NodeWorker } from 'node:worker_threads';
import {
  createBox3D,
  createCSGGeometry,
  createCSGWorkerClientFromUrl,
  createCSGWorkerSource,
  createSphere3D,
} from '../dist/geometry.js';

test('async CSG remains on the geometry subpath and reports unavailable workers', async () => {
  const root = await import('../dist/index.js');
  const geometry = await import('../dist/geometry.js');
  for (const name of [
    'createCSGWorkerClientFromUrl',
    'createCSGWorkerSource',
    'createInlineCSGWorkerClient',
  ]) {
    assert.equal(name in root, false, `root entrypoint unexpectedly exports ${name}`);
    assert.equal(typeof geometry[name], 'function');
  }

  if (typeof globalThis.Worker === 'undefined') {
    assert.throws(
      () => createCSGWorkerClientFromUrl('csg-worker.js'),
      error => error?.code === 'E_WORKER_PROTOCOL_INVALID'
        && error?.path === 'csg.worker.capability'
        && /unavailable/i.test(error.message),
    );
  }
});

test('real CSG worker preserves synchronous output and never detaches renderer-owned inputs', async t => {
  const worker = createNodeCSGWorker();
  const client = createClientForWorker(worker);
  t.after(() => client.dispose());

  const box = createBox3D({ width: 2, height: 2, depth: 2 });
  const sphere = createSphere3D({ radius: 1.2, widthSegments: 12, heightSegments: 8 });
  const inputByteLengths = geometryByteLengths(box, sphere);
  const [boxHandle, sphereHandle] = await Promise.all([
    client.prepareGeometry(box),
    client.prepareGeometry(sphere),
  ]);

  assert.deepEqual(geometryByteLengths(box, sphere), inputByteLengths);
  assert.equal(client.diagnostics.preparedGeometryCount, 2);
  assert.ok(client.diagnostics.inputTransferBytes > 0);

  for (const operation of ['union', 'subtract', 'intersect']) {
    const expected = createCSGGeometry(box, sphere, operation);
    const actual = await client.compute(
      { geometry: boxHandle },
      { geometry: sphereHandle },
      operation,
    );
    assertGeometryEqual(actual, expected, operation);
  }

  assert.ok(client.diagnostics.outputTransferBytes > 0);
  assert.equal(client.diagnostics.pendingRequestCount, 0);
  client.releaseGeometry(boxHandle);
  client.releaseGeometry(sphereHandle);
  assert.equal(client.diagnostics.preparedGeometryCount, 0);
});

test('CSG worker applies prepared-geometry transforms inside the worker', async t => {
  const worker = createNodeCSGWorker();
  const client = createClientForWorker(worker);
  t.after(() => client.dispose());

  const box = createBox3D({ width: 2, height: 2, depth: 2 });
  const sphere = createSphere3D({ radius: 1.1, widthSegments: 10, heightSegments: 6 });
  const [boxHandle, sphereHandle] = await Promise.all([
    client.prepareGeometry(box),
    client.prepareGeometry(sphere),
  ]);
  const transform = translationMatrix(0.65, 0.2, -0.15);
  const transformedSphere = translateGeometryForTest(sphere, 0.65, 0.2, -0.15);

  const expected = createCSGGeometry(box, transformedSphere, 'subtract');
  const actual = await client.compute(
    { geometry: boxHandle },
    { geometry: sphereHandle, transform },
    'subtract',
  );
  assertGeometryNear(actual, expected, 'transformed subtract');
});

test('CSG worker client coalesces rapid compute requests to active plus latest', async () => {
  const worker = new ControlledCSGWorker();
  const client = createClientForWorker(worker);
  const [a, b] = await Promise.all([
    client.prepareGeometry(createBox3D()),
    client.prepareGeometry(createSphere3D({ widthSegments: 6, heightSegments: 4 })),
  ]);

  const first = client.compute({ geometry: a }, { geometry: b }, 'union');
  const firstRejected = assert.rejects(first, isAbortError);
  const second = client.compute({ geometry: a }, { geometry: b }, 'subtract');
  const secondRejected = assert.rejects(second, isAbortError);
  const latest = client.compute({ geometry: a }, { geometry: b }, 'intersect');

  await Promise.all([firstRejected, secondRejected]);
  assert.equal(worker.computeRequests.length, 1);
  assert.equal(worker.computeRequests[0].operation, 'union');
  assert.equal(client.diagnostics.hasActiveCompute, true);
  assert.equal(client.diagnostics.hasQueuedCompute, true);

  worker.resolveCompute(worker.computeRequests[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.computeRequests.length, 2);
  assert.equal(worker.computeRequests[1].operation, 'intersect');

  worker.resolveCompute(worker.computeRequests[1]);
  const geometry = await latest;
  assert.equal(geometry.indexCount, 3);
  assert.equal(client.diagnostics.computeRequestsPosted, 2);
  assert.equal(client.diagnostics.supersededComputeCount, 2);
  assert.equal(client.diagnostics.pendingRequestCount, 0);

  client.dispose();
  assert.equal(worker.terminated, true);
});

test('CSG worker abort and dispose clear requests without applying stale results', async () => {
  const worker = new ControlledCSGWorker();
  const client = createClientForWorker(worker);
  const [a, b] = await Promise.all([
    client.prepareGeometry(createBox3D()),
    client.prepareGeometry(createSphere3D({ widthSegments: 6, heightSegments: 4 })),
  ]);
  const controller = new AbortController();
  const compute = client.compute({ geometry: a }, { geometry: b }, 'subtract', {
    signal: controller.signal,
  });
  const rejection = assert.rejects(compute, isAbortError);
  controller.abort('test abort');
  await rejection;
  assert.equal(client.diagnostics.abortedRequestCount, 1);

  worker.resolveCompute(worker.computeRequests[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.diagnostics.pendingRequestCount, 0);

  const pending = client.compute({ geometry: a }, { geometry: b }, 'union');
  const disposed = assert.rejects(
    pending,
    error => error?.code === 'E_WORKER_PROTOCOL_INVALID' && error?.path === 'csg.worker.dispose',
  );
  client.dispose();
  await disposed;
  assert.equal(client.diagnostics.pendingRequestCount, 0);
  assert.equal(client.diagnostics.preparedGeometryCount, 0);
  assert.equal(worker.terminated, true);
});

test('CSG worker surfaces worker failures and rejects future work', async () => {
  const worker = new ControlledCSGWorker();
  const client = createClientForWorker(worker);
  const [a, b] = await Promise.all([
    client.prepareGeometry(createBox3D()),
    client.prepareGeometry(createSphere3D({ widthSegments: 6, heightSegments: 4 })),
  ]);
  const pending = client.compute({ geometry: a }, { geometry: b }, 'union');
  const rejected = assert.rejects(
    pending,
    error => error?.code === 'E_WORKER_PROTOCOL_INVALID' && error?.path === 'csg.worker.error',
  );
  worker.emitError(new Error('worker crashed'));
  await rejected;
  assert.equal(client.diagnostics.pendingRequestCount, 0);
  assert.throws(
    () => client.compute({ geometry: a }, { geometry: b }, 'subtract'),
    error => error?.code === 'E_WORKER_PROTOCOL_INVALID' && error?.path === 'csg.worker.error',
  );
  client.dispose();
});

function createNodeCSGWorker() {
  const moduleUrl = new URL('../dist/geometry.js', import.meta.url).href;
  const runtime = createCSGWorkerSource(moduleUrl);
  const source = `
const { parentPort } = require('node:worker_threads');
globalThis.self = globalThis;
self.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', data => listener({ data }));
};
self.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
${runtime}
`;
  return new NodeWorkerAdapter(new NodeWorker(source, { eval: true }));
}

function createClientForWorker(worker) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  class InjectedWorker {
    constructor() {
      return worker;
    }
  }
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: InjectedWorker,
  });
  try {
    return createCSGWorkerClientFromUrl('injected-csg-worker.js');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor);
    else delete globalThis.Worker;
  }
}

class NodeWorkerAdapter {
  constructor(worker) {
    this.worker = worker;
    this.listeners = new Map();
  }

  postMessage(message, transfer) {
    this.worker.postMessage(message, transfer);
  }

  addEventListener(type, listener) {
    const wrapped = type === 'message'
      ? value => listener({ data: value })
      : value => listener(value);
    this.listeners.set(listener, { type, wrapped });
    this.worker.on(type, wrapped);
  }

  removeEventListener(_type, listener) {
    const registration = this.listeners.get(listener);
    if (!registration) return;
    this.worker.off(registration.type, registration.wrapped);
    this.listeners.delete(listener);
  }

  terminate() {
    void this.worker.terminate();
  }
}

class ControlledCSGWorker {
  constructor() {
    this.listeners = new Map([
      ['message', new Set()],
      ['error', new Set()],
      ['messageerror', new Set()],
    ]);
    this.computeRequests = [];
    this.terminated = false;
  }

  postMessage(message) {
    if (message.type === 'prepare') {
      queueMicrotask(() => this.emitMessage({
        id: message.id,
        ok: true,
        type: 'prepared',
        handleId: message.handleId,
      }));
      return;
    }
    if (message.type === 'compute') this.computeRequests.push(message);
  }

  addEventListener(type, listener) {
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type).delete(listener);
  }

  terminate() {
    this.terminated = true;
  }

  resolveCompute(request) {
    this.emitMessage({
      id: request.id,
      ok: true,
      type: 'computed',
      workerComputeMs: 1,
      geometry: triangleGeometryData(),
    });
  }

  emitMessage(data) {
    for (const listener of this.listeners.get('message')) listener({ data });
  }

  emitError(error) {
    for (const listener of this.listeners.get('error')) listener(error);
  }
}

function triangleGeometryData() {
  return {
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    normals: new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]),
    uvs: new Float32Array([
      0, 0,
      1, 0,
      0, 1,
    ]),
    indices: new Uint16Array([0, 1, 2]),
    topology: null,
  };
}

function translationMatrix(x, y, z) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

function translateGeometryForTest(geometry, x, y, z) {
  const positions = Float32Array.from(geometry.positions);
  for (let offset = 0; offset < positions.length; offset += 3) {
    positions[offset] += x;
    positions[offset + 1] += y;
    positions[offset + 2] += z;
  }
  return new geometry.constructor({
    positions,
    normals: geometry.normals ? Float32Array.from(geometry.normals) : undefined,
    textureCoordinates: [...geometry.textureCoordinates].map(([set, data]) => ({
      set,
      data: Float32Array.from(data),
    })),
    textureCoordinateLayout: geometry.textureCoordinateLayout,
    indices: geometry.indices ? geometry.indices.slice() : undefined,
  });
}

function geometryByteLengths(...geometries) {
  return geometries.map(geometry => ({
    positions: geometry.positions.byteLength,
    normals: geometry.normals?.byteLength ?? 0,
    uvs: geometry.getTextureCoordinates(0)?.byteLength ?? 0,
    indices: geometry.indices?.byteLength ?? 0,
  }));
}

function assertGeometryEqual(actual, expected, label) {
  assert.deepEqual(Array.from(actual.positions), Array.from(expected.positions), `${label} positions`);
  assert.deepEqual(Array.from(actual.normals ?? []), Array.from(expected.normals ?? []), `${label} normals`);
  assert.deepEqual(
    Array.from(actual.getTextureCoordinates(0) ?? []),
    Array.from(expected.getTextureCoordinates(0) ?? []),
    `${label} uvs`,
  );
  assert.deepEqual(Array.from(actual.indices ?? []), Array.from(expected.indices ?? []), `${label} indices`);
}

function assertGeometryNear(actual, expected, label, epsilon = 1e-5) {
  assert.equal(actual.positions.length, expected.positions.length, `${label} position count`);
  assert.equal(actual.normals?.length, expected.normals?.length, `${label} normal count`);
  assert.equal(
    actual.getTextureCoordinates(0)?.length,
    expected.getTextureCoordinates(0)?.length,
    `${label} uv count`,
  );
  assert.deepEqual(Array.from(actual.indices ?? []), Array.from(expected.indices ?? []), `${label} indices`);
  assertArrayNear(actual.positions, expected.positions, epsilon, `${label} positions`);
  assertArrayNear(actual.normals ?? [], expected.normals ?? [], epsilon, `${label} normals`);
  assertArrayNear(
    actual.getTextureCoordinates(0) ?? [],
    expected.getTextureCoordinates(0) ?? [],
    epsilon,
    `${label} uvs`,
  );
}

function assertArrayNear(actual, expected, epsilon, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < actual.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `${label}[${index}] differs: ${actual[index]} vs ${expected[index]}`,
    );
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}
