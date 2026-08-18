import { EngineError, EngineErrorCode } from './EngineError';

/**
 * Minimal engine interface shared by HaiyueEngine and RttEngine.
 * Render systems and renderers accept this instead of the concrete class so
 * they can render into either the main canvas or an off-screen RTT texture.
 */
export interface IEngine {
  /** Render-ready device. Implementations must throw EngineError when unavailable. */
  readonly device: GPUDevice;
  readonly adapter?: GPUAdapter | null;
  readonly context?: GPUCanvasContext | null;
  /** Main event/render canvas when the engine is backed by a DOM canvas. RTT engines may omit it. */
  readonly canvas?: HTMLCanvasElement | null;
  readonly format: GPUTextureFormat;
  /** Backing-store width in physical pixels. */
  readonly width: number;
  /** Backing-store height in physical pixels. */
  readonly height: number;
  /** Display width in CSS pixels. Use this for logical 2D layout/camera sizing. */
  readonly displayWidth: number;
  /** Display height in CSS pixels. Use this for logical 2D layout/camera sizing. */
  readonly displayHeight: number;
  reverseZ: boolean;
  msaaSamples: 1 | 4;
  clearColor: { r: number; g: number; b: number; a: number };
  readonly depthTextureView: GPUTextureView;
  readonly msaaTextureView: GPUTextureView | null;
  readonly assetManager: import('../assets/AssetManager').AssetManager | undefined;
  readonly defaults?: import('./EngineDefaults').EngineDefaults;
  readonly timestampQuerySupported?: boolean;
  readonly renderProfile?: import('./RenderProfile').RenderProfileName;
  readonly capabilities?: import('./RenderProfile').RenderCapabilities | null;
  /** Default render destination. Per-scene/per-camera state belongs to RenderView, not here. */
  readonly renderTarget: import('./RenderView').RenderViewTarget;
  getDepthFormat(reverseZ?: boolean): GPUTextureFormat;
  getRenderPassDescriptor(): GPURenderPassDescriptor;
  getRenderPassDescriptorVersion?(): number;
  /** Returns the view for the final output target (swapchain or RTT color texture). */
  getOutputView(): GPUTextureView;
  registerDeviceRecoveryParticipant?(
    participant: import('./Lifecycle').RecoverableGpuResource,
  ): () => void;
}

export function requireEngineDevice(engine: IEngine): GPUDevice {
  if (!engine.device) {
    throw new EngineError(
      EngineErrorCode.EngineNotInitialized,
      'IEngine device is not available.',
      {
        hint: 'Initialize the engine before accessing GPU resources.',
        docsPath: 'errors/E_ENGINE_NOT_INITIALIZED',
      },
    );
  }
  return engine.device;
}

export function requireEngineCanvas(engine: IEngine): HTMLCanvasElement {
  if (!engine.canvas) {
    throw new EngineError(
      EngineErrorCode.EngineDestroyed,
      'IEngine canvas is not available or has been destroyed.',
      {
        hint: 'Only DOM-canvas backed engines expose canvas. RTT engines may not have one.',
        docsPath: 'errors/E_ENGINE_DESTROYED',
      },
    );
  }
  return engine.canvas;
}
