import type { IEngine } from '../core/IEngine';
import { requireEngineDevice } from '../core/IEngine';

const INDEXED_DRAW_INDIRECT_BYTES = 20;
const DRAW_INDIRECT_BYTES = 16;

export class IndirectDrawCommandBuffer {
  readonly indexedBuffer: GPUBuffer;
  readonly drawBuffer: GPUBuffer;

  private readonly _indexedData = new Uint32Array(5);
  private readonly _drawData = new Uint32Array(4);
  private readonly _device: GPUDevice;

  constructor(engine: IEngine, label = 'IndirectDrawCommandBuffer') {
    this._device = requireEngineDevice(engine);
    this.indexedBuffer = this._device.createBuffer({
      label: `${label}.indexed`,
      size: INDEXED_DRAW_INDIRECT_BYTES,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    this.drawBuffer = this._device.createBuffer({
      label: `${label}.draw`,
      size: DRAW_INDIRECT_BYTES,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
  }

  writeIndexed(indexCount: number, instanceCount: number, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
    this._indexedData[0] = indexCount >>> 0;
    this._indexedData[1] = instanceCount >>> 0;
    this._indexedData[2] = firstIndex >>> 0;
    this._indexedData[3] = baseVertex >>> 0;
    this._indexedData[4] = firstInstance >>> 0;
    this._device.queue.writeBuffer(this.indexedBuffer, 0, this._indexedData);
  }

  write(vertexCount: number, instanceCount: number, firstVertex = 0, firstInstance = 0): void {
    this._drawData[0] = vertexCount >>> 0;
    this._drawData[1] = instanceCount >>> 0;
    this._drawData[2] = firstVertex >>> 0;
    this._drawData[3] = firstInstance >>> 0;
    this._device.queue.writeBuffer(this.drawBuffer, 0, this._drawData);
  }

  destroy(): void {
    this.indexedBuffer.destroy();
    this.drawBuffer.destroy();
  }
}
