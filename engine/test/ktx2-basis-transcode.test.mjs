import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AssetManager,
  Ktx2TextureWorkerClient,
  createKtx2TextureLoader,
  createKtx2TextureWorkerClientFromUrl,
  createKtx2TextureWorkerSource,
  prepareKtx2TexturePayload,
  uploadKtx2Texture,
  uploadPreparedKtx2Texture,
} from '../dist/experimental.js';

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 2 };
globalThis.GPUBufferUsage ??= { COPY_SRC: 1 };

test('inline KTX2 worker source imports the dedicated runtime instead of the assets facade', () => {
  const source = createKtx2TextureWorkerSource('https://cdn.example/engine/experimental/ktx2-worker-runtime.js');
  assert.equal(source, 'import "https://cdn.example/engine/experimental/ktx2-worker-runtime.js";');
  assert.doesNotMatch(source, /prepareKtx2TexturePayload|experimental\/assets/);
});

test('published KTX2 worker runtime stays package-contained for direct module-worker loading', async () => {
  const source = await readFile(new URL('../dist/experimental/ktx2-worker-runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfrom\s+['"](?:@haiyue\/|pako|@loaders\.gl)/);
  assert.match(source, /prepareKtx2TexturePayload/);
});

function createKtx2Header({
  width = 8,
  height = 4,
  depth = 0,
  layers = 0,
  faces = 1,
  levels = 2,
}) {
  const buffer = new ArrayBuffer(80 + levels * 24);
  const bytes = new Uint8Array(buffer);
  bytes.set(KTX2_IDENTIFIER, 0);
  const view = new DataView(buffer);
  view.setUint32(12, 0, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, depth, true);
  view.setUint32(32, layers, true);
  view.setUint32(36, faces, true);
  view.setUint32(40, levels, true);
  view.setUint32(44, 1, true);
  return buffer;
}

function createRawUastc3DKtx2({
  width = 8,
  height = 4,
  depth = 2,
  levels = 1,
}) {
  const levelByteLengths = Array.from({ length: levels }, (_, level) => {
    const mipWidth = Math.max(1, width >> level);
    const mipHeight = Math.max(1, height >> level);
    const mipDepth = Math.max(1, depth >> level);
    return Math.ceil(mipWidth / 4) * Math.ceil(mipHeight / 4) * 16 * mipDepth;
  });
  const headerBytes = 80 + levels * 24;
  const totalBytes = headerBytes + levelByteLengths.reduce((sum, bytes) => sum + bytes, 0);
  const buffer = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(buffer);
  bytes.set(KTX2_IDENTIFIER, 0);
  const view = new DataView(buffer);
  view.setUint32(12, 0, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, depth, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, levels, true);
  view.setUint32(44, 0, true);
  let offset = headerBytes;
  for (let level = 0; level < levels; level++) {
    const levelOffset = 80 + level * 24;
    view.setBigUint64(levelOffset, BigInt(offset), true);
    view.setBigUint64(levelOffset + 8, BigInt(levelByteLengths[level]), true);
    view.setBigUint64(levelOffset + 16, BigInt(levelByteLengths[level]), true);
    bytes.fill(level + 1, offset, offset + levelByteLengths[level]);
    offset += levelByteLengths[level];
  }
  return buffer;
}

function createGpuNativeKtx2({
  vkFormat,
  width = 10,
  height = 10,
  levels = 1,
  levelByteLength = 144,
}) {
  const headerBytes = 80 + levels * 24;
  const buffer = new ArrayBuffer(headerBytes + levelByteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(KTX2_IDENTIFIER, 0);
  const view = new DataView(buffer);
  view.setUint32(12, vkFormat, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, levels, true);
  view.setUint32(44, 0, true);
  view.setBigUint64(80, BigInt(headerBytes), true);
  view.setBigUint64(88, BigInt(levelByteLength), true);
  view.setBigUint64(96, BigInt(levelByteLength), true);
  bytes.fill(7, headerBytes);
  return buffer;
}

function createBasisLzEtc1s3DKtx2({
  width = 8,
  height = 4,
  depth = 2,
}) {
  const levelBytes = 10;
  const endpointData = new Uint8Array([1]);
  const selectorData = new Uint8Array([2]);
  const tableData = new Uint8Array([3]);
  const imageDescBytes = depth * 20;
  const sgdLength = 20 + imageDescBytes + endpointData.byteLength + selectorData.byteLength + tableData.byteLength;
  const headerBytes = 80 + 24;
  const sgdOffset = headerBytes;
  const levelOffset = sgdOffset + sgdLength;
  const buffer = new ArrayBuffer(levelOffset + levelBytes);
  const bytes = new Uint8Array(buffer);
  bytes.set(KTX2_IDENTIFIER, 0);
  const view = new DataView(buffer);
  view.setUint32(12, 0, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, depth, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, 1, true);
  view.setUint32(44, 1, true);
  view.setBigUint64(64, BigInt(sgdOffset), true);
  view.setBigUint64(72, BigInt(sgdLength), true);
  view.setBigUint64(80, BigInt(levelOffset), true);
  view.setBigUint64(88, BigInt(levelBytes), true);
  view.setBigUint64(96, 0n, true);

  const sgdView = new DataView(buffer, sgdOffset, sgdLength);
  sgdView.setUint16(0, 1, true);
  sgdView.setUint16(2, 1, true);
  sgdView.setUint32(4, endpointData.byteLength, true);
  sgdView.setUint32(8, selectorData.byteLength, true);
  sgdView.setUint32(12, tableData.byteLength, true);
  sgdView.setUint32(16, 0, true);
  for (let slice = 0; slice < depth; slice++) {
    const descOffset = 20 + slice * 20;
    sgdView.setUint32(descOffset, 0, true);
    sgdView.setUint32(descOffset + 4, slice * 5, true);
    sgdView.setUint32(descOffset + 8, 5, true);
    sgdView.setUint32(descOffset + 12, 0, true);
    sgdView.setUint32(descOffset + 16, 0, true);
  }
  let offset = sgdOffset + 20 + imageDescBytes;
  bytes.set(endpointData, offset);
  offset += endpointData.byteLength;
  bytes.set(selectorData, offset);
  offset += selectorData.byteLength;
  bytes.set(tableData, offset);
  bytes.fill(9, levelOffset, levelOffset + levelBytes);
  return buffer;
}

function createMockDevice() {
  const log = [];
  const device = {
    features: new Set(),
    createTexture(descriptor) {
      log.push(['createTexture', descriptor]);
      return { descriptor, destroy() {} };
    },
    createBuffer(descriptor) {
      const buffer = new ArrayBuffer(descriptor.size);
      log.push(['createBuffer', descriptor]);
      return {
        descriptor,
        getMappedRange() { return buffer; },
        unmap() { log.push(['unmap', descriptor.label]); },
        destroy() { log.push(['destroyBuffer', descriptor.label]); },
      };
    },
    createCommandEncoder(descriptor) {
      log.push(['createCommandEncoder', descriptor]);
      return {
        copyBufferToTexture(source, destination, size) {
          log.push(['copyBufferToTexture', source, destination, size]);
        },
        finish() {
          log.push(['finish']);
          return { type: 'command-buffer' };
        },
      };
    },
    queue: {
      submit(commandBuffers) { log.push(['submit', commandBuffers]); },
      onSubmittedWorkDone() { return Promise.resolve(); },
    },
  };
  return { device, log };
}

function createMockBasisEncoderModule() {
  return {
    KTX2File: class MockKtx2File {
      constructor(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.width = view.getUint32(20, true) || 8;
        this.height = view.getUint32(24, true) || 4;
        this.depth = view.getUint32(28, true) || 0;
      }
      startTranscoding() { return true; }
      getLevels() { return 2; }
      getImageLevelInfo(level, layer) {
        if (this.depth > 0 && layer !== 0) throw new Error(`3D texture should be transcoded as one image, got layer ${layer}.`);
        return {
          alphaFlag: true,
          width: Math.max(1, this.width >> level),
          height: Math.max(1, this.height >> level),
        };
      }
      getImageTranscodedSizeInBytes(level, layer) {
        if (this.depth > 0 && layer !== 0) throw new Error(`3D texture should be transcoded as one image, got layer ${layer}.`);
        const depth = this.depth > 0 ? Math.max(1, this.depth >> level) : 1;
        return Math.max(1, this.width >> level) * Math.max(1, this.height >> level) * depth * 4;
      }
      transcodeImage(output, level, layer, face) {
        if (this.depth > 0 && layer !== 0) return false;
        output.fill((level + 1) * 10 + layer * 2 + face);
        return true;
      }
      close() {}
      delete() {}
    },
  };
}

function createSliceOnlyBasisEncoderModule() {
  return {
    KTX2File: class MockKtx2File {
      constructor(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.width = view.getUint32(20, true) || 8;
        this.height = view.getUint32(24, true) || 4;
        this.depth = view.getUint32(28, true) || 0;
      }
      startTranscoding() { return true; }
      getLevels() { return 2; }
      getImageLevelInfo(level, layer, face) {
        const depth = Math.max(1, this.depth >> level);
        if (face !== 0 || layer >= depth) throw new Error(`Invalid slice ${layer}/${face}.`);
        return {
          alphaFlag: true,
          width: Math.max(1, this.width >> level),
          height: Math.max(1, this.height >> level),
        };
      }
      getImageTranscodedSizeInBytes(level, layer, face) {
        this.getImageLevelInfo(level, layer, face);
        return Math.max(1, this.width >> level) * Math.max(1, this.height >> level) * 4;
      }
      transcodeImage(output, level, layer, face) {
        this.getImageLevelInfo(level, layer, face);
        output.fill((level + 1) * 20 + layer);
        return true;
      }
      close() {}
      delete() {}
    },
  };
}

function createRawUastcBasisEncoderModule() {
  return {
    KTX2File: class MockKtx2File {
      startTranscoding() { return false; }
      getLevels() { return 0; }
      getImageLevelInfo() { throw new Error('KTX2File path should not be used for raw UASTC volumes.'); }
      getImageTranscodedSizeInBytes() { return 0; }
      transcodeImage() { return false; }
      close() {}
      delete() {}
    },
    transcodeUASTCImage(
      targetFormat,
      output,
      outputSize,
      compressed,
      blocksX,
      blocksY,
      width,
      height,
      level,
      sliceOffset,
      sliceLength,
    ) {
      assert.equal(targetFormat, 13);
      assert.equal(outputSize, width * height);
      assert.equal(sliceLength, blocksX * blocksY * 16);
      assert.equal(compressed[sliceOffset], level + 1);
      output.fill((level + 1) * 30 + sliceOffset / sliceLength);
      return true;
    },
  };
}

function createEtc1sBasisEncoderModule() {
  return {
    KTX2File: class MockKtx2File {
      startTranscoding() { return false; }
      getLevels() { return 0; }
      getImageLevelInfo() { throw new Error('KTX2File path should not be used for ETC1S volumes.'); }
      getImageTranscodedSizeInBytes() { return 0; }
      transcodeImage() { return false; }
      close() {}
      delete() {}
    },
    LowLevelETC1SImageTranscoder: class MockLowLevelETC1SImageTranscoder {
      decodePalettes(endpointCount, endpointData, selectorCount, selectorData) {
        assert.equal(endpointCount, 1);
        assert.equal(endpointData[0], 1);
        assert.equal(selectorCount, 1);
        assert.equal(selectorData[0], 2);
        return true;
      }
      decodeTables(tableData) {
        assert.equal(tableData[0], 3);
        return true;
      }
      transcodeImage(
        targetFormat,
        output,
        outputSize,
        compressed,
        blocksX,
        blocksY,
        width,
        height,
        level,
        rgbOffset,
        rgbLength,
      ) {
        assert.equal(targetFormat, 13);
        assert.equal(outputSize, width * height);
        assert.equal(rgbLength, 5);
        assert.equal(compressed[rgbOffset], 9);
        output.fill((level + 1) * 40 + rgbOffset / rgbLength + blocksX + blocksY);
        return true;
      }
      delete() {}
    },
  };
}

class FakeKtx2Worker {
  listeners = new Set();
  requests = [];
  terminated = false;

  addEventListener(type, listener) {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(message) {
    this.requests.push(message);
    queueMicrotask(() => {
      this.emit({
        version: 1,
        id: message.id,
        ok: true,
        value: {
          width: 2,
          height: 2,
          depth: 0,
          layerCount: 1,
          faceCount: 1,
          levelCount: 1,
          format: 'rgba8unorm',
          blockWidth: 1,
          blockHeight: 1,
          bytesPerBlock: 4,
          uploadPath: 'basis-transcode',
          levels: [{ width: 2, height: 2, depthOrArrayLayers: 1, data: new Uint8Array(16) }],
        },
      });
    });
  }

  emit(data) {
    for (const listener of this.listeners) listener({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

class ControlledKtx2Worker {
  listeners = new Map();
  requests = [];
  active = 0;
  maxActive = 0;
  terminateCalls = 0;

  constructor() {
    ControlledKtx2Worker.instances.push(this);
  }

  static instances = [];

  addEventListener(type, listener) {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message) {
    this.requests.push({ message, answered: false });
    if (message.type === 'prepareKtx2TexturePayload') {
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
    } else if (message.type === 'cancel') {
      const cancelled = this.requests.find(entry =>
        !entry.answered
        && entry.message.type === 'prepareKtx2TexturePayload'
        && entry.message.id === message.id);
      if (cancelled) {
        cancelled.answered = true;
        this.active--;
      }
    }
  }

  respondNext(error = null) {
    const request = this.requests.find(entry =>
      !entry.answered && entry.message.type === 'prepareKtx2TexturePayload');
    if (!request) return false;
    request.answered = true;
    this.active--;
    const { id, label } = request.message;
    this.emit(error
      ? {
          version: 1,
          id,
          ok: false,
          error: {
            name: 'EngineError',
            domain: 'asset',
            code: 'E_ASSET_LOAD_FAILED',
            message: error,
            recoverable: true,
            recovery: 'retry',
            context: { label, resourceType: 'texture/ktx2' },
            path: 'ktx2.worker.transcode',
          },
        }
      : { version: 1, id, ok: true, value: createWorkerPayload() });
    return true;
  }

  emit(data) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }

  crash(type = 'error') {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === 'messageerror' ? { data: null } : new Event('error'));
    }
  }

  terminate() {
    this.terminateCalls++;
  }
}

function createWorkerPayload() {
  return {
    width: 2,
    height: 2,
    depth: 0,
    layerCount: 1,
    faceCount: 1,
    levelCount: 1,
    format: 'rgba8unorm',
    blockWidth: 1,
    blockHeight: 1,
    bytesPerBlock: 4,
    uploadPath: 'basis-transcode',
    levels: [{ width: 2, height: 2, depthOrArrayLayers: 1, data: new Uint8Array(16) }],
  };
}

function restoreGlobalWorker(originalWorker) {
  if (originalWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = originalWorker;
}

test('Ktx2TextureWorkerClient requests worker prepared payloads', async () => {
  const fakeWorker = new FakeKtx2Worker();
  const client = new Ktx2TextureWorkerClient(fakeWorker);
  const buffer = new ArrayBuffer(4);
  const payload = await client.prepareTexturePayload(buffer, 'worker.ktx2', ['texture-compression-bc'], { basisTranscoderCDN: null });

  assert.equal(payload.uploadPath, 'basis-transcode');
  assert.equal(fakeWorker.requests.length, 1);
  assert.equal(fakeWorker.requests[0].label, 'worker.ktx2');
  assert.deepEqual(fakeWorker.requests[0].deviceFeatures, ['texture-compression-bc']);

  client.dispose();
  assert.equal(fakeWorker.terminated, true);
});

test('public KTX2 worker factory runs independent textures through a bounded four-worker pool', async () => {
  const originalWorker = globalThis.Worker;
  ControlledKtx2Worker.instances = [];
  globalThis.Worker = ControlledKtx2Worker;
  let pool;
  try {
    pool = createKtx2TextureWorkerClientFromUrl('ktx2-worker.mjs', { maxWorkers: 99 });
    const pending = Array.from({ length: 7 }, (_, index) =>
      pool.prepareTexturePayload(new ArrayBuffer(8), `texture-${index}.ktx2`, []));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(ControlledKtx2Worker.instances.length, 4);
    assert.equal(ControlledKtx2Worker.instances.reduce(
      (total, worker) => total + worker.requests.filter(entry =>
        entry.message.type === 'prepareKtx2TexturePayload').length,
      0,
    ), 4);
    for (const worker of ControlledKtx2Worker.instances) {
      assert.equal(worker.maxActive, 1);
      worker.respondNext();
    }
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(ControlledKtx2Worker.instances.reduce(
      (total, worker) => total + worker.requests.filter(entry =>
        entry.message.type === 'prepareKtx2TexturePayload').length,
      0,
    ), 7);
    for (const worker of ControlledKtx2Worker.instances) {
      while (worker.respondNext()) { /* Resolve the second pool wave. */ }
    }
    assert.equal((await Promise.all(pending)).length, 7);

    pool.dispose();
    pool.dispose();
    assert.equal(ControlledKtx2Worker.instances.every(worker => worker.terminateCalls === 1), true);
  } finally {
    pool?.dispose();
    restoreGlobalWorker(originalWorker);
  }
});

test('KTX2 worker pool rejects queue overflow with a structured diagnostic', async () => {
  const originalWorker = globalThis.Worker;
  ControlledKtx2Worker.instances = [];
  globalThis.Worker = ControlledKtx2Worker;
  let pool;
  try {
    pool = createKtx2TextureWorkerClientFromUrl('ktx2-worker.mjs', { maxWorkers: 1 });
    const accepted = Array.from({ length: 65 }, (_, index) =>
      pool.prepareTexturePayload(new ArrayBuffer(8), `queued-${index}.ktx2`, []));
    const settled = Promise.allSettled(accepted);
    await assert.rejects(
      pool.prepareTexturePayload(new ArrayBuffer(8), 'overflow.ktx2', []),
      error => error.code === 'E_WORKER_PROTOCOL_INVALID'
        && error.path === 'ktx2.workerPool.queue'
        && error.context.maxQueued === 64,
    );
    pool.dispose();
    await settled;
  } finally {
    pool?.dispose();
    restoreGlobalWorker(originalWorker);
  }
});

test('KTX2 worker pool cancels queued and active work without poisoning the next request', async () => {
  const originalWorker = globalThis.Worker;
  ControlledKtx2Worker.instances = [];
  globalThis.Worker = ControlledKtx2Worker;
  let pool;
  try {
    pool = createKtx2TextureWorkerClientFromUrl('ktx2-worker.mjs', { maxWorkers: 1 });
    const first = pool.prepareTexturePayload(new ArrayBuffer(8), 'first.ktx2', []);
    const queuedController = new AbortController();
    const queued = pool.prepareTexturePayload(
      new ArrayBuffer(8),
      'queued.ktx2',
      [],
      {},
      queuedController.signal,
    );
    queuedController.abort('skip-queued');
    await assert.rejects(queued, error => error.name === 'AbortError');
    assert.equal(ControlledKtx2Worker.instances[0].requests.length, 1);

    ControlledKtx2Worker.instances[0].respondNext();
    await first;
    const activeController = new AbortController();
    const active = pool.prepareTexturePayload(
      new ArrayBuffer(8),
      'active.ktx2',
      [],
      {},
      activeController.signal,
    );
    await new Promise(resolve => setImmediate(resolve));
    activeController.abort('stop-active');
    await assert.rejects(active, error => error.name === 'AbortError');
    assert.equal(ControlledKtx2Worker.instances[0].requests.some(
      entry => entry.message.type === 'cancel',
    ), true);

    const next = pool.prepareTexturePayload(new ArrayBuffer(8), 'next.ktx2', []);
    await new Promise(resolve => setImmediate(resolve));
    ControlledKtx2Worker.instances[0].respondNext();
    assert.equal((await next).width, 2);
  } finally {
    pool?.dispose();
    restoreGlobalWorker(originalWorker);
  }
});

test('KTX2 worker pool preserves structured transcode errors and continues dispatching', async () => {
  const originalWorker = globalThis.Worker;
  ControlledKtx2Worker.instances = [];
  globalThis.Worker = ControlledKtx2Worker;
  let pool;
  try {
    pool = createKtx2TextureWorkerClientFromUrl('ktx2-worker.mjs', { maxWorkers: 1 });
    const failed = pool.prepareTexturePayload(new ArrayBuffer(8), 'broken.ktx2', []);
    ControlledKtx2Worker.instances[0].respondNext('basis transcoder failed');
    await assert.rejects(
      failed,
      error => error.code === 'E_ASSET_LOAD_FAILED'
        && error.path === 'ktx2.worker.transcode'
        && error.context.label === 'broken.ktx2',
    );

    const recovered = pool.prepareTexturePayload(new ArrayBuffer(8), 'healthy.ktx2', []);
    await new Promise(resolve => setImmediate(resolve));
    ControlledKtx2Worker.instances[0].respondNext();
    assert.equal((await recovered).uploadPath, 'basis-transcode');
  } finally {
    pool?.dispose();
    restoreGlobalWorker(originalWorker);
  }
});

test('KTX2 worker pool retires crashed workers and rejects queued work without hanging', async () => {
  const originalWorker = globalThis.Worker;
  ControlledKtx2Worker.instances = [];
  globalThis.Worker = ControlledKtx2Worker;
  let pool;
  try {
    pool = createKtx2TextureWorkerClientFromUrl('ktx2-worker.mjs', { maxWorkers: 1 });
    const active = pool.prepareTexturePayload(new ArrayBuffer(8), 'active.ktx2', []);
    const queued = pool.prepareTexturePayload(new ArrayBuffer(8), 'queued.ktx2', []);
    ControlledKtx2Worker.instances[0].crash('error');

    await assert.rejects(
      active,
      error => error.code === 'E_WORKER_PROTOCOL_INVALID'
        && error.path === 'ktx2.worker.error',
    );
    await assert.rejects(
      queued,
      error => error.code === 'E_WORKER_PROTOCOL_INVALID'
        && error.path === 'ktx2.workerPool',
    );
    assert.equal(ControlledKtx2Worker.instances[0].terminateCalls, 1);

    await assert.rejects(
      pool.prepareTexturePayload(new ArrayBuffer(8), 'after-crash.ktx2', []),
      error => error.code === 'E_WORKER_PROTOCOL_INVALID'
        && error.path === 'ktx2.workerPool',
    );
  } finally {
    pool?.dispose();
    restoreGlobalWorker(originalWorker);
  }
});

test('Ktx2TextureWorkerClient rejects message deserialization failures', async () => {
  const worker = new ControlledKtx2Worker();
  const client = new Ktx2TextureWorkerClient(worker);
  const pending = client.prepareTexturePayload(
    new ArrayBuffer(8),
    'message-error.ktx2',
    [],
  );
  worker.crash('messageerror');
  await assert.rejects(
    pending,
    error => error.code === 'E_WORKER_PROTOCOL_INVALID'
      && error.path === 'ktx2.worker.messageerror',
  );
  assert.equal(worker.terminateCalls, 1);
  client.dispose();
  assert.equal(worker.terminateCalls, 1);
});

test('uploadKtx2Texture transcodes Basis 2D arrays per layer', async () => {
  const { device, log } = createMockDevice();
  await uploadKtx2Texture(device, createKtx2Header({ layers: 3 }), 'basis-array.ktx2', undefined, {
    basisEncoderModule: createMockBasisEncoderModule(),
  });

  const textureDescriptor = log.find(entry => entry[0] === 'createTexture')[1];
  assert.deepEqual(textureDescriptor.size, [8, 4, 3]);
  assert.equal(textureDescriptor.dimension, '2d');
  assert.equal(textureDescriptor.format, 'rgba8unorm');

  const copies = log.filter(entry => entry[0] === 'copyBufferToTexture');
  assert.equal(copies.length, 2);
  assert.deepEqual(copies[0][3], { width: 8, height: 4, depthOrArrayLayers: 3 });
  assert.deepEqual(copies[1][3], { width: 4, height: 2, depthOrArrayLayers: 3 });
});

test('prepareKtx2TexturePayload separates CPU transcode from GPU upload', async () => {
  const payload = await prepareKtx2TexturePayload([], createKtx2Header({ layers: 2, levels: 1 }), 'basis-payload.ktx2', {
    basisEncoderModule: createMockBasisEncoderModule(),
  });

  assert.equal(payload.uploadPath, 'basis-transcode');
  assert.equal(payload.format, 'rgba8unorm');
  assert.deepEqual(payload.levels.map(level => ({
    width: level.width,
    height: level.height,
    depthOrArrayLayers: level.depthOrArrayLayers,
    bytes: level.data.byteLength,
  })), [{ width: 8, height: 4, depthOrArrayLayers: 2, bytes: 256 }]);

  const { device, log } = createMockDevice();
  uploadPreparedKtx2Texture(device, payload, 'basis-payload.ktx2');
  const copy = log.find(entry => entry[0] === 'copyBufferToTexture');
  assert.deepEqual(copy[3], { width: 8, height: 4, depthOrArrayLayers: 2 });
});

test('Basis KTX2File handles UASTC Zstd supercompression without a GPU-native decoder', async () => {
  const payload = await prepareKtx2TexturePayload(
    [],
    createKtx2Header({ supercompression: 2 }),
    'basis-uastc-zstd.ktx2',
    { basisEncoderModule: createMockBasisEncoderModule() },
  );
  assert.equal(payload.uploadPath, 'basis-transcode');
  assert.ok(payload.levels[0].data.byteLength > 0);
});

test('AssetManager splits a large KTX2 upload into frame-budgeted row chunks', async () => {
  const { device, log } = createMockDevice();
  const manager = new AssetManager(device, undefined, { uploadBudgetBytes: 512 });
  const phases = [];
  manager.registerLoader(createKtx2TextureLoader({
    diagnostics: { onPhase: event => phases.push(event) },
  }));
  const url = 'budgeted-rgba8.ktx2';
  const source = createGpuNativeKtx2({ vkFormat: 37, width: 64, height: 16, levelByteLength: 4096 });
  manager.cache.network.set(`network:ktx2:${url}`, source, source.byteLength);
  const handle = await manager.loadAsset('texture/ktx2', url);
  const buffers = log.filter(entry => entry[0] === 'createBuffer').map(entry => entry[1]);
  assert.equal(buffers.length, 8);
  assert.equal(buffers.every(descriptor => descriptor.size <= 512), true);
  assert.equal(log.filter(entry => entry[0] === 'copyBufferToTexture').length, 8);
  assert.equal(manager.uploads.snapshot().pendingTasks, 0);
  assert.deepEqual(phases.map(event => event.phase), ['decode-transcode', 'gpu-upload']);
  assert.equal(phases.every(event => event.endedAt >= event.startedAt && event.bytes > 0), true);
  assert.equal(manager.cache.forDevice(device).snapshot().entries, 1);
  handle.release();
  assert.equal(manager.cache.forDevice(device).snapshot().entries, 0);
  manager.dispose();
});

test('AssetManager coalesces independent KTX2 mip and layer copies into one budgeted submission', async () => {
  const { device, log } = createMockDevice();
  const manager = new AssetManager(device, undefined, { uploadBudgetBytes: 8 * 1024 });
  manager.registerLoader(createKtx2TextureLoader({
    basisEncoderModule: createMockBasisEncoderModule(),
  }));
  const url = 'coalesced-array.ktx2';
  const source = createKtx2Header({ layers: 3, levels: 2 });
  manager.cache.network.set(`network:ktx2:${url}`, source, source.byteLength);
  const handle = await manager.loadAsset('texture/ktx2', url);

  const buffers = log.filter(entry => entry[0] === 'createBuffer');
  const copies = log.filter(entry => entry[0] === 'copyBufferToTexture');
  assert.equal(buffers.length, 1);
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map(entry => ({
    mipLevel: entry[2].mipLevel,
    depthOrArrayLayers: entry[3].depthOrArrayLayers,
  })), [
    { mipLevel: 0, depthOrArrayLayers: 3 },
    { mipLevel: 1, depthOrArrayLayers: 3 },
  ]);
  assert.equal(log.filter(entry => entry[0] === 'submit').length, 1);
  const uploads = manager.uploads.snapshot();
  assert.equal(uploads.uploadCalls, 1);
  assert.equal(uploads.maxFrameUploadedBytes <= uploads.frameBudgetBytes, true);
  assert.equal(uploads.pendingTasks, 0);

  handle.release();
  manager.dispose();
});

test('KTX2 parsed cache and texture wrapper recover on a replacement device', async () => {
  const first = createMockDevice();
  const second = createMockDevice();
  const manager = new AssetManager(first.device);
  let prepareCalls = 0;
  manager.registerLoader(createKtx2TextureLoader({
    textureWorker: {
      async prepareTexturePayload() {
        prepareCalls++;
        return createWorkerPayload();
      },
    },
  }));
  const url = 'recover.ktx2';
  const source = new ArrayBuffer(16);
  manager.cache.network.set(`network:ktx2:${url}`, source, source.byteLength);
  const handle = await manager.loadTexture({
    kind: 'compressed-texture',
    type: 'texture/ktx2',
    src: url,
  }, { cacheKey: 'recoverable-ktx2' });
  const originalTexture = handle.value;

  manager.suspendForDeviceLoss();
  assert.deepEqual(await manager.recoverDevice(second.device, new AbortController().signal), []);
  assert.notEqual(handle.value, originalTexture);
  assert.equal(prepareCalls, 1);
  assert.equal(manager.uploads.snapshot().pendingTasks, 0);

  handle.release();
  manager.dispose();
});

test('uploadKtx2Texture transcodes Basis cubemaps as six 2D layers', async () => {
  const { device, log } = createMockDevice();
  await uploadKtx2Texture(device, createKtx2Header({ faces: 6, levels: 1 }), 'basis-cube.ktx2', undefined, {
    basisEncoderModule: createMockBasisEncoderModule(),
  });

  const textureDescriptor = log.find(entry => entry[0] === 'createTexture')[1];
  assert.deepEqual(textureDescriptor.size, [8, 4, 6]);
  assert.equal(textureDescriptor.dimension, '2d');

  const copy = log.find(entry => entry[0] === 'copyBufferToTexture');
  assert.deepEqual(copy[3], { width: 8, height: 4, depthOrArrayLayers: 6 });
});

test('uploadKtx2Texture transcodes Basis 3D textures as uncompressed volume slices', async () => {
  const { device, log } = createMockDevice();
  await uploadKtx2Texture(device, createKtx2Header({ depth: 4 }), 'basis-volume.ktx2', undefined, {
    basisEncoderModule: createMockBasisEncoderModule(),
  });

  const textureDescriptor = log.find(entry => entry[0] === 'createTexture')[1];
  assert.deepEqual(textureDescriptor.size, [8, 4, 4]);
  assert.equal(textureDescriptor.dimension, '3d');
  assert.equal(textureDescriptor.format, 'rgba8unorm');

  const copies = log.filter(entry => entry[0] === 'copyBufferToTexture');
  assert.deepEqual(copies[0][3], { width: 8, height: 4, depthOrArrayLayers: 4 });
  assert.deepEqual(copies[1][3], { width: 4, height: 2, depthOrArrayLayers: 2 });
});

test('uploadKtx2Texture falls back to per-slice Basis 3D transcoding', async () => {
  const { device, log } = createMockDevice();
  await uploadKtx2Texture(device, createKtx2Header({ depth: 4 }), 'basis-volume-slices.ktx2', undefined, {
    basisEncoderModule: createSliceOnlyBasisEncoderModule(),
  });

  const textureDescriptor = log.find(entry => entry[0] === 'createTexture')[1];
  assert.deepEqual(textureDescriptor.size, [8, 4, 4]);
  assert.equal(textureDescriptor.dimension, '3d');
  assert.equal(textureDescriptor.format, 'rgba8unorm');

  const copies = log.filter(entry => entry[0] === 'copyBufferToTexture');
  assert.deepEqual(copies[0][3], { width: 8, height: 4, depthOrArrayLayers: 4 });
  assert.deepEqual(copies[1][3], { width: 4, height: 2, depthOrArrayLayers: 2 });
});

test('uploadKtx2Texture transcodes raw UASTC 3D KTX2 through low-level slices', async () => {
  const { device, log } = createMockDevice();
  await uploadKtx2Texture(device, createRawUastc3DKtx2({ depth: 2, levels: 1 }), 'raw-uastc-volume.ktx2', undefined, {
    basisEncoderModule: createRawUastcBasisEncoderModule(),
  });

  const textureDescriptor = log.find(entry => entry[0] === 'createTexture')[1];
  assert.deepEqual(textureDescriptor.size, [8, 4, 2]);
  assert.equal(textureDescriptor.dimension, '3d');
  assert.equal(textureDescriptor.format, 'rgba8unorm');

  const copy = log.find(entry => entry[0] === 'copyBufferToTexture');
  assert.deepEqual(copy[3], { width: 8, height: 4, depthOrArrayLayers: 2 });
});

test('uploadKtx2Texture transcodes BasisLZ ETC1S 3D KTX2 through low-level slices', async () => {
  const { device, log } = createMockDevice();
  await uploadKtx2Texture(device, createBasisLzEtc1s3DKtx2({ depth: 2 }), 'etc1s-volume.ktx2', undefined, {
    basisEncoderModule: createEtc1sBasisEncoderModule(),
  });

  const textureDescriptor = log.find(entry => entry[0] === 'createTexture')[1];
  assert.deepEqual(textureDescriptor.size, [8, 4, 2]);
  assert.equal(textureDescriptor.dimension, '3d');
  assert.equal(textureDescriptor.format, 'rgba8unorm');

  const copy = log.find(entry => entry[0] === 'copyBufferToTexture');
  assert.deepEqual(copy[3], { width: 8, height: 4, depthOrArrayLayers: 2 });
});

test('uploadKtx2Texture aligns compressed copy extents to block size', async () => {
  const { device, log } = createMockDevice();
  device.features.add('texture-compression-astc');
  await uploadKtx2Texture(device, createGpuNativeKtx2({ vkFormat: 158 }), 'astc.ktx2');

  const copy = log.find(entry => entry[0] === 'copyBufferToTexture');
  assert.deepEqual(copy[3], { width: 12, height: 12, depthOrArrayLayers: 1 });
});
