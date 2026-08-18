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

const CULL_PARAM_BYTES = 16;
const FRUSTUM_BYTES = 6 * 4 * 4;
const MESH_CULL_SHADER = getBuiltinComputeShaderDefinition('mesh3d-cull');

export interface Mesh3DGpuCullBuffers {
  commandBuffer: GPUBuffer;
  boundsBuffer: GPUBuffer;
  indexedIndirectBuffer: GPUBuffer;
  drawIndirectBuffer: GPUBuffer;
  count: number;
}

export class Mesh3DGpuCullComputePass extends ComputePassBase {
  private _paramsBuffer: GPUBuffer | null = null;
  private _frustumBuffer: GPUBuffer | null = null;
  private readonly _paramsData = new Uint32Array(4);
  private readonly _frustumData = new Float32Array(24);
  private _bindGroup: GPUBindGroup | null = null;
  private _boundCommands: GPUBuffer | null = null;
  private _boundBounds: GPUBuffer | null = null;
  private _boundIndexed: GPUBuffer | null = null;
  private _boundDraw: GPUBuffer | null = null;

  constructor(engine: IEngine, label = 'Mesh3DGpuCullComputePass') {
    super(engine, {
      label,
      shaderCode: MESH_CULL_SHADER.shaderCode,
      entryPoint: MESH_CULL_SHADER.entryPoint,
      bindGroupLayoutEntries: [...MESH_CULL_SHADER.bindGroupLayoutEntries],
    });
  }

  cull(
    context: RenderCommandContext,
    buffers: Mesh3DGpuCullBuffers,
    frustumPlanes: Float32Array,
    order: ComputePassOrderOptions = {},
  ): ComputeResourcePassToken | null {
    if (!Number.isInteger(buffers.count) || buffers.count < 0) {
      throw new EngineError(
        EngineErrorCode.ComputeInvalidParameter,
        `Mesh3DGpuCullComputePass count must be a non-negative integer; received ${buffers.count}.`,
        {
          hint: 'Pass the number of valid Render3D batch records.',
          docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
        },
      );
    }
    if (buffers.count < 1) return null;
    if (frustumPlanes.length < 24) {
      throw new EngineError(
        EngineErrorCode.ComputeInvalidParameter,
        `Mesh3DGpuCullComputePass requires 24 frustum plane floats; received ${frustumPlanes.length}.`,
        {
          hint: 'Use Frustum.copyPlanesTo() to provide six normalized planes.',
          docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
        },
      );
    }
    const path = order.path ?? `${this.label}.resources`;
    const token = recordComputeResourcePass(context, {
      label: this.label,
      path,
      after: order.after,
      accesses: [
        { resource: buffers.commandBuffer, use: 'storage-read', path: `${path}.commandBuffer` },
        { resource: buffers.boundsBuffer, use: 'storage-read', path: `${path}.boundsBuffer` },
        { resource: buffers.indexedIndirectBuffer, use: 'storage-read-write', path: `${path}.indexedIndirectBuffer` },
        { resource: buffers.drawIndirectBuffer, use: 'storage-read-write', path: `${path}.drawIndirectBuffer` },
      ],
    });
    this._prepare();
    if (!this.pipeline || !this._paramsBuffer || !this._frustumBuffer) return token;
    const bindGroup = this._getBindGroup(buffers);
    if (!bindGroup) return token;

    this._paramsData[0] = buffers.count >>> 0;
    this._frustumData.set(frustumPlanes.subarray(0, 24));
    const queue = this.engine.device?.queue;
    queue?.writeBuffer(this._paramsBuffer, 0, this._paramsData);
    queue?.writeBuffer(this._frustumBuffer, 0, this._frustumData);

    this.dispatch(context, bindGroup, Math.ceil(buffers.count / 64));
    return token;
  }

  override destroy(): void {
    this.destroyUniformBuffer(this._paramsBuffer);
    this.destroyUniformBuffer(this._frustumBuffer);
    this._paramsBuffer = null;
    this._frustumBuffer = null;
    this._bindGroup = null;
    this._boundCommands = null;
    this._boundBounds = null;
    this._boundIndexed = null;
    this._boundDraw = null;
    super.destroy();
  }

  private _prepare(): void {
    if (this.pipeline && this._paramsBuffer && this._frustumBuffer) return;
    this._frustumBuffer ??= this.createUniformBuffer(`${this.label}.frustum`, FRUSTUM_BYTES);
    this._paramsBuffer ??= this.createUniformBuffer(`${this.label}.params`, CULL_PARAM_BYTES);
  }

  private _getBindGroup(buffers: Mesh3DGpuCullBuffers): GPUBindGroup | null {
    if (
      this._bindGroup
      && this._boundCommands === buffers.commandBuffer
      && this._boundBounds === buffers.boundsBuffer
      && this._boundIndexed === buffers.indexedIndirectBuffer
      && this._boundDraw === buffers.drawIndirectBuffer
    ) {
      return this._bindGroup;
    }
    if (!this._frustumBuffer || !this._paramsBuffer) return null;
    this._bindGroup = this.createBindGroup(`${this.label}.bindGroup`, [
      { binding: 0, resource: { buffer: buffers.commandBuffer } },
      { binding: 1, resource: { buffer: buffers.boundsBuffer } },
      { binding: 2, resource: { buffer: buffers.indexedIndirectBuffer } },
      { binding: 3, resource: { buffer: buffers.drawIndirectBuffer } },
      { binding: 4, resource: { buffer: this._frustumBuffer } },
      { binding: 5, resource: { buffer: this._paramsBuffer } },
    ]);
    this._boundCommands = buffers.commandBuffer;
    this._boundBounds = buffers.boundsBuffer;
    this._boundIndexed = buffers.indexedIndirectBuffer;
    this._boundDraw = buffers.drawIndirectBuffer;
    return this._bindGroup;
  }
}
