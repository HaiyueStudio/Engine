export type EngineLifecycleState =
  | 'created'
  | 'initializing'
  | 'ready'
  | 'lost'
  | 'recovering'
  | 'failed'
  | 'destroyed';

export type SceneLifecycleState = 'created' | 'active' | 'inactive' | 'destroying' | 'destroyed';
export type PluginLifecycleState = 'installed' | 'enabled' | 'disabled' | 'removed';

export type AssetJobState =
  | 'queued'
  | 'loading'
  | 'parsing'
  | 'uploading'
  | 'ready'
  | 'failed'
  | 'aborted'
  | 'released';

export type DeviceRecoveryPhase =
  | 'stopping'
  | 'suspending-assets'
  | 'releasing-gpu-resources'
  | 'requesting-device'
  | 'rebuilding-render-targets'
  | 'recovering-assets'
  | 'recovering-scene'
  | 'ready'
  | 'failed';

export interface DeviceRecoveryProgress {
  readonly phase: DeviceRecoveryPhase;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
}

export interface RecoverableGpuResource<T = unknown> {
  readonly recoveryLabel: string;
  /** CPU-side descriptor/source that can rebuild the GPU handle. */
  readonly recoverySource: T;
  suspendForDeviceLoss?(): void | Promise<void>;
  recoverGpuResource(device: GPUDevice, signal: AbortSignal): void | Promise<void>;
}

export function isRecoverableGpuResource(value: unknown): value is RecoverableGpuResource {
  return !!value
    && typeof value === 'object'
    && typeof (value as RecoverableGpuResource).recoveryLabel === 'string'
    && 'recoverySource' in value
    && typeof (value as RecoverableGpuResource).recoverGpuResource === 'function';
}
