import { AnimationScriptRuntimeError } from './diagnostics.js';
import { PortableScriptVm } from './PortableScriptVm.js';
import type {
  RuntimeScriptLimits,
  RuntimeScriptProgram,
  ScriptCapabilityPort,
  ScriptCapabilityRequest,
  ScriptInvocationRequest,
  ScriptWireValue,
} from './runtime-types.js';

const PROTOCOL_VERSION = 1;

interface WorkerEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

interface InvocationState {
  readonly controller: AbortController;
  readonly port: RemoteCapabilityPort;
}

export function installAnimationScriptWorkerRuntime(endpoint: WorkerEndpoint): () => void {
  let generation = 0;
  let limits: RuntimeScriptLimits | null = null;
  let programs = new Map<string, RuntimeScriptProgram>();
  const invocations = new Map<string, InvocationState>();
  const onMessage = (event: { data: unknown }) => {
    const message = record(event.data);
    if (message === null || message.version !== PROTOCOL_VERSION || typeof message.type !== 'string') return;
    if (message.type === 'init') {
      abortAll(invocations);
      generation = uint(message.generation);
      limits = message.limits as RuntimeScriptLimits;
      programs = new Map((message.programs as RuntimeScriptProgram[]).map(program => [program.id, program]));
      endpoint.postMessage({ version: PROTOCOL_VERSION, type: 'ready', generation });
      return;
    }
    if (uint(message.generation) !== generation) return;
    if (message.type === 'invoke') {
      const request = message.request as ScriptInvocationRequest;
      if (limits === null || typeof request?.invocationId !== 'string' || invocations.has(request.invocationId)) return;
      const program = programs.get(request.programId);
      if (program === undefined) {
        endpoint.postMessage({ version: PROTOCOL_VERSION, type: 'error', generation, invocationId: request.invocationId, diagnostic: { code: 'E_SCRIPT_PROTOCOL', message: 'Unknown program.', instructions: 0 } });
        return;
      }
      const instructionBudget = uint(message.instructionBudget);
      if (instructionBudget === 0 || instructionBudget > limits.maxInstructionsPerInvocation) {
        endpoint.postMessage({ version: PROTOCOL_VERSION, type: 'error', generation, invocationId: request.invocationId, diagnostic: { code: 'E_SCRIPT_PROTOCOL', message: 'Invalid invocation instruction budget.', instructions: 0 } });
        return;
      }
      const controller = new AbortController();
      const port = new RemoteCapabilityPort(endpoint, generation, request.invocationId);
      invocations.set(request.invocationId, { controller, port });
      const invocationLimits = Object.freeze({ ...limits, maxInstructionsPerInvocation: instructionBudget });
      void new PortableScriptVm(program, invocationLimits, port).invoke(request, controller.signal).then(
        result => endpoint.postMessage({ version: PROTOCOL_VERSION, type: 'result', generation, invocationId: request.invocationId, result }),
        error => endpoint.postMessage({ version: PROTOCOL_VERSION, type: 'error', generation, invocationId: request.invocationId, diagnostic: diagnostic(error) }),
      ).finally(() => {
        port.dispose();
        invocations.delete(request.invocationId);
      });
      return;
    }
    if (message.type === 'abort') {
      const invocationId = text(message.invocationId);
      invocations.get(invocationId)?.controller.abort();
      return;
    }
    if (message.type === 'capability-result' || message.type === 'capability-error') {
      const invocationId = text(message.invocationId);
      invocations.get(invocationId)?.port.receive(message);
      return;
    }
    if (message.type === 'dispose') {
      abortAll(invocations);
      programs.clear(); limits = null;
      endpoint.postMessage({ version: PROTOCOL_VERSION, type: 'disposed', generation });
    }
  };
  endpoint.addEventListener('message', onMessage);
  return () => {
    endpoint.removeEventListener('message', onMessage);
    abortAll(invocations);
    programs.clear(); limits = null;
  };
}

class RemoteCapabilityPort implements ScriptCapabilityPort {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: ScriptWireValue): void; reject(error: Error): void }>();

  constructor(private readonly endpoint: WorkerEndpoint, private readonly generation: number, private readonly invocationId: string) {}

  invoke(request: ScriptCapabilityRequest, signal: AbortSignal): Promise<ScriptWireValue> {
    const requestId = ++this.sequence;
    return new Promise<ScriptWireValue>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        resolve: value => { signal.removeEventListener('abort', onAbort); resolve(value); },
        reject: error => { signal.removeEventListener('abort', onAbort); reject(error); },
      });
      this.endpoint.postMessage({ version: PROTOCOL_VERSION, type: 'capability', generation: this.generation, invocationId: this.invocationId, requestId, request });
    });
  }

  receive(message: Record<string, unknown>): void {
    const requestId = uint(message.requestId);
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    if (message.type === 'capability-result') pending.resolve(message.value as ScriptWireValue);
    else pending.reject(new Error(typeof message.message === 'string' ? message.message : 'Capability failed.'));
  }

  dispose(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('disposed'));
    this.pending.clear();
  }
}

function abortAll(invocations: Map<string, InvocationState>): void {
  for (const state of invocations.values()) { state.controller.abort(); state.port.dispose(); }
  invocations.clear();
}

function diagnostic(error: unknown): Record<string, unknown> {
  if (error instanceof AnimationScriptRuntimeError) return error.diagnostic as unknown as Record<string, unknown>;
  return { code: 'E_SCRIPT_RUNTIME_ERROR', message: error instanceof Error ? error.message.slice(0, 512) : 'Unknown worker failure.' };
}

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function uint(value: unknown): number { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
