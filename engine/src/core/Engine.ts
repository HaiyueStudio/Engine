import { EventEmitter } from './EventEmitter';
import { createGPUResourceOwner, GPUResourceTracker } from './GPUResourceTracker';
import { disposeSharedGeometry3DGPUCache } from '../renderer/SharedGeometry3DGPUCache';
import { RendererResourceCache } from '../renderer/RendererResourceCache';
import { disposeSceneFrameGpuArena } from '../renderer/SceneFrameGpuArena';
import { AssetManager } from '../assets/AssetManager';
import { Scene, normalizeSceneOptions, type SceneCreateOptions } from '../scene/Scene';
import type { ComponentRegistration, EnginePlugin, EnginePluginContext } from './EnginePlugin';
import { EngineError, EngineErrorCode } from './EngineError';
import { cloneClearColor, mergeEngineDefaults, type EngineDefaults, type EngineDefaultsInput } from './EngineDefaults';
import { RenderTargetManager } from './RenderTargetManager';
import { clearCachedRenderPassDescriptors } from './renderPassDescriptor';
import { FrameLoop } from './FrameLoop';
import { EngineRegistryHub } from './EngineRegistryHub';
import { EnginePluginHost } from './EnginePluginHost';
import type { EnginePluginInstallTracker } from './EnginePlugin';
import { resolveDepthFormat } from './DepthFormat';
import { GPU_FEATURE_TIMESTAMP_QUERY, hasGpuFeature } from './GPUFeatures';
import {
  createRenderCapabilities,
  DEFAULT_RENDER_PROFILE,
  resolveRenderProfileFeatures,
  type RenderCapabilities,
  type RenderProfileName,
} from './RenderProfile';
import type { DeviceRecoveryProgress, EngineLifecycleState, RecoverableGpuResource } from './Lifecycle';
import { FrameDiagnostics } from './FrameDiagnostics';
import { registerEngineDiagnostics } from './EngineDiagnosticsAccess';
import type { RenderViewTarget } from './RenderView';
import {
  createWebGpuCompatibilityError,
  WebGpuCompatibility,
  WebGpuCompatibilityStatus,
} from './WebGpuCompatibility';

export type EngineGpuProvider = Pick<GPU, 'requestAdapter' | 'getPreferredCanvasFormat'>;

export interface HaiyueEngineOptions {
  /** Canvas element, bare element ID, or CSS selector. Invalid string targets fail during construction. */
  canvas: HTMLCanvasElement | string;
  /** 1 = no MSAA (default), 4 = 4x MSAA */
  msaaSamples?: 1 | 4;
  clearColor?: { r: number; g: number; b: number; a: number };
  reverseZ?: boolean;
  alphaMode?: GPUCanvasAlphaMode;
  /** Backing-store scale. Defaults to window.devicePixelRatio. */
  devicePixelRatio?: number | (() => number);
  /** Request timestamp-query when the adapter supports it. Defaults to true. */
  timestampQuery?: boolean;
  defaults?: EngineDefaultsInput;
  /** Injectable WebGPU entry point for runtimes and deterministic recovery tests. */
  gpu?: EngineGpuProvider;
  /** Automatically request a replacement device after GPUDevice.lost. Defaults to true. */
  recoverDeviceLost?: boolean;
  /** Declarative GPU capability request. Defaults to Haiyue's 3D-first profile. */
  renderProfile?: RenderProfileName;
  /** Development-only observability. Disabled by default. */
  diagnostics?: { enabled?: boolean; captureResourceStacks?: boolean };
}

export interface HaiyueEngineEventMap {
  resize: { width: number; height: number };
  /** Frame hook emitted before the active scene is updated. */
  update: { time: number; delta: number };
  /** Frame hook emitted after the active scene has finished updating. */
  'after-update': { time: number; delta: number };
  'device-lost': GPUDeviceLostInfo;
  'device-restored': { device: GPUDevice };
  'recovery-progress': DeviceRecoveryProgress;
  'recovery-failed': { error: EngineError };
  'state-change': { previous: EngineLifecycleState; state: EngineLifecycleState };
  'capabilities-resolved': { capabilities: RenderCapabilities };
}

let _engineIdCounter = 0;

export class HaiyueEngine extends EventEmitter<HaiyueEngineEventMap> {
  static readonly webGpuCompatibility = WebGpuCompatibility;
  readonly id: number = ++_engineIdCounter;

  private _canvas: HTMLCanvasElement | null = null;
  private _adapter: GPUAdapter | null = null;
  private _device: GPUDevice | null = null;
  private readonly _renderTargets: RenderTargetManager;
  private readonly _frameLoop: FrameLoop;
  private readonly _registries = new EngineRegistryHub();
  private readonly _pluginHost: EnginePluginHost<EnginePluginContext>;

  format!: GPUTextureFormat;
  readonly defaults: EngineDefaults;
  alphaMode: GPUCanvasAlphaMode;
  private readonly _gpuResourceTracker: GPUResourceTracker;
  private readonly _frameDiagnostics: FrameDiagnostics;
  private _assetManager: AssetManager | null = null;
  private _activeScene: Scene | null = null;
  private _clearColor: { r: number; g: number; b: number; a: number };
  private _state: EngineLifecycleState = 'created';
  private _initPromise: Promise<this> | null = null;
  private _recoveryPromise: Promise<void> | null = null;
  private _recoveryController: AbortController | null = null;
  private readonly _gpu: EngineGpuProvider | undefined;
  private readonly _recoverDeviceLost: boolean;
  private readonly _recoveryParticipants = new Set<RecoverableGpuResource>();
  readonly renderProfile: RenderProfileName;
  private _capabilities: RenderCapabilities | null = null;

  get state(): EngineLifecycleState { return this._state; }

  get canvas(): HTMLCanvasElement | null { return this._renderTargets.canvas; }
  get adapter(): GPUAdapter | null {
    if (this._state === 'destroyed' || this._state === 'failed') this._assertNotTerminal('adapter');
    return this._adapter;
  }
  get device(): GPUDevice { return this._requireDevice(); }
  get context(): GPUCanvasContext | null { return this._renderTargets.context; }
  get renderTarget(): RenderViewTarget { return this._renderTargets; }
  get assetManager(): AssetManager | undefined { return this._assetManager ?? undefined; }
  get clearColor(): { r: number; g: number; b: number; a: number } { return this._clearColor; }
  set clearColor(value: { r: number; g: number; b: number; a: number }) {
    this._clearColor = cloneClearColor(value);
    this._renderTargets?.setClearColor(this._clearColor);
  }

  private _msaaSamples: 1 | 4 = 1;
  get msaaSamples() { return this._msaaSamples; }
  set msaaSamples(v: 1 | 4) {
    if (this._msaaSamples === v) return;
    this._msaaSamples = v;
    this._renderTargets.setMsaaSamples(v);
  }

  private _reverseZ = false;
  get reverseZ() { return this._reverseZ; }
  set reverseZ(v: boolean) {
    if (this._reverseZ === v) return;
    this._reverseZ = v;
    this._renderTargets.setReverseZ(v);
  }

  private _timestampQueryRequested: boolean;
  private _timestampQuerySupported = false;

  get width() { return this._renderTargets.width; }
  get height() { return this._renderTargets.height; }
  get displayWidth() { return this._renderTargets.displayWidth; }
  get displayHeight() { return this._renderTargets.displayHeight; }
  get devicePixelRatio() { return this._renderTargets.devicePixelRatio; }
  set devicePixelRatio(value: number | (() => number)) {
    this._renderTargets.setDevicePixelRatio(value);
  }
  get msaaTextureView() { return this._renderTargets.msaaTextureView; }
  get depthTextureView() { return this._renderTargets.depthTextureView; }
  get timestampQuerySupported() { return this._timestampQuerySupported; }
  get capabilities(): RenderCapabilities | null { return this._capabilities; }
  getOutputView(): GPUTextureView {
    this._assertReady('getOutputView');
    return this._renderTargets.getOutputView();
  }
  get activeScene(): Scene | null { return this._activeScene; }
  createScene(options: SceneCreateOptions = {}): Scene {
    this._assertNotTerminal('createScene');
    return new Scene(this, normalizeSceneOptions(options));
  }
  switchScene(scene: Scene | null, options: { destroyPrevious?: boolean } = {}): this {
    this._assertNotTerminal('switchScene');
    const previous = this._activeScene;
    if (scene && scene.engine !== this) {
      throw new EngineError(
        EngineErrorCode.SceneInvalidState,
        'Cannot activate a Scene created by another HaiyueEngine.',
        {
          context: { scene: scene.world.name, engineId: this.id },
          hint: 'Create the scene with this engine before calling switchScene().',
        },
      );
    }
    if (scene?.state === 'destroyed' || scene?.state === 'destroying') {
      throw new EngineError(
        EngineErrorCode.SceneDestroyed,
        'Cannot activate a Scene after its destruction has started.',
        { context: { scene: scene.world.name, state: scene.state } },
      );
    }
    if (previous === scene) return this;
    if (previous && previous.state !== 'destroyed' && previous.state !== 'destroying') previous.deactivate();
    this._activeScene = scene;
    scene?.activate();
    if (options.destroyPrevious && previous) previous.destroy();
    return this;
  }
  updateActiveScene(time = performance.now(), delta = 0): this {
    this._assertReady('updateActiveScene');
    const scene = this._activeScene;
    if (scene?.state === 'destroyed' || scene?.state === 'destroying') {
      this._activeScene = null;
      return this;
    }
    scene?.update(time, delta);
    return this;
  }
  hasPlugin(name: string): boolean { return this._pluginHost.hasPlugin(name); }
  isPluginEnabled(name: string): boolean { return this._pluginHost.isPluginEnabled(name); }
  registerComponent(registration: ComponentRegistration): this {
    this._registries.registerComponent(registration);
    return this;
  }
  unregisterComponent(type: string): this {
    this._registries.unregisterComponent(type);
    return this;
  }

  registerDeviceRecoveryParticipant(participant: RecoverableGpuResource): () => void {
    this._assertNotTerminal('registerDeviceRecoveryParticipant');
    this._recoveryParticipants.add(participant);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this._recoveryParticipants.delete(participant);
    };
  }
  getRegisteredComponent(type: string): ComponentRegistration | undefined {
    return this._registries.getRegisteredComponent(type);
  }

  installPlugin(plugin: EnginePlugin): this {
    this._pluginHost.installPlugin(plugin);
    return this;
  }

  enablePlugin(name: string): this {
    this._pluginHost.enablePlugin(name);
    return this;
  }

  disablePlugin(name: string): this {
    this._pluginHost.disablePlugin(name);
    return this;
  }

  removePlugin(name: string): this {
    this._pluginHost.removePlugin(name);
    return this;
  }

  constructor(options: HaiyueEngineOptions) {
    super();
    this._frameDiagnostics = new FrameDiagnostics({ enabled: options.diagnostics?.enabled === true });
    this._gpuResourceTracker = new GPUResourceTracker({
      debug: options.diagnostics?.enabled === true,
      captureStacks: options.diagnostics?.captureResourceStacks === true,
      frameDiagnostics: this._frameDiagnostics,
    });
    registerEngineDiagnostics(this, {
      resourceTracker: this._gpuResourceTracker,
      frameDiagnostics: this._frameDiagnostics,
    });
    this.defaults = mergeEngineDefaults(options.defaults);
    const canvas = resolveEngineCanvas(options.canvas);
    this._canvas = canvas;
    this._msaaSamples = options.msaaSamples ?? 1;
    this._clearColor = cloneClearColor(options.clearColor ?? this.defaults.clearColor!);
    this._reverseZ = options.reverseZ ?? this.defaults.reverseZ ?? false;
    this.alphaMode = options.alphaMode ?? 'opaque';
    this._timestampQueryRequested = options.timestampQuery ?? true;
    this._gpu = options.gpu;
    this._recoverDeviceLost = options.recoverDeviceLost ?? true;
    this.renderProfile = options.renderProfile ?? DEFAULT_RENDER_PROFILE;
    this._renderTargets = new RenderTargetManager({
      canvas,
      alphaMode: this.alphaMode,
      msaaSamples: this._msaaSamples,
      reverseZ: this._reverseZ,
      clearColor: this._clearColor,
      devicePixelRatio: options.devicePixelRatio ?? (() => globalThis.window?.devicePixelRatio ?? 1),
      gpuResourceTracker: this._gpuResourceTracker,
      getDepthFormat: reverseZ => this.getDepthFormat(reverseZ),
      onResize: (width, height) => this.emit('resize', { detail: { width, height } }),
    });
    this._frameLoop = new FrameLoop({
      onFrame: (time, delta) => {
        this._frameDiagnostics.beginFrame();
        this._gpuResourceTracker.beginFrame(this._frameDiagnostics.snapshot().frame);
        this._renderTargets.beginFrame();
        this.emit('update', { detail: { time, delta } });
        if (this._state !== 'ready') return;
        this._frameDiagnostics.measure('update', () => this.updateActiveScene(time, delta));
        if (this._state === 'ready') this.emit('after-update', { detail: { time, delta } });
      },
    });
    this._pluginHost = new EnginePluginHost({
      scope: 'engine',
      installHint: 'Check the plugin installEngine() implementation and dependency list.',
      lifecycleHint: 'Check the plugin enableEngine() implementation and dependency enabled state.',
      hasDependency: name => this.hasPlugin(name),
      isDependencyEnabled: name => this.isPluginEnabled(name),
      createContext: tracker => this._createPluginContext(tracker),
      gpuResourceTracker: this._gpuResourceTracker,
    });
  }

  async init(): Promise<this> {
    if (this._state === 'ready') return this;
    if (this._initPromise) return this._initPromise;
    this._assertState('init', ['created']);
    this._setState('initializing');
    this._initPromise = this._initialize();
    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  private async _initialize(): Promise<this> {
    try {
      const { adapter, device, format } = await this._acquireDevice();
      if (this._state === 'destroyed') {
        device.destroy();
        throw this._invalidStateError('init', ['initializing']);
      }
      this._adapter = adapter;
      this._device = device;
      this._timestampQuerySupported = hasGpuFeature(device.features, GPU_FEATURE_TIMESTAMP_QUERY);
      this._capabilities = createRenderCapabilities(this.renderProfile, adapter, device, format);
      this.emit('capabilities-resolved', { detail: { capabilities: this._capabilities } });
      this._assetManager = new AssetManager(device, this._gpuResourceTracker, this.defaults.assetManager);
      this.format = format;
      this._renderTargets.configure(device, format);
      this._watchDevice(device);
      this._renderTargets.attachWindowResize();
      this._setState('ready');
      return this;
    } catch (error) {
      if (this._state !== 'destroyed') this._setState('failed');
      throw error;
    }
  }

  private async _acquireDevice(): Promise<{ adapter: GPUAdapter; device: GPUDevice; format: GPUTextureFormat }> {
    const gpu = this._gpu ?? globalThis.navigator?.gpu;
    if (!gpu) {
      throw createWebGpuCompatibilityError(WebGpuCompatibilityStatus.Unsupported);
    }

    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      throw createWebGpuCompatibilityError(WebGpuCompatibilityStatus.AdapterUnavailable);
    }

    const requiredFeatures = resolveRenderProfileFeatures(adapter.features, this.renderProfile, {
      timestampQuery: this._timestampQueryRequested,
    });
    const device = await adapter.requestDevice(requiredFeatures.length ? { requiredFeatures } : undefined);
    this._gpuResourceTracker.instrumentDevice(
      device,
      createGPUResourceOwner('engine', `HaiyueEngine:${this.id}.device`),
    );
    return { adapter, device, format: gpu.getPreferredCanvasFormat() };
  }

  resizeToDisplaySize(force = false): boolean {
    this._assertReady('resizeToDisplaySize');
    return this._renderTargets.resizeToDisplaySize(force);
  }

  getDepthFormat(reverseZ = this._reverseZ): GPUTextureFormat {
    return resolveDepthFormat(reverseZ);
  }

  getRenderPassDescriptor(): GPURenderPassDescriptor {
    this._assertReady('getRenderPassDescriptor');
    this._renderTargets.setClearColor(this.clearColor);
    return this._renderTargets.getRenderPassDescriptor();
  }

  getRenderPassDescriptorVersion(): number {
    return this._renderTargets.getRenderPassDescriptorVersion();
  }

  run(): this {
    this._assertReady('run');
    this._requireCanvas();
    this._requireDevice();
    this._requireContext();
    this._frameLoop.start();
    return this;
  }

  stop(): this {
    this._frameLoop.stop();
    return this;
  }

  destroy(): void {
    if (this._state === 'destroyed') return;
    this._setState('destroyed');
    this._recoveryController?.abort('engine-destroyed');
    this._recoveryController = null;
    this.stop();
    this._activeScene?.destroy();
    this._activeScene = null;
    this._renderTargets.destroy();
    clearCachedRenderPassDescriptors(this);
    if (this._device) {
      disposeSharedGeometry3DGPUCache(this._device);
      disposeSceneFrameGpuArena(this._device);
      RendererResourceCache.clear(this._device);
    }
    this._pluginHost.clear();
    this._assetManager?.dispose();
    this._assetManager = null;
    const device = this._device;
    this._adapter = null;
    this._device = null;
    this._capabilities = null;
    this._canvas = null;
    this._gpuResourceTracker.releaseAll();
    this._recoveryParticipants.clear();
    device?.destroy();
    this.removeAllListeners();
  }

  async waitForRecovery(): Promise<void> {
    await this._recoveryPromise;
  }

  private _watchDevice(device: GPUDevice): void {
    void device.lost.then(info => {
      if (this._device !== device || this._state === 'destroyed') return;
      const recovery = Promise.resolve().then(() => this._handleDeviceLost(device, info));
      this._recoveryPromise = recovery.finally(() => {
        this._recoveryPromise = null;
      });
    });
  }

  private async _handleDeviceLost(lostDevice: GPUDevice, info: GPUDeviceLostInfo): Promise<void> {
    if (this._state !== 'ready') return;
    const wasRunning = this._frameLoop.running;
    this._setState('lost');
    this.stop();
    this.emit('device-lost', { detail: info });
    this._progress('stopping', 1, 'GPU device lost; frame submission stopped.');
    const controller = new AbortController();
    this._recoveryController = controller;
    try {
      this._progress('suspending-assets', 2, 'Suspending asset jobs and plugins.');
      this._pluginHost.disableAll();
      await this._activeScene?.suspendForDeviceLoss();
      for (const participant of this._recoveryParticipants) await participant.suspendForDeviceLoss?.();
      this._assetManager?.suspendForDeviceLoss();

      this._progress('releasing-gpu-resources', 3, 'Releasing resources owned by the lost device.');
      clearCachedRenderPassDescriptors(this);
      disposeSharedGeometry3DGPUCache(lostDevice);
      disposeSceneFrameGpuArena(lostDevice);
      RendererResourceCache.clear(lostDevice);
      this._renderTargets.suspendForDeviceLoss();
      this._gpuResourceTracker.releaseAll();
      this._device = null;
      this._adapter = null;

      if (!this._recoverDeviceLost) {
        throw new EngineError(
          EngineErrorCode.EngineRecoveryFailed,
          'Automatic device recovery is disabled.',
          { context: { reason: info.reason, message: info.message } },
        );
      }

      this._setState('recovering');
      this._progress('requesting-device', 4, 'Requesting a replacement GPU adapter and device.');
      const { adapter, device, format } = await this._acquireDevice();
      this._throwIfRecoveryAborted(controller.signal);
      this._adapter = adapter;
      this._device = device;
      this.format = format;
      this._timestampQuerySupported = hasGpuFeature(device.features, GPU_FEATURE_TIMESTAMP_QUERY);
      this._capabilities = createRenderCapabilities(this.renderProfile, adapter, device, format);
      this.emit('capabilities-resolved', { detail: { capabilities: this._capabilities } });

      this._progress('rebuilding-render-targets', 5, 'Rebuilding canvas render targets and caches.');
      this._renderTargets.configure(device, format);
      this._watchDevice(device);

      this._progress('recovering-assets', 6, 'Rebuilding recoverable GPU assets from CPU sources.');
      const failedAssets = await this._assetManager?.recoverDevice(device, controller.signal) ?? [];
      if (failedAssets.length > 0) throw this._unrecoverableResourcesError('asset', failedAssets);

      this._progress('recovering-scene', 7, 'Rebuilding scene render systems and plugin state.');
      const failedSceneResources: string[] = [];
      for (const participant of this._recoveryParticipants) {
        try {
          await participant.recoverGpuResource(device, controller.signal);
        } catch {
          failedSceneResources.push(participant.recoveryLabel);
        }
      }
      failedSceneResources.push(...(await this._activeScene?.recoverDevice(device, controller.signal) ?? []));
      if (failedSceneResources.length > 0) throw this._unrecoverableResourcesError('scene', failedSceneResources);
      this._pluginHost.enableAll();

      this._setState('ready');
      this._progress('ready', 8, 'GPU device recovery completed.');
      this.emit('device-restored', { detail: { device } });
      if (wasRunning) this.run();
    } catch (error) {
      if (this.state === 'destroyed') return;
      const recoveryError = error instanceof EngineError && error.code === EngineErrorCode.EngineRecoveryFailed
        ? error
        : new EngineError(
            EngineErrorCode.EngineRecoveryFailed,
            'Failed to recover from GPU device loss.',
            { cause: error, context: { reason: info.reason, message: info.message } },
          );
      const failedDevice = this._device;
      if (failedDevice) {
        clearCachedRenderPassDescriptors(this);
        disposeSharedGeometry3DGPUCache(failedDevice);
        disposeSceneFrameGpuArena(failedDevice);
        RendererResourceCache.clear(failedDevice);
      }
      this._renderTargets.suspendForDeviceLoss();
      this._gpuResourceTracker.releaseAll();
      this._device = null;
      this._adapter = null;
      this._capabilities = null;
      try { failedDevice?.destroy(); } catch { /* Recovery cleanup is idempotent. */ }
      this._setState('failed');
      this._progress('failed', 8, recoveryError.message);
      this.emit('recovery-failed', { detail: { error: recoveryError } });
    } finally {
      if (this._recoveryController === controller) this._recoveryController = null;
    }
  }

  private _progress(phase: DeviceRecoveryProgress['phase'], completed: number, message: string): void {
    this.emit('recovery-progress', { detail: { phase, completed, total: 8, message } });
  }

  private _unrecoverableResourcesError(owner: string, resources: readonly string[]): EngineError {
    return new EngineError(
      EngineErrorCode.EngineRecoveryFailed,
      `Device recovery found unrecoverable ${owner} resources: ${resources.join(', ')}.`,
      { context: { owner, resources }, cause: new EngineError(EngineErrorCode.ResourceUnrecoverable, 'GPU resource cannot be rebuilt.') },
    );
  }

  private _throwIfRecoveryAborted(signal: AbortSignal): void {
    if (signal.aborted) throw this._invalidStateError('recoverDevice', ['recovering']);
  }

  private _setState(state: EngineLifecycleState): void {
    if (state === this._state) return;
    const previous = this._state;
    this._state = state;
    this.emit('state-change', { detail: { previous, state } });
  }

  private _assertReady(operation: string): void {
    this._assertState(operation, ['ready']);
  }

  private _assertNotTerminal(operation: string): void {
    if (this._state === 'destroyed') {
      throw new EngineError(
        EngineErrorCode.EngineDestroyed,
        `Cannot call HaiyueEngine.${operation}() after destroy().`,
        { context: { operation, state: this._state } },
      );
    }
    if (this._state === 'failed') throw this._invalidStateError(operation, ['created', 'initializing', 'ready', 'lost', 'recovering']);
  }

  private _assertState(operation: string, allowed: readonly EngineLifecycleState[]): void {
    if (allowed.includes(this._state)) return;
    if (this._state === 'destroyed') this._assertNotTerminal(operation);
    throw this._invalidStateError(operation, allowed);
  }

  private _invalidStateError(operation: string, allowed: readonly EngineLifecycleState[]): EngineError {
    return new EngineError(
      EngineErrorCode.EngineInvalidState,
      `HaiyueEngine.${operation}() is not available while the engine is ${this._state}.`,
      {
        context: { operation, state: this._state, allowed },
        hint: this._state === 'lost' || this._state === 'recovering'
          ? 'Wait for the device-restored event or waitForRecovery() before retrying.'
          : 'Create and initialize a new engine if this instance is in a terminal state.',
      },
    );
  }

  private _requireCanvas(): HTMLCanvasElement {
    const canvas = this._renderTargets.canvas;
    if (!canvas) {
      throw new EngineError(
        EngineErrorCode.EngineDestroyed,
        'HaiyueEngine has been destroyed.',
        {
          hint: 'Create a new HaiyueEngine instead of using an instance after destroy().',
          docsPath: 'errors/E_ENGINE_DESTROYED',
        },
      );
    }
    return canvas;
  }

  private _requireAdapter(): GPUAdapter {
    if (!this._adapter) {
      if (this._state !== 'created' && this._state !== 'initializing') throw this._invalidStateError('adapter', ['ready']);
      throw new EngineError(
        EngineErrorCode.EngineNotInitialized,
        'HaiyueEngine adapter is not initialized or has been destroyed.',
        {
          hint: 'Call await engine.init() before using adapter-dependent APIs.',
          docsPath: 'errors/E_ENGINE_NOT_INITIALIZED',
        },
      );
    }
    return this._adapter;
  }

  private _requireDevice(): GPUDevice {
    if (!this._device) {
      if (this._state === 'destroyed') this._assertNotTerminal('device');
      if (this._state !== 'created' && this._state !== 'initializing') throw this._invalidStateError('device', ['ready']);
      throw new EngineError(
        EngineErrorCode.EngineNotInitialized,
        'HaiyueEngine device is not initialized or has been destroyed.',
        {
          hint: 'Call await engine.init() before rendering or allocating GPU resources.',
          docsPath: 'errors/E_ENGINE_NOT_INITIALIZED',
        },
      );
    }
    return this._device;
  }

  private _requireContext(): GPUCanvasContext {
    const context = this._renderTargets.context;
    if (!context) {
      if (this._state === 'destroyed') this._assertNotTerminal('context');
      if (this._state !== 'created' && this._state !== 'initializing') throw this._invalidStateError('context', ['ready']);
      throw new EngineError(
        EngineErrorCode.EngineNotInitialized,
        'HaiyueEngine context is not initialized or has been destroyed.',
        {
          hint: 'Call await engine.init() before requesting render pass descriptors or output views.',
          docsPath: 'errors/E_ENGINE_NOT_INITIALIZED',
        },
      );
    }
    return context;
  }

  private _createPluginContext(tracker: EnginePluginInstallTracker): EnginePluginContext {
    return {
      scope: 'engine',
      engine: this,
      assetManager: this._assetManager ?? undefined,
      rollback: tracker,
      hasPlugin: name => this.hasPlugin(name),
      unregister: () => tracker.unregister(),
      registerComponent: registration => {
        const previous = this.getRegisteredComponent(registration.type);
        this.registerComponent(registration);
        return tracker.track(() => {
          if (previous) this.registerComponent(previous);
          else this.unregisterComponent(registration.type);
        });
      },
      registerAssetLoader: registration => {
        if (!this._assetManager) {
          throw new EngineError(
            EngineErrorCode.PluginInstallFailed,
            'AssetManager is not available.',
            {
              hint: 'Call engine.init() before installing plugins that register asset loaders.',
              docsPath: 'errors/E_PLUGIN_INSTALL_FAILED',
            },
          );
        }
        this._assetManager.registerLoader(registration);
        return tracker.track(() => this._assetManager?.unregisterLoader(registration.type));
      },
    };
  }
}

function resolveEngineCanvas(canvas: HTMLCanvasElement | string): HTMLCanvasElement {
  if (typeof canvas !== 'string') return canvas;

  const target = canvas.trim();
  if (!target) throw createCanvasTargetError(canvas, 'The canvas target is empty.');

  const document = globalThis.document;
  if (!document) {
    throw createCanvasTargetError(
      target,
      'A string canvas target cannot be resolved because document is unavailable.',
    );
  }

  let element: Element | null = null;
  if (!target.startsWith('#')) {
    element = document.getElementById(target);
  }

  if (!element) {
    try {
      element = document.querySelector(target);
    } catch (cause) {
      throw createCanvasTargetError(target, `The canvas selector "${target}" is invalid.`, cause);
    }
  }

  if (!element) {
    throw createCanvasTargetError(target, `No element matches the canvas target "${target}".`);
  }
  if (element.localName.toLowerCase() !== 'canvas') {
    throw createCanvasTargetError(
      target,
      `The canvas target "${target}" resolved to <${element.localName}> instead of <canvas>.`,
    );
  }
  return element as HTMLCanvasElement;
}

function createCanvasTargetError(target: string, message: string, cause?: unknown): EngineError {
  return new EngineError(
    EngineErrorCode.WebGpuContextUnavailable,
    message,
    {
      context: { target },
      path: 'options.canvas',
      hint: 'Pass an HTMLCanvasElement, a bare canvas element ID, or a CSS selector that matches a <canvas>.',
      docsPath: 'errors/E_WEBGPU_CONTEXT_UNAVAILABLE',
      ...(cause === undefined ? {} : { cause }),
    },
  );
}
