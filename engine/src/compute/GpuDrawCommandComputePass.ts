import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { ComputePassBase } from './ComputePassBase';
import { getBuiltinComputeShaderDefinition } from '../shader/BuiltinComputeShader';
import {
  recordComputeResourcePass,
  type ComputeResourcePassToken,
} from './ComputeResourceAccess';

const DRAW_COMMAND_PARAM_BYTES = 16;
const DRAW_COMMAND_SHADER = getBuiltinComputeShaderDefinition('gpu-draw-command');

export interface GpuDrawCommandBuffers {
  commandBuffer: GPUBuffer;
  indexedIndirectBuffer: GPUBuffer;
  drawIndirectBuffer: GPUBuffer;
  count: number;
}

export interface ComputePassOrderOptions {
  readonly after?: readonly ComputeResourcePassToken[] | undefined;
  readonly path?: string | undefined;
}

export class GpuDrawCommandComputePass extends ComputePassBase {
  private _paramsBuffer: GPUBuffer | null = null;
  private readonly _paramsData = new Uint32Array(4);
  private _bindGroup: GPUBindGroup | null = null;
  private _boundCommands: GPUBuffer | null = null;
  private _boundIndexed: GPUBuffer | null = null;
  private _boundDraw: GPUBuffer | null = null;

  constructor(engine: IEngine, label = 'GpuDrawCommandComputePass') {
    super(engine, {
      label,
      shaderCode: DRAW_COMMAND_SHADER.shaderCode,
      entryPoint: DRAW_COMMAND_SHADER.entryPoint,
      bindGroupLayoutEntries: [...DRAW_COMMAND_SHADER.bindGroupLayoutEntries],
    });
  }

  generate(
    context: RenderCommandContext,
    buffers: GpuDrawCommandBuffers,
    order: ComputePassOrderOptions = {},
  ): ComputeResourcePassToken | null {
    if (!Number.isInteger(buffers.count) || buffers.count < 0) {
      throw new EngineError(
        EngineErrorCode.ComputeInvalidParameter,
        `GpuDrawCommandComputePass count must be a non-negative integer; received ${buffers.count}.`,
        {
          hint: 'Pass the number of valid draw command records.',
          docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
        },
      );
    }
    if (buffers.count < 1) return null;
    const token = recordComputeResourcePass(context, {
      label: this.label,
      path: order.path ?? `${this.label}.resources`,
      after: order.after,
      accesses: [
        { resource: buffers.commandBuffer, use: 'storage-read', path: `${order.path ?? `${this.label}.resources`}.commandBuffer` },
        { resource: buffers.indexedIndirectBuffer, use: 'storage-write', path: `${order.path ?? `${this.label}.resources`}.indexedIndirectBuffer` },
        { resource: buffers.drawIndirectBuffer, use: 'storage-write', path: `${order.path ?? `${this.label}.resources`}.drawIndirectBuffer` },
      ],
    });
    this._prepare();
    if (!this.pipeline) return token;
    const bindGroup = this._getBindGroup(buffers);
    if (!bindGroup || !this._paramsBuffer) return token;

    this._paramsData[0] = buffers.count >>> 0;
    this.engine.device?.queue.writeBuffer(this._paramsBuffer, 0, this._paramsData);
    this.dispatch(context, bindGroup, Math.ceil(buffers.count / 64));
    return token;
  }

  override destroy(): void {
    this.destroyUniformBuffer(this._paramsBuffer);
    this._paramsBuffer = null;
    this._bindGroup = null;
    this._boundCommands = null;
    this._boundIndexed = null;
    this._boundDraw = null;
    super.destroy();
  }

  private _prepare(): void {
    if (this.pipeline && this._paramsBuffer) return;
    this._paramsBuffer ??= this.createUniformBuffer(`${this.label}.params`, DRAW_COMMAND_PARAM_BYTES);
  }

  private _getBindGroup(buffers: GpuDrawCommandBuffers): GPUBindGroup | null {
    if (
      this._bindGroup
      && this._boundCommands === buffers.commandBuffer
      && this._boundIndexed === buffers.indexedIndirectBuffer
      && this._boundDraw === buffers.drawIndirectBuffer
    ) {
      return this._bindGroup;
    }
    if (!this._paramsBuffer) return null;
    this._bindGroup = this.createBindGroup(`${this.label}.bindGroup`, [
      { binding: 0, resource: { buffer: buffers.commandBuffer } },
      { binding: 1, resource: { buffer: buffers.indexedIndirectBuffer } },
      { binding: 2, resource: { buffer: buffers.drawIndirectBuffer } },
      { binding: 3, resource: { buffer: this._paramsBuffer } },
    ]);
    this._boundCommands = buffers.commandBuffer;
    this._boundIndexed = buffers.indexedIndirectBuffer;
    this._boundDraw = buffers.drawIndirectBuffer;
    return this._bindGroup;
  }
}
