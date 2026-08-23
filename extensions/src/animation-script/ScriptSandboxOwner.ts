import { AnimationScriptRuntimeError, scriptRuntimeFail } from './diagnostics.js';
import { validateScriptInvocationRequest, validateScriptWireGraph } from './PortableScriptVm.js';
import type {
  RuntimeScriptLimits,
  RuntimeScriptProgram,
  SandboxWorkerErrorEvent,
  SandboxWorkerLike,
  SandboxWorkerMessageEvent,
  ScriptCapability,
  ScriptCapabilityHandle,
  ScriptCapabilityPort,
  ScriptCapabilityRequest,
  ScriptHandleKind,
  ScriptInvocationRequest,
  ScriptInvocationResult,
  ScriptWireValue,
} from './runtime-types.js';

const PROTOCOL_VERSION = 1;
const HANDLE_KINDS = new Set<ScriptHandleKind>(['node', 'layout', 'view-model', 'image', 'font', 'audio', 'blob', 'canvas']);
const CAPABILITY_PERMISSION: Readonly<Record<ScriptCapability, 'read' | 'write' | 'invoke'>> = Object.freeze({
  'data.read': 'read', 'asset.read': 'read', 'data.write': 'write',
  'path.emit': 'invoke', 'canvas.emit': 'invoke', 'event.emit': 'invoke', 'timer.schedule': 'invoke', 'timer.cancel': 'invoke',
});
const CAPABILITY_TARGET_KINDS: Readonly<Partial<Record<ScriptCapability, ReadonlySet<ScriptHandleKind>>>> = Object.freeze({
  'data.read': new Set<ScriptHandleKind>(['node', 'layout', 'view-model']),
  'data.write': new Set<ScriptHandleKind>(['node', 'layout', 'view-model']),
  'asset.read': new Set<ScriptHandleKind>(['image', 'font', 'audio', 'blob']),
  'canvas.emit': new Set<ScriptHandleKind>(['canvas']),
});

interface PendingInvocation {
  readonly request: ScriptInvocationRequest;
  readonly resolve: (result: ScriptInvocationResult) => void;
  readonly reject: (error: Error) => void;
  readonly controller: AbortController;
  readonly instructionBudget: number;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly removeExternalAbort: () => void;
}

export interface OwnedScriptCapabilityPort extends ScriptCapabilityPort {
  disposeScope?(generation: number): void | Promise<void>;
}

export interface ScriptSandboxOwnerOptions {
  readonly workerFactory: () => SandboxWorkerLike;
  readonly programs: readonly RuntimeScriptProgram[];
  readonly limits: RuntimeScriptLimits;
  readonly capabilityPort: OwnedScriptCapabilityPort;
  readonly tokenFactory?: (() => string) | undefined;
  readonly timeoutGraceMs?: number | undefined;
}

export class ScriptSandboxOwner {
  private generation = 1;
  private worker: SandboxWorkerLike | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly handles = new Map<string, ScriptCapabilityHandle>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private crashed = false;
  private scopeInstructions = 0;
  private programs: readonly RuntimeScriptProgram[];
  private readonly tokenFactory: () => string;
  private readonly timeoutGraceMs: number;

  constructor(private readonly options: ScriptSandboxOwnerOptions) {
    this.programs = Object.freeze([...options.programs]);
    this.tokenFactory = options.tokenFactory ?? randomToken;
    this.timeoutGraceMs = options.timeoutGraceMs ?? 20;
  }

  createHandle(
    kind: ScriptHandleKind,
    id: string,
    permissions: readonly ('read' | 'write' | 'invoke')[],
  ): ScriptCapabilityHandle {
    this.assertAlive();
    if (!HANDLE_KINDS.has(kind) || !/^[a-zA-Z0-9._-]{1,128}$/.test(id)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Invalid capability handle identity.');
    const uniquePermissions = [...new Set(permissions)];
    if (uniquePermissions.length === 0 || uniquePermissions.some(value => value !== 'read' && value !== 'write' && value !== 'invoke')) {
      scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Invalid capability handle permissions.');
    }
    const token = this.tokenFactory();
    if (!/^[0-9a-f]{64}$/.test(token) || this.handles.has(token)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Token factory produced an invalid or duplicate handle token.');
    const handle = Object.freeze({ kind, id, generation: this.generation, token, permissions: Object.freeze(uniquePermissions) });
    this.handles.set(token, handle);
    return handle;
  }

  revokeHandle(handle: ScriptCapabilityHandle): void { this.handles.delete(handle.token); }

  invoke(request: ScriptInvocationRequest, signal?: AbortSignal): Promise<ScriptInvocationResult> {
    this.assertAlive();
    const operation = this.queue.then(() => this.invokeOne(request, signal));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async replacePrograms(programs: readonly RuntimeScriptProgram[]): Promise<void> {
    this.assertAlive();
    await this.retireWorker('E_SCRIPT_ABORTED', 'Sandbox generation was replaced.');
    this.generation += 1;
    this.handles.clear();
    this.programs = Object.freeze([...programs]);
    this.scopeInstructions = 0;
    this.crashed = false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.retireWorker('E_SCRIPT_DISPOSED', 'Sandbox owner was disposed.');
    this.generation += 1;
    this.handles.clear();
  }

  stats(): Readonly<{ generation: number; handles: number; pending: number; worker: number; scopeInstructions: number; crashed: boolean; disposed: boolean }> {
    return Object.freeze({ generation: this.generation, handles: this.handles.size, pending: this.pending.size, worker: this.worker === null ? 0 : 1, scopeInstructions: this.scopeInstructions, crashed: this.crashed, disposed: this.disposed });
  }

  private async invokeOne(request: ScriptInvocationRequest, externalSignal?: AbortSignal): Promise<ScriptInvocationResult> {
    validateScriptInvocationRequest(request, this.options.limits.maxCallDepth);
    if (externalSignal?.aborted) scriptRuntimeFail('E_SCRIPT_ABORTED', 'Invocation was aborted.', ids(request));
    const instructionBudget = Math.min(
      this.options.limits.maxInstructionsPerInvocation,
      this.options.limits.maxInstructionsPerScope - this.scopeInstructions,
    );
    if (instructionBudget <= 0) scriptRuntimeFail('E_SCRIPT_TIMEOUT', 'Sandbox scope instruction budget is exhausted.', ids(request));
    await this.ensureWorker();
    const worker = this.worker;
    if (worker === null) scriptRuntimeFail('E_SCRIPT_WORKER_CRASH', 'Worker is unavailable.', ids(request));
    if (this.pending.has(request.invocationId)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Duplicate invocation identity.', ids(request));
    const controller = new AbortController();
    let removeExternalAbort: () => void = () => undefined;
    const promise = new Promise<ScriptInvocationResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        controller.abort();
        this.scopeInstructions = Math.min(this.options.limits.maxInstructionsPerScope, this.scopeInstructions + instructionBudget);
        worker.postMessage({ version: PROTOCOL_VERSION, type: 'abort', generation: this.generation, invocationId: request.invocationId });
        void this.crash(new AnimationScriptRuntimeError('E_SCRIPT_TIMEOUT', 'Worker wall-time deadline exceeded.', ids(request)));
      }, this.options.limits.maxWallTimeMs + this.timeoutGraceMs);
      if (externalSignal !== undefined) {
        const onAbort = () => {
          controller.abort();
          worker.postMessage({ version: PROTOCOL_VERSION, type: 'abort', generation: this.generation, invocationId: request.invocationId });
          this.rejectPending(request.invocationId, new AnimationScriptRuntimeError('E_SCRIPT_ABORTED', 'Invocation was aborted.', ids(request)));
        };
        externalSignal.addEventListener('abort', onAbort, { once: true });
        removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort);
      }
      this.pending.set(request.invocationId, { request, resolve, reject, controller, instructionBudget, timeout, removeExternalAbort });
      worker.postMessage({ version: PROTOCOL_VERSION, type: 'invoke', generation: this.generation, instructionBudget, request });
    });
    return promise;
  }

  private ensureWorker(): Promise<void> {
    if (this.worker !== null && this.ready !== null) return this.ready;
    this.crashed = false;
    const worker = this.options.workerFactory();
    this.worker = worker;
    this.ready = new Promise<void>(resolve => { this.readyResolve = resolve; });
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    worker.addEventListener('messageerror', this.onMessageError);
    worker.postMessage({ version: PROTOCOL_VERSION, type: 'init', generation: this.generation, programs: this.programs, limits: this.options.limits });
    return this.ready;
  }

  private readonly onMessage = (event: SandboxWorkerMessageEvent): void => {
    const message = record(event.data);
    if (message === null || message.version !== PROTOCOL_VERSION || message.generation !== this.generation) return;
    if (message.type === 'ready') { this.readyResolve?.(); this.readyResolve = null; return; }
    if (message.type === 'result') {
      const invocationId = text(message.invocationId); const pending = this.takePending(invocationId);
      if (pending !== undefined && !pending.controller.signal.aborted) {
        try {
          validateScriptWireGraph(message.result, this.options.limits.maxCallDepth, '$worker.result');
          const result = validateInvocationResult(message.result, pending);
          this.validateWireValue(result.value, undefined, pending.request, 0);
          this.consumeInstructions(result.stats.instructions, pending);
          pending.resolve(result);
        } catch (error) {
          const failure = error instanceof Error ? error : new AnimationScriptRuntimeError('E_SCRIPT_PROTOCOL', 'Worker returned an invalid result.', ids(pending.request));
          pending.reject(failure);
          void this.crash(failure);
        }
      }
      return;
    }
    if (message.type === 'error') {
      const invocationId = text(message.invocationId); const pending = this.takePending(invocationId);
      if (pending !== undefined) {
        try {
          this.consumeInstructions(diagnosticInstructions(message.diagnostic, pending), pending);
          pending.reject(fromDiagnostic(message.diagnostic, pending.request));
        } catch (error) {
          const failure = error instanceof Error ? error : new AnimationScriptRuntimeError('E_SCRIPT_PROTOCOL', 'Worker returned an invalid diagnostic.', ids(pending.request));
          pending.reject(failure);
          void this.crash(failure);
        }
      }
      return;
    }
    if (message.type === 'capability') void this.handleCapability(message);
  };

  private readonly onError = (event: SandboxWorkerErrorEvent): void => { void this.crash(new AnimationScriptRuntimeError('E_SCRIPT_WORKER_CRASH', event.message ?? 'Worker crashed.')); };
  private readonly onMessageError = (): void => { void this.crash(new AnimationScriptRuntimeError('E_SCRIPT_PROTOCOL', 'Worker message could not be cloned.')); };

  private async handleCapability(message: Record<string, unknown>): Promise<void> {
    const worker = this.worker;
    const invocationId = text(message.invocationId);
    const requestId = uint(message.requestId);
    const pending = this.pending.get(invocationId);
    if (worker === null || pending === undefined || pending.controller.signal.aborted) return;
    const request = message.request as ScriptCapabilityRequest;
    try {
      this.validateCapabilityRequest(request, pending.request);
      const value = await this.options.capabilityPort.invoke(request, pending.controller.signal);
      this.validateWireValue(value, CAPABILITY_PERMISSION[request.capability], pending.request, 0);
      if (this.pending.has(invocationId) && !pending.controller.signal.aborted) worker.postMessage({ version: PROTOCOL_VERSION, type: 'capability-result', generation: this.generation, invocationId, requestId, value });
    } catch (error) {
      if (this.pending.has(invocationId) && !pending.controller.signal.aborted) worker.postMessage({ version: PROTOCOL_VERSION, type: 'capability-error', generation: this.generation, invocationId, requestId, message: safeMessage(error) });
    }
  }

  private consumeInstructions(instructions: number, pending: PendingInvocation): void {
    if (!Number.isSafeInteger(instructions) || instructions < 0 || instructions > pending.instructionBudget) {
      scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker reported invalid instruction usage.', ids(pending.request));
    }
    this.scopeInstructions += instructions;
    if (this.scopeInstructions > this.options.limits.maxInstructionsPerScope) {
      scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker exceeded the sandbox scope instruction budget.', ids(pending.request));
    }
  }

  private validateCapabilityRequest(request: ScriptCapabilityRequest, invocation: ScriptInvocationRequest): void {
    validateScriptWireGraph(request, this.options.limits.maxCallDepth, '$worker.capability');
    const envelope = request as unknown as Record<string, unknown>;
    if (!hasExactKeys(envelope, ['invocationId', 'sequence', 'programId', 'capability', 'arguments'])
      || !Number.isSafeInteger(request.sequence) || request.sequence < 0 || !Array.isArray(request.arguments)) {
      scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker emitted an invalid capability envelope.', ids(invocation));
    }
    if (request.invocationId !== invocation.invocationId || request.programId !== invocation.programId || !CAPABILITY_PERMISSION[request.capability]) {
      scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker emitted an invalid capability envelope.', ids(invocation));
    }
    const program = this.programs.find(entry => entry.id === invocation.programId);
    if (program === undefined || !program.capabilities.includes(request.capability)) scriptRuntimeFail('E_SCRIPT_CAPABILITY_DENIED', 'Worker requested an undeclared capability.', ids(invocation));
    for (const value of request.arguments) this.validateWireValue(value, CAPABILITY_PERMISSION[request.capability], invocation, 0);
    const targetKinds = CAPABILITY_TARGET_KINDS[request.capability];
    if (targetKinds !== undefined) {
      const target = request.arguments[0];
      if (target === null || typeof target !== 'object' || Array.isArray(target) || !isHandle(target) || !targetKinds.has(target.kind)) {
        scriptRuntimeFail('E_SCRIPT_CAPABILITY_DENIED', `${request.capability} requires a typed target handle.`, ids(invocation));
      }
    }
  }

  private validateWireValue(value: ScriptWireValue, permission: 'read' | 'write' | 'invoke' | undefined, invocation: ScriptInvocationRequest, depth: number): void {
    if (depth === 0) validateScriptWireGraph(value, this.options.limits.maxCallDepth, '$capability.value');
    if (depth > this.options.limits.maxCallDepth) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Capability value nesting exceeded.', ids(invocation));
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Capability value must be finite.', ids(invocation)); return; }
    if (Array.isArray(value)) { for (const entry of value) this.validateWireValue(entry, permission, invocation, depth + 1); return; }
    if (isHandle(value)) {
      const owned = this.handles.get(value.token);
      if (owned === undefined || owned.generation !== this.generation || owned.id !== value.id || owned.kind !== value.kind
        || (permission !== undefined && !owned.permissions.includes(permission))) {
        scriptRuntimeFail('E_SCRIPT_CAPABILITY_DENIED', 'Capability handle is forged, stale, or lacks permission.', ids(invocation));
      }
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Forbidden capability object key.', ids(invocation));
      this.validateWireValue(entry, permission, invocation, depth + 1);
    }
  }

  private async crash(error: Error): Promise<void> {
    if (this.worker === null) return;
    this.crashed = true;
    await this.retireWorker(error instanceof AnimationScriptRuntimeError ? error.code : 'E_SCRIPT_WORKER_CRASH', error.message);
  }

  private async retireWorker(code: AnimationScriptRuntimeError['code'], message: string): Promise<void> {
    const worker = this.worker;
    this.worker = null; this.ready = null; this.readyResolve = null;
    if (worker !== null) {
      worker.removeEventListener('message', this.onMessage);
      worker.removeEventListener('error', this.onError);
      worker.removeEventListener('messageerror', this.onMessageError);
      try { worker.postMessage({ version: PROTOCOL_VERSION, type: 'dispose', generation: this.generation }); } catch {}
      worker.terminate();
    }
    for (const [invocationId, pending] of [...this.pending]) this.rejectPending(invocationId, new AnimationScriptRuntimeError(code, message, ids(pending.request)));
    await this.options.capabilityPort.disposeScope?.(this.generation);
  }

  private takePending(invocationId: string): PendingInvocation | undefined {
    const pending = this.pending.get(invocationId);
    if (pending !== undefined) { clearTimeout(pending.timeout); pending.removeExternalAbort(); this.pending.delete(invocationId); }
    return pending;
  }

  private rejectPending(invocationId: string, error: Error): void { this.takePending(invocationId)?.reject(error); }
  private assertAlive(): void { if (this.disposed) scriptRuntimeFail('E_SCRIPT_DISPOSED', 'Sandbox owner is disposed.'); }
}

function ids(request: ScriptInvocationRequest): { programId: string; invocationId: string } { return { programId: request.programId, invocationId: request.invocationId }; }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function uint(value: unknown): number { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0; }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : 'Capability failed.').replace(/\b(?:https?|file):\/\/\S+/gi, '[redacted-url]').slice(0, 512); }

function fromDiagnostic(value: unknown, request: ScriptInvocationRequest): AnimationScriptRuntimeError {
  const diagnostic = record(value);
  const code = typeof diagnostic?.code === 'string' ? diagnostic.code : 'E_SCRIPT_RUNTIME_ERROR';
  const allowed = new Set(['E_SCRIPT_RUNTIME_ERROR', 'E_SCRIPT_TIMEOUT', 'E_SCRIPT_OOM', 'E_SCRIPT_CAPABILITY_DENIED', 'E_SCRIPT_PROTOCOL', 'E_SCRIPT_ABORTED', 'E_SCRIPT_WORKER_CRASH', 'E_SCRIPT_EVENT_BUDGET', 'E_SCRIPT_DISPOSED']);
  const location = runtimeLocation(diagnostic?.location);
  const instructions = diagnostic?.instructions;
  return new AnimationScriptRuntimeError(
    (allowed.has(code) ? code : 'E_SCRIPT_PROTOCOL') as AnimationScriptRuntimeError['code'],
    typeof diagnostic?.message === 'string' ? diagnostic.message : 'Worker failed.',
    {
      ...ids(request),
      path: typeof diagnostic?.path === 'string' ? diagnostic.path.slice(0, 256) : undefined,
      location,
      instructions: Number.isSafeInteger(instructions) ? instructions as number : undefined,
    },
  );
}

function diagnosticInstructions(value: unknown, pending: PendingInvocation): number {
  const diagnostic = record(value);
  if (diagnostic === null) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker returned an invalid diagnostic envelope.', ids(pending.request));
  const instructions = diagnostic.instructions;
  if (!Number.isSafeInteger(instructions) || (instructions as number) < 0 || (instructions as number) > pending.instructionBudget) {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker returned invalid diagnostic instruction usage.', ids(pending.request));
  }
  return instructions as number;
}

function runtimeLocation(value: unknown): { sourceId: string; line: number; column: number } | undefined {
  const location = record(value);
  if (location === null || typeof location.sourceId !== 'string' || !Number.isSafeInteger(location.line) || !Number.isSafeInteger(location.column)) return undefined;
  if (/[:\\]|(?:^|\/)\.\.(?:\/|$)|^(?:https?|file):/i.test(location.sourceId)) return undefined;
  return { sourceId: location.sourceId.slice(0, 256), line: location.line as number, column: location.column as number };
}

function validateInvocationResult(value: unknown, pending: PendingInvocation): ScriptInvocationResult {
  const result = record(value);
  const stats = record(result?.stats);
  if (result === null || stats === null || !hasExactKeys(result, ['invocationId', 'value', 'stats'])
    || result.invocationId !== pending.request.invocationId) {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker returned an invalid result envelope.', ids(pending.request));
  }
  const exactStats = ['instructions', 'peakHeapBytes', 'maxCallDepth', 'capabilityCalls', 'outputCommands', 'events', 'promises'];
  if (Object.keys(stats).length !== exactStats.length || exactStats.some(key => !Object.hasOwn(stats, key))) {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker returned invalid invocation statistics.', ids(pending.request));
  }
  for (const key of exactStats) {
    if (!Number.isSafeInteger(stats[key]) || (stats[key] as number) < 0) {
      scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker returned non-finite invocation statistics.', ids(pending.request));
    }
  }
  if ((stats.instructions as number) > pending.instructionBudget) {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Worker exceeded its assigned instruction budget.', ids(pending.request));
  }
  return result as unknown as ScriptInvocationResult;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function isHandle(value: object): value is ScriptCapabilityHandle {
  const candidate = value as Partial<ScriptCapabilityHandle>;
  return typeof candidate.kind === 'string' && typeof candidate.id === 'string' && Number.isSafeInteger(candidate.generation) && typeof candidate.token === 'string' && Array.isArray(candidate.permissions);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
