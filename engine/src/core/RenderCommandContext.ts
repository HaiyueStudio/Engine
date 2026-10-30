import type { RenderPassLoadOp } from './renderPassDescriptor';
import { cloneRenderPassDescriptor, getCachedRenderPassDescriptor } from './renderPassDescriptor';
import type { IEngine } from './IEngine';
import { requireEngineDevice } from './IEngine';
import { EngineError, EngineErrorCode } from './EngineError';
import type { FrameData } from '../frame/FrameData';
import type { FrameDiagnostics } from './FrameDiagnostics';
import { cacheRenderPassState } from './RenderPassStateCache';
import {
  RenderView,
  RenderViewFamily,
  getRenderViewPassOptions,
  type RenderViewFamilySnapshot,
  type RenderViewSnapshot,
} from './RenderView';
import {
  GpuPassProfiler,
  type GpuPassTimingLabel,
  type GpuPassTimingRecorder,
} from './GpuPassProfiler';

export type { GpuPassTimingRecorder } from './GpuPassProfiler';
export type RenderGpuPassProfiler = GpuPassProfiler;

export interface RenderCommandContext {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  passEncoder?: GPURenderPassEncoder | undefined;
  descriptor?: GPURenderPassDescriptor | undefined;
  loadOp?: RenderPassLoadOp | undefined;
  frameData?: FrameData | undefined;
  /** Immutable camera/target state for this frame recording. */
  view?: RenderViewSnapshot | undefined;
  /** Immutable views sharing one World frame extraction. */
  viewFamily?: RenderViewFamilySnapshot | undefined;
  /** Registers CPU work that may only begin after this context's command buffer is submitted. */
  afterSubmit?(callback: (queue: GPUQueue) => void): void;
  /** Releases recording leases when a frame is abandoned without submission. */
  afterCancel?(callback: () => void): void;
}

export interface RenderFrameContextOptions {
  descriptor?: GPURenderPassDescriptor | undefined;
  frameData?: FrameData | undefined;
  view?: RenderView | RenderViewSnapshot | undefined;
  viewFamily?: RenderViewFamily | RenderViewFamilySnapshot | undefined;
  label?: string | undefined;
  loadOp?: RenderPassLoadOp | undefined;
}

const gpuPassTimingByOptions = new WeakMap<RenderFrameContextOptions, GpuPassTimingRecorder>();
const gpuPassTimingByContext = new WeakMap<RenderCommandContext, GpuPassTimingRecorder>();
const deferredFrameOptions = new WeakSet<RenderFrameContextOptions>();

/** Regional scheduling may return an idle logical frame without touching GPU/presentation state. */
export function createDeferredRenderFrameContext(engine:IEngine,options:RenderFrameContextOptions):RenderFrameContext {
  const scoped={...options};deferredFrameOptions.add(scoped);return new RenderFrameContext(engine,scoped);
}

export class RenderFrameContext implements RenderCommandContext {
  readonly engine: IEngine;
  readonly device: GPUDevice;
  private _encoder: GPUCommandEncoder | null = null;
  private readonly _encoderLabel: string | undefined;

  passEncoder: GPURenderPassEncoder | undefined;
  private _descriptor: GPURenderPassDescriptor | undefined;
  private _descriptorResolved = false;
  loadOp: RenderPassLoadOp | undefined;
  frameData: FrameData | undefined;
  view: RenderViewSnapshot | undefined;
  readonly viewFamily: RenderViewFamilySnapshot | undefined;

  private _finished = false;
  private _submitted = false;
  private _cancelled = false;
  private _passActive = false;
  private _commandBuffer: GPUCommandBuffer | null = null;
  private readonly _afterSubmitCallbacks: Array<(queue: GPUQueue) => void> = [];
  private readonly _afterCancelCallbacks: Array<() => void> = [];
  private readonly _gpuPassTiming: GpuPassTimingRecorder | null;

  constructor(engine: IEngine, options: RenderFrameContextOptions = {}) {
    this.engine = engine;
    this.device = requireEngineDevice(engine);
    this._encoderLabel = options.label;
    this._gpuPassTiming = gpuPassTimingByOptions.get(options) ?? null;
    if (this._gpuPassTiming) gpuPassTimingByContext.set(this, this._gpuPassTiming);
    this.viewFamily = options.viewFamily instanceof RenderViewFamily ? options.viewFamily.snapshot() : options.viewFamily;
    this.view = options.view instanceof RenderView ? options.view.snapshot() : options.view;
    if (!this.view) this.view = this.viewFamily?.views[0];
    this._descriptor = options.descriptor;
    this._descriptorResolved = options.descriptor !== undefined;
    this.loadOp = options.loadOp;
    this.frameData = options.frameData;
    if(!deferredFrameOptions.has(options)){void this.encoder;void this.descriptor;}
  }

  /** No encoder or presentation target is acquired until recording actually starts. */
  get encoder(): GPUCommandEncoder {
    this._assertNotCancelled();
    if (!this._encoder) this._encoder = createFrameCommandEncoder(this.device.createCommandEncoder(this._encoderLabel ? {label:this._encoderLabel} : undefined), this._gpuPassTiming);
    return this._encoder;
  }
  get descriptor(): GPURenderPassDescriptor | undefined {
    if (!this._descriptorResolved) {this._descriptor = resolveFramePassDescriptor(this.engine, this.view, this.loadOp); this._descriptorResolved = true;}
    return this._descriptor;
  }
  set descriptor(value: GPURenderPassDescriptor | undefined) {this._descriptor = value; this._descriptorResolved = value !== undefined;}

  get passActive(): boolean {
    return this._passActive;
  }

  get submitted(): boolean {
    return this._submitted;
  }

  beginPass(nextDescriptor?: GPURenderPassDescriptor, loadOp?: RenderPassLoadOp): GPURenderPassEncoder {
    this._assertNotCancelled();
    if (this._finished) {
      throw new EngineError(
        EngineErrorCode.RenderCommandContextInvalid,
        'RenderFrameContext.beginPass() called after finish().',
        {
          hint: 'Create a new RenderFrameContext for the next frame instead of reusing a finished context.',
          docsPath: 'errors/E_RENDER_COMMAND_CONTEXT_INVALID',
        },
      );
    }
    if (this._passActive && this.passEncoder) {
      const changesDescriptor = !!nextDescriptor && nextDescriptor !== this.descriptor;
      const changesLoadOp = loadOp !== undefined && loadOp !== this.loadOp;
      if (changesDescriptor || changesLoadOp) {
        throw new EngineError(
          EngineErrorCode.RenderCommandContextInvalid,
          'RenderFrameContext.beginPass() cannot change pass state while a pass is active.',
          {
            hint: 'Call endPass() before beginning a render pass with a different descriptor or loadOp.',
            docsPath: 'errors/E_RENDER_COMMAND_CONTEXT_INVALID',
          },
        );
      }
      return this.passEncoder;
    }
    if (nextDescriptor) {
      this.descriptor = nextDescriptor;
    } else if (!this.descriptor) {
      this.descriptor = this.view
        ? cloneViewPassDescriptor(this.view, loadOp ?? this.loadOp)
        : getCachedRenderPassDescriptor(this.engine, loadOp ?? this.loadOp);
    }
    this.loadOp = loadOp ?? this.loadOp;
    if (!this.descriptor) {
      throw new EngineError(
        EngineErrorCode.RenderCommandContextInvalid,
        'RenderFrameContext.beginPass() requires a render pass descriptor.',
        {
          hint: 'Pass a descriptor to beginPass(), provide one when creating the frame context, or ensure the engine can supply a cached descriptor.',
          docsPath: 'errors/E_RENDER_COMMAND_CONTEXT_INVALID',
        },
      );
    }
    this.passEncoder = cacheRenderPassState(this.encoder.beginRenderPass(this.descriptor));
    this._passActive = true;
    return this.passEncoder;
  }

  endPass(): void {
    if (!this._passActive || !this.passEncoder) return;
    const pass = this.passEncoder;
    this.passEncoder = undefined;
    this._passActive = false;
    pass.end();
  }

  finish(): GPUCommandBuffer {
    this._assertNotCancelled();
    if (!this._finished) {
      this.endPass();
      this._gpuPassTiming?.resolve(this.encoder);
      this._commandBuffer = this.encoder.finish();
      this._finished = true;
    }
    return this._commandBuffer!;
  }

  afterSubmit(callback: (queue: GPUQueue) => void): void {
    this._assertNotCancelled();
    if (this._submitted) {
      callback(this.device.queue);
      return;
    }
    this._afterSubmitCallbacks.push(callback);
  }

  afterCancel(callback: () => void): void {
    if (this._cancelled) {callback(); return;}
    if (!this._submitted) this._afterCancelCallbacks.push(callback);
  }

  /** An abandoned command buffer must never be submitted later. */
  cancel(): void {
    if (this._submitted || this._cancelled) return;
    this._cancelled = true;
    const errors: unknown[] = [];
    try {this.endPass();} catch (error) {errors.push(error);}
    try {this._gpuPassTiming?.cancel();} catch (error) {errors.push(error);}
    this._afterSubmitCallbacks.length = 0;
    for (const callback of this._afterCancelCallbacks.splice(0)) {
      try {callback();} catch (error) {errors.push(error);}
    }
    if (errors.length) throw new AggregateError(errors, 'Frame cancellation cleanup failed.');
  }

  private _assertNotCancelled(): void {
    if (this._cancelled) throw new EngineError(EngineErrorCode.RenderCommandContextInvalid, 'Render frame was cancelled.');
  }

  submit(): void {
    this._assertNotCancelled();
    if (this._submitted) return;
    try {
      this.device.queue.submit([this.finish()]);
    } catch (error) {
      try {this.cancel();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Frame submission and cancellation failed.');}
      throw error;
    }
    this._submitted = true;
    this._afterCancelCallbacks.length = 0;
    let firstError: unknown;
    let hasError = false;
    try {this._gpuPassTiming?.afterSubmit();} catch (error) {firstError = error; hasError = true;}
    for (const callback of this._afterSubmitCallbacks.splice(0)) {
      try {
        callback(this.device.queue);
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
      }
    }
    if (hasError) throw firstError;
  }
}

function resolveFramePassDescriptor(
  engine: IEngine,
  view: RenderView | RenderViewSnapshot | undefined,
  loadOp: RenderPassLoadOp | undefined,
): GPURenderPassDescriptor {
  const snapshot = view instanceof RenderView ? view.snapshot() : view;
  return snapshot ? cloneViewPassDescriptor(snapshot, loadOp) : getCachedRenderPassDescriptor(engine, loadOp);
}

function cloneViewPassDescriptor(view: RenderViewSnapshot, loadOp: RenderPassLoadOp | undefined): GPURenderPassDescriptor {
  return cloneRenderPassDescriptor(
    view.target.getRenderPassDescriptor(getRenderViewPassOptions(view)),
    loadOp,
  );
}

/** @internal Configures diagnostics without widening the stable RenderFrameContextOptions contract. */
export function configureRenderFrameContextGpuPassTiming(
  options: RenderFrameContextOptions,
  timing: GpuPassTimingRecorder | null,
): void {
  if (timing) gpuPassTimingByOptions.set(options, timing);
  else gpuPassTimingByOptions.delete(options);
}

/** @internal Preserve timing attribution when diagnostics decorate a recording context. */
export function inheritRenderCommandContextGpuPassTiming(source: RenderCommandContext, target: RenderCommandContext): void {
  const timing = gpuPassTimingByContext.get(source);
  if (timing) gpuPassTimingByContext.set(target, timing);
}

/** @internal */
export function setNextGpuPassTimingLabel(context: RenderCommandContext, label: GpuPassTimingLabel): void {
  gpuPassTimingByContext.get(context)?.setNextPass(label);
}

/** @internal */
export function hasGpuPassTiming(context: RenderCommandContext): boolean {
  return gpuPassTimingByContext.has(context);
}

/** @internal */
export function createRenderGpuPassProfiler(
  device: GPUDevice,
  diagnostics: FrameDiagnostics,
): GpuPassProfiler {
  return new GpuPassProfiler(device, diagnostics);
}

function createFrameCommandEncoder(
  encoder: GPUCommandEncoder,
  timing: GpuPassTimingRecorder | null,
): GPUCommandEncoder {
  return new Proxy(encoder, {
    get(target, property) {
      if (property === 'beginRenderPass') {
        return (descriptor: GPURenderPassDescriptor): GPURenderPassEncoder => (
          cacheRenderPassState(target.beginRenderPass(timing ? timing.decorateRenderPass(descriptor) : descriptor))
        );
      }
      if (property === 'beginComputePass') {
        return (descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder => (
          target.beginComputePass(timing ? timing.decorateComputePass(descriptor) : descriptor)
        );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createRenderFrameContext(
  engine: IEngine,
  options: RenderFrameContextOptions = {},
): RenderFrameContext {
  return new RenderFrameContext(engine, options);
}

export function beginRenderCommandPass(context: RenderCommandContext): { passEncoder: GPURenderPassEncoder; ownsPass: boolean } {
  if (context.passEncoder) return { passEncoder: context.passEncoder, ownsPass: false };
  if (!context.descriptor) {
    throw new EngineError(
      EngineErrorCode.RenderCommandContextInvalid,
      'RenderCommandContext requires descriptor when passEncoder is not provided.',
      {
        hint: 'Provide either context.passEncoder or context.descriptor before a render system opens a pass.',
        docsPath: 'errors/E_RENDER_COMMAND_CONTEXT_INVALID',
      },
    );
  }
  return { passEncoder: cacheRenderPassState(context.encoder.beginRenderPass(context.descriptor)), ownsPass: true };
}
