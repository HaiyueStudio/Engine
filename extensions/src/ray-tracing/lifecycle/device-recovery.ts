import type { RayDeviceRecoveryOwnerOptions, RayDeviceRecoveryResult, RayOwnedRecoverableResource, RayRecoveryDiagnostic, RayRecoveryDiagnosticCode, RayRecoveryResourceBundle } from './types.js';

export class RayDeviceRecoveryOwner<TSource> {
  private device: GPUDevice | null = null;
  private source: TSource | null = null;
  private bundle: RayRecoveryResourceBundle | null = null;
  private controller: AbortController | null = null;
  private generationValue = 0;
  private destroyedValue = false;
  private recoveryTask: Promise<RayDeviceRecoveryResult> | null = null;
  private lastRecoveryResult: RayDeviceRecoveryResult | null = null;
  private readonly diagnosticValues: RayRecoveryDiagnostic[] = [];
  private readonly maxRecoveryAttempts: number;

  constructor(private readonly options: RayDeviceRecoveryOwnerOptions<TSource>) {
    this.maxRecoveryAttempts = Math.max(0, Math.floor(options.maxRecoveryAttempts ?? 1));
  }

  get destroyed(): boolean { return this.destroyedValue; }
  get generation(): number { return this.generationValue; }
  get liveResourceCount(): number { return this.destroyedValue ? 0 : this.bundle?.resources.reduce((sum, value) => sum + value.liveResourceCount, 0) ?? 0; }
  get ownedBytes(): number { return this.destroyedValue ? 0 : this.bundle?.resources.reduce((sum, value) => sum + (value.ownedBytes ?? 0), 0) ?? 0; }
  get diagnostics(): readonly RayRecoveryDiagnostic[] { return Object.freeze([...this.diagnosticValues]); }

  initialize(device: GPUDevice, source: TSource): Promise<RayDeviceRecoveryResult> {
    if (this.destroyedValue) return Promise.resolve(this.result('destroyed', this.diagnosticValues.length));
    this.source = source; return this.install(device, 'initial');
  }

  replaceSource(source: TSource): Promise<RayDeviceRecoveryResult> {
    if (this.destroyedValue) return Promise.resolve(this.result('destroyed', this.diagnosticValues.length));
    if (!this.device) throw new Error('RAY_DEVICE_OWNER_NOT_INITIALIZED');
    this.source = source; return this.install(this.device, 'source-revision');
  }

  recoverWith(device: GPUDevice): Promise<RayDeviceRecoveryResult> {
    if (this.destroyedValue) { device.destroy(); return Promise.resolve(this.result('destroyed', this.diagnosticValues.length)); }
    if (this.source === null) throw new Error('RAY_DEVICE_OWNER_SOURCE_MISSING');
    return this.install(device, 'external-recovery');
  }

  async awaitIdle(): Promise<RayDeviceRecoveryResult | null> { return this.recoveryTask ?? this.lastRecoveryResult; }

  destroy(): void {
    if (this.destroyedValue) return; this.destroyedValue = true; this.generationValue++;
    this.controller?.abort('ray-device-owner-disposed'); this.controller = null; this.releaseBundle(); this.device = null; this.source = null;
    this.emit('lifecycle', 'info', 'RAY_DEVICE_OWNER_DISPOSED', `${this.options.label} device owner was disposed.`, { generation: this.generationValue });
  }

  private async install(device: GPUDevice, reason: string): Promise<RayDeviceRecoveryResult> {
    const start = this.diagnosticValues.length; const generation = ++this.generationValue;
    this.controller?.abort(`superseded:${reason}`); const controller = new AbortController(); this.controller = controller;
    this.releaseBundle(); this.device = device; this.observeLoss(device, generation);
    this.emit('device-recovery', 'info', 'RAY_DEVICE_RECOVERY_STARTED', `${this.options.label} is creating resources for device generation ${generation}.`, { generation, reason });
    try {
      const source = this.source; if (source === null) throw new Error('RAY_DEVICE_OWNER_SOURCE_MISSING');
      const created = await this.options.create(device, source, { generation, signal: controller.signal });
      if (this.destroyedValue || controller.signal.aborted || generation !== this.generationValue || device !== this.device) {
        releaseResources(created.resources); this.emit('device-recovery', 'warning', 'RAY_DEVICE_STALE_RESOURCE_DISPOSED', 'Late GPU resources from a stale device generation were destroyed.', { generation, currentGeneration: this.generationValue });
        return this.result(this.destroyedValue ? 'destroyed' : 'stale', start);
      }
      if (created.historyGeneration !== generation) { releaseResources(created.resources); throw new Error(`RAY_DEVICE_HISTORY_GENERATION_MISMATCH:${created.historyGeneration}:${generation}`); }
      this.bundle = Object.freeze({ resources: Object.freeze([...created.resources]), historyGeneration: generation });
      this.emit('device-recovery', 'info', 'RAY_DEVICE_RECOVERY_COMPLETED', `${this.options.label} resources are ready for device generation ${generation}.`, { generation, resourceCount: this.liveResourceCount });
      return this.result('ready', start);
    } catch (error) {
      if (this.destroyedValue || controller.signal.aborted || generation !== this.generationValue) return this.result(this.destroyedValue ? 'destroyed' : 'stale', start);
      this.emit('device-recovery', 'error', 'RAY_DEVICE_RECOVERY_FAILED', `${this.options.label} resource creation failed.`, { generation, reason, cause: message(error) });
      return this.result('failed', start);
    }
  }

  private observeLoss(device: GPUDevice, generation: number): void {
    void device.lost.then(info => {
      if (this.destroyedValue || device !== this.device || generation !== this.generationValue) return;
      this.emit('device-loss', 'error', 'RAY_DEVICE_LOST', `${this.options.label} observed WebGPU device loss.`, { generation, reason: info.reason, message: info.message });
      this.controller?.abort('device-lost'); this.releaseBundle(); this.device = null; this.generationValue++;
      if (!this.options.acquireDevice) { this.emit('device-recovery', 'warning', 'RAY_DEVICE_RECOVERY_REQUIRED', `${this.options.label} requires an externally supplied replacement device.`, { generation: this.generationValue }); return; }
      this.lastRecoveryResult = null;
      const task = this.recoverAutomatically(info); this.recoveryTask = task;
      void task.then(result => { this.lastRecoveryResult = result; }).finally(() => { if (this.recoveryTask === task) this.recoveryTask = null; });
    });
  }

  private async recoverAutomatically(lost: GPUDeviceLostInfo): Promise<RayDeviceRecoveryResult> {
    const start = this.diagnosticValues.length;
    for (let attempt = 1; attempt <= this.maxRecoveryAttempts; attempt++) {
      if (this.destroyedValue) return this.result('destroyed', start);
      try { const device = await this.options.acquireDevice!({ attempt, lost }); if (this.destroyedValue) { device.destroy(); return this.result('destroyed', start); } const result = await this.install(device, `device-loss-attempt:${attempt}`); if (result.status === 'ready') return this.result('ready', start); }
      catch (error) { this.emit('device-recovery', 'error', 'RAY_DEVICE_RECOVERY_FAILED', `${this.options.label} failed to acquire a replacement device.`, { attempt, cause: message(error) }); }
    }
    this.emit('device-recovery', 'error', 'RAY_DEVICE_RECOVERY_EXHAUSTED', `${this.options.label} exhausted its bounded device recovery attempts.`, { attempts: this.maxRecoveryAttempts });
    return this.result('failed', start);
  }

  private releaseBundle(): void { if (!this.bundle) return; releaseResources(this.bundle.resources); this.bundle = null; }
  private emit(phase: RayRecoveryDiagnostic['phase'], severity: RayRecoveryDiagnostic['severity'], code: RayRecoveryDiagnosticCode, messageValue: string, context: RayRecoveryDiagnostic['context']): void { const value = Object.freeze({ phase, severity, code, message: messageValue, context: Object.freeze({ ...context }) }); this.diagnosticValues.push(value); this.options.onDiagnostic?.(value); }
  private result(status: RayDeviceRecoveryResult['status'], start: number): RayDeviceRecoveryResult { return Object.freeze({ status, generation: this.generationValue, diagnostics: Object.freeze(this.diagnosticValues.slice(start)) }); }
}

function releaseResources(resources: readonly RayOwnedRecoverableResource[]): void { for (let index = resources.length - 1; index >= 0; index--) { try { resources[index]!.destroy(); } catch { /* Continue inverse teardown; diagnostics belong to the resource owner. */ } } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
