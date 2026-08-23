export type ScriptProtocol = 'node' | 'layout' | 'converter' | 'path-effect' | 'transition-condition' | 'listener-action' | 'util';
export type ScriptCapability = 'data.read' | 'data.write' | 'asset.read' | 'path.emit' | 'canvas.emit' | 'event.emit' | 'timer.schedule' | 'timer.cancel';
export type ScriptHandleKind = 'node' | 'layout' | 'view-model' | 'image' | 'font' | 'audio' | 'blob' | 'canvas';

export interface ScriptLocation { readonly sourceId: string; readonly line: number; readonly column: number }
export type ScriptConstant = null | boolean | number | string;
export type ScriptInstruction = Readonly<Record<string, unknown> & { readonly op: string; readonly location?: ScriptLocation | undefined }>;
export interface ScriptFunction { readonly id: string; readonly parameters: number; readonly registers: number; readonly instructions: readonly ScriptInstruction[] }
export interface RuntimeScriptProgram {
  readonly id: string;
  readonly protocol: ScriptProtocol;
  readonly sourceRevisionSha256: string;
  readonly constants: readonly ScriptConstant[];
  readonly functions: readonly ScriptFunction[];
  readonly entrypoints: Readonly<Record<string, string>>;
  readonly capabilities: readonly ScriptCapability[];
}

export interface RuntimeScriptLimits {
  readonly maxInstructionsPerInvocation: number;
  readonly maxInstructionsPerScope: number;
  readonly maxHeapBytes: number;
  readonly maxCallDepth: number;
  readonly maxOutputCommands: number;
  readonly maxEventsPerInvocation: number;
  readonly maxTimers: number;
  readonly maxPendingPromises: number;
  readonly maxWallTimeMs: number;
  readonly maxShaderSourceBytes: number;
  readonly maxShaderTokens: number;
  readonly maxShaderBindings: number;
  readonly maxTextures: number;
  readonly maxUniformBytes: number;
  readonly maxStorageBytes: number;
  readonly maxPipelines: number;
  readonly maxDrawsPerFrame: number;
}

export interface ScriptCapabilityHandle {
  readonly kind: ScriptHandleKind;
  readonly id: string;
  readonly generation: number;
  readonly token: string;
  readonly permissions: readonly ('read' | 'write' | 'invoke')[];
}

export interface ScriptWireObject { readonly [key: string]: ScriptWireValue }

export type ScriptWireValue =
  | null
  | boolean
  | number
  | string
  | ScriptCapabilityHandle
  | readonly ScriptWireValue[]
  | ScriptWireObject;

export interface ScriptInvocationContext {
  readonly clockMicros: number;
  readonly seed: readonly [number, number, number, number];
  readonly pointer?: Readonly<Record<string, ScriptWireValue>> | undefined;
  readonly keyboard?: Readonly<Record<string, ScriptWireValue>> | undefined;
  readonly gamepad?: Readonly<Record<string, ScriptWireValue>> | undefined;
  readonly focus?: Readonly<Record<string, ScriptWireValue>> | undefined;
  readonly data?: Readonly<Record<string, ScriptWireValue>> | undefined;
}

export interface ScriptCapabilityRequest {
  readonly invocationId: string;
  readonly sequence: number;
  readonly programId: string;
  readonly capability: ScriptCapability;
  readonly arguments: readonly ScriptWireValue[];
}

export interface ScriptCapabilityPort {
  invoke(request: ScriptCapabilityRequest, signal: AbortSignal): ScriptWireValue | Promise<ScriptWireValue>;
}

export interface ScriptInvocationRequest {
  readonly invocationId: string;
  readonly programId: string;
  readonly entrypoint: string;
  readonly arguments: readonly ScriptWireValue[];
  readonly inputs: Readonly<Record<string, ScriptWireValue>>;
  readonly context: ScriptInvocationContext;
}

export interface ScriptInvocationStats {
  readonly instructions: number;
  readonly peakHeapBytes: number;
  readonly maxCallDepth: number;
  readonly capabilityCalls: number;
  readonly outputCommands: number;
  readonly events: number;
  readonly promises: number;
}

export interface ScriptInvocationResult {
  readonly invocationId: string;
  readonly value: ScriptWireValue;
  readonly stats: ScriptInvocationStats;
}

export interface ScriptRuntimeDiagnostic {
  readonly code: string;
  readonly programId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly path?: string | undefined;
  readonly location?: ScriptLocation | undefined;
  readonly instructions?: number | undefined;
  readonly message: string;
}

export interface SandboxWorkerMessageEvent { readonly data: unknown }
export interface SandboxWorkerErrorEvent { readonly message?: string | undefined }
export interface SandboxWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: SandboxWorkerMessageEvent) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: SandboxWorkerErrorEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: SandboxWorkerMessageEvent) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: SandboxWorkerErrorEvent) => void): void;
  terminate(): void;
}

export interface SandboxedShaderBinding {
  readonly binding: number;
  readonly kind: 'uniform-buffer' | 'sampled-texture' | 'sampler';
  readonly visibility: 'vertex' | 'fragment' | 'vertex-fragment';
  readonly maxBytes?: number | undefined;
}

export interface SandboxedShaderModule {
  readonly id: string;
  readonly vertexEntryPoint: string;
  readonly fragmentEntryPoint: string;
  readonly source: string;
  readonly bindings: readonly SandboxedShaderBinding[];
  readonly targetFormat: 'rgba8unorm';
}
