import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { ComputePassBase } from './ComputePassBase';
import { getBuiltinComputeShaderDefinition } from '../shader/BuiltinComputeShader';
import {
  recordComputeResourcePass,
  type ComputeResourcePassToken,
} from './ComputeResourceAccess';
import type { ComputePassOrderOptions } from './GpuDrawCommandComputePass';

const SORT_PARAM_BYTES = 32;
const SORT_SHADER = getBuiltinComputeShaderDefinition('gpu-sort-bitonic');

export interface GpuSortableBuffers {
  sortKeyBuffer: GPUBuffer;
  sortIndexBuffer: GPUBuffer;
  count: number;
  paddedCapacity: number;
  keyWords?: number;
}

interface SortPassParam {
  j: number;
  k: number;
}

export class GpuSortComputePass extends ComputePassBase {
  private _paramsCapacity = 0;
  private readonly _paramsBuffers: GPUBuffer[] = [];
  private readonly _paramsData = new Uint32Array(SORT_PARAM_BYTES / 4);
  private readonly _bindGroups: (GPUBindGroup | null)[] = [];
  private _boundKeys: GPUBuffer | null = null;
  private _boundIndices: GPUBuffer | null = null;

  constructor(engine: IEngine, label = 'GpuSortComputePass') {
    super(engine, {
      label,
      shaderCode: SORT_SHADER.shaderCode,
      entryPoint: SORT_SHADER.entryPoint,
      bindGroupLayoutEntries: [...SORT_SHADER.bindGroupLayoutEntries],
    });
  }

  sort(
    context: RenderCommandContext,
    buffers: GpuSortableBuffers,
    order: ComputePassOrderOptions = {},
  ): ComputeResourcePassToken | null {
    validateSortableBuffers(buffers);
    if (buffers.count <= 1 || buffers.paddedCapacity <= 1) return null;
    const path = order.path ?? `${this.label}.resources`;
    const token = recordComputeResourcePass(context, {
      label: this.label,
      path,
      after: order.after,
      accesses: [
        { resource: buffers.sortKeyBuffer, use: 'storage-read', path: `${path}.sortKeyBuffer` },
        { resource: buffers.sortIndexBuffer, use: 'storage-read-write', path: `${path}.sortIndexBuffer` },
      ],
    });
    this._prepare();
    const pipeline = this.pipeline;
    if (!pipeline) return token;

    const passParams = buildBitonicPassParams(buffers.paddedCapacity);
    if (!this._ensureParams(passParams.length)) return token;
    this._writeParams(buffers.count, buffers.paddedCapacity, buffers.keyWords ?? 1, passParams);
    this._invalidateBindGroupsFor(buffers.sortKeyBuffer, buffers.sortIndexBuffer);

    const pass = context.encoder.beginComputePass({ label: this.label });
    pass.setPipeline(pipeline);
    const workgroups = Math.ceil(buffers.paddedCapacity / 64);
    for (let i = 0; i < passParams.length; i++) {
      const bindGroup = this._getBindGroup(buffers.sortKeyBuffer, buffers.sortIndexBuffer, i);
      if (!bindGroup) continue;
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(workgroups);
    }
    pass.end();
    return token;
  }

  override destroy(): void {
    for (const buffer of this._paramsBuffers) this.destroyStorageBuffer(buffer);
    this._paramsBuffers.length = 0;
    this._bindGroups.length = 0;
    this._paramsCapacity = 0;
    this._boundKeys = null;
    this._boundIndices = null;
    super.destroy();
  }

  private _prepare(): void {
    this.prepare();
  }

  private _ensureParams(passCount: number): boolean {
    if (passCount <= this._paramsCapacity && this._paramsBuffers.length >= passCount) return true;
    const device = this.engine.device;
    if (!device) return false;
    const capacity = nextCapacityFor(passCount);
    for (let i = this._paramsBuffers.length; i < capacity; i++) {
      const buffer = this.createStorageBuffer(`${this.label}.params.${i}`, SORT_PARAM_BYTES);
      if (!buffer) return false;
      this._paramsBuffers.push(buffer);
      this._bindGroups.push(null);
    }
    this._paramsCapacity = capacity;
    return true;
  }

  private _writeParams(elementCount: number, paddedCount: number, keyWords: number, passParams: readonly SortPassParam[]): void {
    for (let i = 0; i < passParams.length; i++) {
      const paramsBuffer = this._paramsBuffers[i];
      const pass = passParams[i];
      if (!paramsBuffer || !pass) continue;
      this._paramsData[0] = elementCount >>> 0;
      this._paramsData[1] = paddedCount >>> 0;
      this._paramsData[2] = pass.j >>> 0;
      this._paramsData[3] = pass.k >>> 0;
      this._paramsData[4] = keyWords >>> 0;
      this._paramsData[5] = 0;
      this._paramsData[6] = 0;
      this._paramsData[7] = 0;
      this.engine.device?.queue.writeBuffer(
        paramsBuffer,
        0,
        this._paramsData.buffer as ArrayBuffer,
        this._paramsData.byteOffset,
        SORT_PARAM_BYTES,
      );
    }
  }

  private _invalidateBindGroupsFor(keys: GPUBuffer, indices: GPUBuffer): void {
    if (this._boundKeys === keys && this._boundIndices === indices) return;
    this._bindGroups.fill(null);
    this._boundKeys = keys;
    this._boundIndices = indices;
  }

  private _getBindGroup(keys: GPUBuffer, indices: GPUBuffer, passIndex: number): GPUBindGroup | null {
    const cached = this._bindGroups[passIndex];
    if (cached) return cached;
    const paramsBuffer = this._paramsBuffers[passIndex];
    if (!paramsBuffer) return null;
    const bindGroup = this.createBindGroup(`${this.label}.bindGroup.${passIndex}`, [
      { binding: 0, resource: { buffer: keys } },
      { binding: 1, resource: { buffer: indices } },
      { binding: 2, resource: { buffer: paramsBuffer, size: SORT_PARAM_BYTES } },
    ]);
    if (bindGroup) {
      this._bindGroups[passIndex] = bindGroup;
    }
    return bindGroup;
  }
}

function buildBitonicPassParams(paddedCount: number): SortPassParam[] {
  const params: SortPassParam[] = [];
  for (let k = 2; k <= paddedCount; k <<= 1) {
    for (let j = k >> 1; j > 0; j >>= 1) {
      params.push({ j, k });
    }
  }
  return params;
}

function nextCapacityFor(required: number): number {
  let capacity = 8;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function validateSortableBuffers(buffers: GpuSortableBuffers): void {
  if (!Number.isInteger(buffers.count) || buffers.count < 0) {
    throw new EngineError(
      EngineErrorCode.ComputeInvalidParameter,
      `GpuSortComputePass count must be a non-negative integer; received ${buffers.count}.`,
      {
        hint: 'Pass the number of valid elements in the sort buffers.',
        docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
      },
    );
  }
  if (!Number.isInteger(buffers.paddedCapacity) || buffers.paddedCapacity < Math.max(1, buffers.count)) {
    throw new EngineError(
      EngineErrorCode.ComputeInvalidParameter,
      `GpuSortComputePass paddedCapacity must be >= count; received paddedCapacity=${buffers.paddedCapacity}, count=${buffers.count}.`,
      {
        hint: 'Use a power-of-two padded capacity that covers all valid elements.',
        docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
      },
    );
  }
  if (buffers.paddedCapacity > 1 && (buffers.paddedCapacity & (buffers.paddedCapacity - 1)) !== 0) {
    throw new EngineError(
      EngineErrorCode.ComputeInvalidParameter,
      `GpuSortComputePass paddedCapacity must be a power of two; received ${buffers.paddedCapacity}.`,
      {
        hint: 'Round the element count up to the next power of two before sorting.',
        docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
      },
    );
  }
  if (buffers.keyWords !== undefined && (!Number.isInteger(buffers.keyWords) || buffers.keyWords < 1 || buffers.keyWords > 8)) {
    throw new EngineError(
      EngineErrorCode.ComputeInvalidParameter,
      `GpuSortComputePass keyWords must be an integer in [1, 8]; received ${buffers.keyWords}.`,
      {
        hint: 'Use one or more u32 words per sort key. Multi-word keys are compared lexicographically.',
        docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
      },
    );
  }
}
