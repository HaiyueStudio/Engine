export type RayRecoveryDiagnosticCode =
  | 'RAY_DEVICE_LOST'
  | 'RAY_DEVICE_RECOVERY_REQUIRED'
  | 'RAY_DEVICE_RECOVERY_STARTED'
  | 'RAY_DEVICE_RECOVERY_COMPLETED'
  | 'RAY_DEVICE_RECOVERY_FAILED'
  | 'RAY_DEVICE_RECOVERY_EXHAUSTED'
  | 'RAY_DEVICE_STALE_RESOURCE_DISPOSED'
  | 'RAY_DEVICE_OWNER_DISPOSED';

export interface RayRecoveryDiagnostic {
  readonly phase: 'device-loss' | 'device-recovery' | 'lifecycle';
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: RayRecoveryDiagnosticCode;
  readonly message: string;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RayOwnedRecoverableResource {
  readonly label: string;
  readonly liveResourceCount: number;
  readonly ownedBytes?: number;
  destroy(): void;
}

export interface RayRecoveryResourceBundle {
  readonly resources: readonly RayOwnedRecoverableResource[];
  /** History generation is diagnostic evidence and must equal the active device generation. */
  readonly historyGeneration: number;
}

export interface RayDeviceRecoveryOwnerOptions<TSource> {
  readonly label: string;
  readonly create: (device: GPUDevice, source: TSource, context: { readonly generation: number; readonly signal: AbortSignal }) => Promise<RayRecoveryResourceBundle>;
  readonly acquireDevice?: (context: { readonly attempt: number; readonly lost: GPUDeviceLostInfo }) => Promise<GPUDevice>;
  readonly maxRecoveryAttempts?: number;
  readonly onDiagnostic?: (diagnostic: RayRecoveryDiagnostic) => void;
}

export interface RayDeviceRecoveryResult {
  readonly status: 'ready' | 'failed' | 'stale' | 'destroyed';
  readonly generation: number;
  readonly diagnostics: readonly RayRecoveryDiagnostic[];
}
