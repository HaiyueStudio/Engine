// GPU timestamp resource ownership and opt-in render/compute measurement.
export class RealRendererGpuTimestampProbe {
  constructor(device, { includeCompute = false } = {}) {
    this.includeCompute = includeCompute;
    this.passKinds = [];
    this.device = device;
    this.supported = device.features?.has?.('timestamp-query') === true;
    this.reason = this.supported
      ? null
      : 'GPU adapter/device does not expose timestamp-query';
    this.queryCount = 0;
    this.passLabels = [];
    this.pendingByteSize = 0;
    if (!this.supported) return;
    this.querySet = device.createQuerySet({
      label: 'benchmark.real-renderer.gpu-timestamp.queries',
      type: 'timestamp',
      count: 256,
    });
    this.resolveBuffer = device.createBuffer({
      label: 'benchmark.real-renderer.gpu-timestamp.resolve',
      size: 256 * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readbackBuffer = device.createBuffer({
      label: 'benchmark.real-renderer.gpu-timestamp.readback',
      size: 256 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  beginFrame() {
    if (!this.supported) return;
    this.queryCount = 0;
    this.passLabels.length = 0;
    this.passKinds.length = 0;
    this.pendingByteSize = 0;
  }

  decorateRenderPass(descriptor) { return this.decoratePass(descriptor, 'render'); }

  decorateComputePass(descriptor) {
    return this.includeCompute ? this.decoratePass(descriptor, 'compute') : descriptor;
  }

  decoratePass(descriptor, kind) {
    if (!this.supported || descriptor.timestampWrites || this.queryCount + 2 > 256) {
      return descriptor;
    }
    const beginningOfPassWriteIndex = this.queryCount;
    const endOfPassWriteIndex = this.queryCount + 1;
    this.queryCount += 2;
    this.passLabels.push(descriptor.label ?? `(unlabeled ${kind} pass)`);
    this.passKinds.push(kind);
    return {
      ...descriptor,
      timestampWrites: {
        querySet: this.querySet,
        beginningOfPassWriteIndex,
        endOfPassWriteIndex,
      },
    };
  }

  resolve(encoder) {
    if (!this.supported || this.queryCount === 0) return;
    this.pendingByteSize = this.queryCount * 8;
    encoder.resolveQuerySet(
      this.querySet,
      0,
      this.queryCount,
      this.resolveBuffer,
      0,
    );
    encoder.copyBufferToBuffer(
      this.resolveBuffer,
      0,
      this.readbackBuffer,
      0,
      this.pendingByteSize,
    );
  }

  async readFrame() {
    if (!this.supported || this.pendingByteSize === 0) {
      return {
        totalMs: 0,
        passes: [],
        passLabels: [],
      };
    }
    await this.readbackBuffer.mapAsync(GPUMapMode.READ, 0, this.pendingByteSize);
    const timestamps = new BigUint64Array(
      this.readbackBuffer.getMappedRange(0, this.pendingByteSize),
    ).slice();
    this.readbackBuffer.unmap();
    const passes = this.passLabels.map((label, index) => {
      const start = timestamps[index * 2] ?? 0n;
      const end = timestamps[index * 2 + 1] ?? 0n;
      return {
        label,
        ...(this.includeCompute ? { kind: this.passKinds[index] } : {}),
        durationMs: end > start ? Number(end - start) / 1_000_000 : 0,
      };
    });
    return {
      totalMs: passes.reduce((total, pass) => total + pass.durationMs, 0),
      ...(this.includeCompute ? { scope: 'render-and-compute-span-v1',
        spanMs: Number(timestamps[timestamps.length - 1] - timestamps[0]) / 1_000_000 } : {}),
      passes,
      passLabels: [...this.passLabels],
    };
  }

  destroy() {
    if (!this.supported) return;
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
