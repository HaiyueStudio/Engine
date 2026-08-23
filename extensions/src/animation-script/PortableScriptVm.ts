import { AnimationScriptRuntimeError, scriptRuntimeFail } from './diagnostics.js';
import type {
  RuntimeScriptLimits,
  RuntimeScriptProgram,
  ScriptCapability,
  ScriptCapabilityHandle,
  ScriptCapabilityPort,
  ScriptFunction,
  ScriptInstruction,
  ScriptInvocationRequest,
  ScriptInvocationResult,
  ScriptLocation,
  ScriptWireValue,
} from './runtime-types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const OUTPUT_CAPABILITIES = new Set<ScriptCapability>(['path.emit', 'canvas.emit']);

interface VmList { readonly kind: 'list'; readonly owned: boolean; readonly values: VmValue[] }
interface VmTable { readonly kind: 'table'; readonly owned: boolean; readonly values: Map<string, VmValue> }
interface VmHandle { readonly kind: 'handle'; readonly value: ScriptCapabilityHandle }
type VmValue = null | boolean | number | string | VmList | VmTable | VmHandle;

interface Counters {
  instructions: number;
  heapBytes: number;
  peakHeapBytes: number;
  depth: number;
  maxDepth: number;
  capabilityCalls: number;
  outputCommands: number;
  events: number;
  promises: number;
  pendingPromises: number;
  timers: number;
  capabilitySequence: number;
}

export interface PortableScriptVmOptions {
  readonly monotonicNow?: (() => number) | undefined;
}

export class PortableScriptVm {
  private readonly functions = new Map<string, ScriptFunction>();
  private readonly capabilities: ReadonlySet<ScriptCapability>;
  private readonly now: () => number;

  constructor(
    private readonly program: RuntimeScriptProgram,
    private readonly limits: RuntimeScriptLimits,
    private readonly capabilityPort: ScriptCapabilityPort,
    options: PortableScriptVmOptions = {},
  ) {
    for (const func of program.functions) this.functions.set(func.id, func);
    this.capabilities = new Set(program.capabilities);
    this.now = options.monotonicNow ?? (() => performance.now());
  }

  async invoke(request: ScriptInvocationRequest, signal: AbortSignal): Promise<ScriptInvocationResult> {
    validateScriptInvocationRequest(request, this.limits.maxCallDepth);
    if (request.programId !== this.program.id) {
      scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Invocation program does not match the VM owner.', context(request));
    }
    const functionId = this.program.entrypoints[request.entrypoint];
    if (functionId === undefined) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Unknown entrypoint ${request.entrypoint}.`, context(request));
    const func = this.functions.get(functionId);
    if (func === undefined) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Entrypoint function is missing.', context(request));
    const counters: Counters = {
      instructions: 0, heapBytes: 0, peakHeapBytes: 0, depth: 0, maxDepth: 0,
      capabilityCalls: 0, outputCommands: 0, events: 0, promises: 0, pendingPromises: 0,
      timers: 0, capabilitySequence: 0,
    };
    const deadline = this.now() + this.limits.maxWallTimeMs;
    const inputs = this.cloneRecord(request.inputs, counters, request, 0);
    const invocationContext = this.cloneRecord(request.context as unknown as Readonly<Record<string, ScriptWireValue>>, counters, request, 0);
    const random = new Xoshiro128(request.context.seed);
    const args = request.arguments.map(value => this.cloneWire(value, counters, request, 0));
    try {
      const value = await this.execute(func, args, inputs, invocationContext, random, counters, deadline, request, signal);
      return Object.freeze({
        invocationId: request.invocationId,
        value: deepFreezeWire(this.toWire(value, request, 0)),
        stats: Object.freeze({
          instructions: counters.instructions,
          peakHeapBytes: counters.peakHeapBytes,
          maxCallDepth: counters.maxDepth,
          capabilityCalls: counters.capabilityCalls,
          outputCommands: counters.outputCommands,
          events: counters.events,
          promises: counters.promises,
        }),
      });
    } catch (error) {
      if (error instanceof AnimationScriptRuntimeError) {
        throw new AnimationScriptRuntimeError(error.code, error.diagnostic.message, {
          programId: error.diagnostic.programId,
          invocationId: error.diagnostic.invocationId,
          path: error.diagnostic.path,
          location: error.diagnostic.location,
          instructions: counters.instructions,
        });
      }
      if (signal.aborted) scriptRuntimeFail('E_SCRIPT_ABORTED', 'Invocation was aborted.', context(request));
      scriptRuntimeFail('E_SCRIPT_RUNTIME_ERROR', error instanceof Error ? error.message : 'Unknown VM failure.', context(request));
    }
  }

  private async execute(
    func: ScriptFunction,
    args: readonly VmValue[],
    inputs: VmTable,
    invocationContext: VmTable,
    random: Xoshiro128,
    counters: Counters,
    deadline: number,
    request: ScriptInvocationRequest,
    signal: AbortSignal,
  ): Promise<VmValue> {
    counters.depth += 1;
    counters.maxDepth = Math.max(counters.maxDepth, counters.depth);
    if (counters.depth > this.limits.maxCallDepth) this.fail('E_SCRIPT_RUNTIME_ERROR', 'Call depth budget exceeded.', request);
    this.allocate(func.registers * 8 + 32, counters, request);
    const registers = Array<VmValue>(func.registers).fill(null);
    for (let index = 0; index < Math.min(args.length, func.parameters); index += 1) registers[index] = args[index] ?? null;
    let pc = 0;
    try {
      while (pc < func.instructions.length) {
        const instruction = func.instructions[pc]!;
        this.checkpoint(counters, deadline, request, signal, instruction.location);
        counters.instructions += 1;
        switch (instruction.op) {
          case 'load-constant': registers[num(instruction, 'to')] = this.program.constants[num(instruction, 'constant')] ?? null; break;
          case 'load-input': registers[num(instruction, 'to')] = inputs.values.get(key(instruction, 'name')) ?? null; break;
          case 'load-context': registers[num(instruction, 'to')] = getPath(invocationContext, stringArray(instruction, 'path')); break;
          case 'random': registers[num(instruction, 'to')] = random.next(); break;
          case 'move': registers[num(instruction, 'to')] = register(registers, instruction, 'from'); break;
          case 'unary': registers[num(instruction, 'to')] = unary(key(instruction, 'operator'), register(registers, instruction, 'value'), instruction.location, request); break;
          case 'binary': {
            const operator = key(instruction, 'operator');
            const result = binary(operator, register(registers, instruction, 'left'), register(registers, instruction, 'right'), instruction.location, request);
            if (operator === 'concat' && typeof result === 'string') this.allocate(utf8Bytes(result), counters, request, instruction.location);
            registers[num(instruction, 'to')] = result;
            break;
          }
          case 'make-list': {
            const values = numberArray(instruction, 'values').map(index => registers[index] ?? null);
            this.allocate(24 + values.length * 8, counters, request, instruction.location);
            registers[num(instruction, 'to')] = { kind: 'list', owned: true, values };
            break;
          }
          case 'make-table': {
            const values = new Map<string, VmValue>();
            const entries = objectArray(instruction, 'entries');
            let bytes = 48;
            for (const entry of entries) {
              const entryKey = safeKey(entry.key, instruction.location, request);
              bytes += utf8Bytes(entryKey) + 16;
              values.set(entryKey, registers[finiteIndex(entry.value, registers.length, instruction.location, request)] ?? null);
            }
            this.allocate(bytes, counters, request, instruction.location);
            registers[num(instruction, 'to')] = { kind: 'table', owned: true, values };
            break;
          }
          case 'get': registers[num(instruction, 'to')] = getValue(register(registers, instruction, 'target'), register(registers, instruction, 'key'), instruction.location, request); break;
          case 'set': setValue(
            register(registers, instruction, 'target'),
            register(registers, instruction, 'key'),
            register(registers, instruction, 'value'),
            instruction.location,
            request,
            bytes => this.allocate(bytes, counters, request, instruction.location),
          ); break;
          case 'jump': pc = num(instruction, 'target'); continue;
          case 'jump-if': if (truthy(register(registers, instruction, 'condition')) === bool(instruction, 'when')) { pc = num(instruction, 'target'); continue; } break;
          case 'call': {
            const target = this.functions.get(key(instruction, 'function'));
            if (target === undefined) this.fail('E_SCRIPT_PROTOCOL', 'Function reference is missing.', request, instruction.location);
            const callArgs = numberArray(instruction, 'arguments').map(index => registers[index] ?? null);
            registers[num(instruction, 'to')] = await this.execute(target, callArgs, inputs, invocationContext, random, counters, deadline, request, signal);
            break;
          }
          case 'capability': {
            const capability = key(instruction, 'capability') as ScriptCapability;
            const invocationArgs = numberArray(instruction, 'arguments').map(index => this.toWire(registers[index] ?? null, request, 0));
            const result = await this.invokeCapability(capability, invocationArgs, counters, request, signal, instruction.location);
            const destination = instruction.to;
            if (typeof destination === 'number') registers[destination] = result;
            break;
          }
          case 'return': return typeof instruction.value === 'number' ? registers[instruction.value] ?? null : null;
          default: this.fail('E_SCRIPT_PROTOCOL', `Unknown runtime instruction ${instruction.op}.`, request, instruction.location);
        }
        pc += 1;
      }
      return null;
    } finally {
      counters.depth -= 1;
    }
  }

  private async invokeCapability(
    capability: ScriptCapability,
    args: readonly ScriptWireValue[],
    counters: Counters,
    request: ScriptInvocationRequest,
    signal: AbortSignal,
    location?: ScriptLocation,
  ): Promise<VmValue> {
    if (!this.capabilities.has(capability)) this.fail('E_SCRIPT_CAPABILITY_DENIED', `Capability ${capability} was not declared.`, request, location);
    counters.capabilityCalls += 1;
    if (OUTPUT_CAPABILITIES.has(capability) && ++counters.outputCommands > this.limits.maxOutputCommands) {
      this.fail('E_SCRIPT_EVENT_BUDGET', 'Output command budget exceeded.', request, location);
    }
    if (capability === 'event.emit' && ++counters.events > this.limits.maxEventsPerInvocation) {
      this.fail('E_SCRIPT_EVENT_BUDGET', 'Event budget exceeded.', request, location);
    }
    if (capability === 'timer.schedule' && ++counters.timers > this.limits.maxTimers) {
      this.fail('E_SCRIPT_EVENT_BUDGET', 'Timer budget exceeded.', request, location);
    }
    if (capability === 'timer.cancel') counters.timers = Math.max(0, counters.timers - 1);
    let result: ScriptWireValue | Promise<ScriptWireValue>;
    try {
      result = this.capabilityPort.invoke(Object.freeze({
        invocationId: request.invocationId,
        sequence: ++counters.capabilitySequence,
        programId: request.programId,
        capability,
        arguments: args,
      }), signal);
    } catch (error) {
      this.fail('E_SCRIPT_CAPABILITY_DENIED', error instanceof Error ? error.message : 'Capability failed.', request, location);
    }
    if (isPromise(result)) {
      counters.promises += 1;
      counters.pendingPromises += 1;
      if (counters.pendingPromises > this.limits.maxPendingPromises) this.fail('E_SCRIPT_EVENT_BUDGET', 'Promise budget exceeded.', request, location);
      try { result = await abortable(result, signal); }
      catch (error) {
        if (signal.aborted) this.fail('E_SCRIPT_ABORTED', 'Invocation was aborted.', request, location);
        this.fail('E_SCRIPT_CAPABILITY_DENIED', error instanceof Error ? error.message : 'Capability failed.', request, location);
      }
      finally { counters.pendingPromises -= 1; }
    }
    return this.cloneWire(result, counters, request, 0);
  }

  private cloneRecord(input: Readonly<Record<string, ScriptWireValue>>, counters: Counters, request: ScriptInvocationRequest, depth: number): VmTable {
    const values = new Map<string, VmValue>();
    let bytes = 48;
    for (const [rawKey, value] of Object.entries(input)) {
      const currentKey = safeKey(rawKey, undefined, request);
      bytes += utf8Bytes(currentKey) + 16;
      values.set(currentKey, this.cloneWire(value, counters, request, depth + 1));
    }
    this.allocate(bytes, counters, request);
    return { kind: 'table', owned: false, values };
  }

  private cloneWire(value: ScriptWireValue, counters: Counters, request: ScriptInvocationRequest, depth: number): VmValue {
    if (depth > this.limits.maxCallDepth) this.fail('E_SCRIPT_OOM', 'Input nesting budget exceeded.', request);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) this.fail('E_SCRIPT_PROTOCOL', 'Host values must be finite.', request);
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'string') { this.allocate(utf8Bytes(value), counters, request); return value; }
    if (Array.isArray(value)) {
      this.allocate(24 + value.length * 8, counters, request);
      return { kind: 'list', owned: false, values: value.map(entry => this.cloneWire(entry, counters, request, depth + 1)) };
    }
    if (isHandle(value)) {
      this.allocate(96 + utf8Bytes(value.id) + utf8Bytes(value.token), counters, request);
      return { kind: 'handle', value: Object.freeze({ ...value, permissions: Object.freeze([...value.permissions]) }) };
    }
    return this.cloneRecord(value as Readonly<Record<string, ScriptWireValue>>, counters, request, depth + 1);
  }

  private toWire(value: VmValue, request: ScriptInvocationRequest, depth: number): ScriptWireValue {
    if (depth > this.limits.maxCallDepth) this.fail('E_SCRIPT_OOM', 'Output nesting budget exceeded.', request);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) this.fail('E_SCRIPT_PROTOCOL', 'Non-finite output is forbidden.', request);
      return Object.is(value, -0) ? 0 : value;
    }
    if (value.kind === 'handle') return value.value;
    if (value.kind === 'list') return value.values.map(entry => this.toWire(entry, request, depth + 1));
    const result: Record<string, ScriptWireValue> = Object.create(null) as Record<string, ScriptWireValue>;
    for (const [entryKey, entry] of value.values) result[entryKey] = this.toWire(entry, request, depth + 1);
    return result;
  }

  private checkpoint(counters: Counters, deadline: number, request: ScriptInvocationRequest, signal: AbortSignal, location?: ScriptLocation): void {
    if (signal.aborted) this.fail('E_SCRIPT_ABORTED', 'Invocation was aborted.', request, location);
    if (counters.instructions >= this.limits.maxInstructionsPerInvocation) this.fail('E_SCRIPT_TIMEOUT', 'Instruction budget exceeded.', request, location);
    if ((counters.instructions & 255) === 0 && this.now() > deadline) this.fail('E_SCRIPT_TIMEOUT', 'Wall-time budget exceeded.', request, location);
  }

  private allocate(bytes: number, counters: Counters, request: ScriptInvocationRequest, location?: ScriptLocation): void {
    counters.heapBytes += bytes;
    counters.peakHeapBytes = Math.max(counters.peakHeapBytes, counters.heapBytes);
    if (counters.heapBytes > this.limits.maxHeapBytes) this.fail('E_SCRIPT_OOM', 'Tracked heap budget exceeded.', request, location);
  }

  private fail(code: Parameters<typeof scriptRuntimeFail>[0], message: string, request: ScriptInvocationRequest, location?: ScriptLocation): never {
    return scriptRuntimeFail(code, message, { ...context(request), location });
  }
}

export function validateScriptInvocationRequest(request: ScriptInvocationRequest, maxDepth: number): void {
  assertPlainWireGraph(request, '$request', maxDepth, 0, new Set(), new Set());
  const envelope = request as unknown as Record<string, unknown>;
  exactRuntimeKeys(envelope, '$request', ['invocationId', 'programId', 'entrypoint', 'arguments', 'inputs', 'context']);
  if (typeof request.invocationId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(request.invocationId)) {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Invocation identity is invalid.');
  }
  if (typeof request.programId !== 'string' || typeof request.entrypoint !== 'string') {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Program or entrypoint identity is invalid.', context(request));
  }
  const invocationContext = request.context as unknown as Record<string, unknown>;
  exactRuntimeKeys(invocationContext, '$request.context', ['clockMicros', 'seed', 'pointer', 'keyboard', 'gamepad', 'focus', 'data'], true);
  if (!Number.isSafeInteger(request.context.clockMicros) || request.context.clockMicros < 0) {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Injected clock must be a non-negative safe integer.', context(request));
  }
  if (!Array.isArray(request.context.seed) || request.context.seed.length !== 4
    || request.context.seed.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff)) {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Injected random seed must contain four uint32 values.', context(request));
  }
}

export function validateScriptWireGraph(value: unknown, maxDepth: number, path = '$value'): void {
  assertPlainWireGraph(value, path, maxDepth, 0, new Set(), new Set());
}

function context(request: ScriptInvocationRequest): { programId: string; invocationId: string } {
  return { programId: request.programId, invocationId: request.invocationId };
}

function register(registers: readonly VmValue[], instruction: ScriptInstruction, field: string): VmValue {
  return registers[num(instruction, field)] ?? null;
}

function num(instruction: ScriptInstruction, field: string): number {
  const value = instruction[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid instruction field ${field}.`);
  return value;
}

function bool(instruction: ScriptInstruction, field: string): boolean {
  const value = instruction[field]; if (typeof value !== 'boolean') throw new Error(`Invalid instruction field ${field}.`); return value;
}

function key(instruction: ScriptInstruction, field: string): string {
  const value = instruction[field]; if (typeof value !== 'string') throw new Error(`Invalid instruction field ${field}.`); return value;
}

function numberArray(instruction: ScriptInstruction, field: string): number[] {
  const value = instruction[field]; if (!Array.isArray(value) || !value.every(entry => Number.isSafeInteger(entry))) throw new Error(`Invalid instruction field ${field}.`); return value as number[];
}

function stringArray(instruction: ScriptInstruction, field: string): string[] {
  const value = instruction[field]; if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) throw new Error(`Invalid instruction field ${field}.`); return value as string[];
}

function objectArray(instruction: ScriptInstruction, field: string): { key: unknown; value: unknown }[] {
  const value = instruction[field]; if (!Array.isArray(value)) throw new Error(`Invalid instruction field ${field}.`); return value as { key: unknown; value: unknown }[];
}

function finiteIndex(value: unknown, length: number, location: ScriptLocation | undefined, request: ScriptInvocationRequest): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Register index is invalid.', { ...context(request), location });
  return value as number;
}

function safeKey(value: unknown, location: ScriptLocation | undefined, request: ScriptInvocationRequest): string {
  if (typeof value !== 'string' || value.length > 128 || FORBIDDEN_KEYS.has(value) || value.includes('\0')) scriptRuntimeFail('E_SCRIPT_PROTOCOL', 'Unsafe table key.', { ...context(request), location });
  return value;
}

function unary(operator: string, value: VmValue, location: ScriptLocation | undefined, request: ScriptInvocationRequest): VmValue {
  switch (operator) {
    case 'negate': return -expectNumber(value, location, request);
    case 'not': return !truthy(value);
    case 'length':
      if (typeof value === 'string') return utf8Bytes(value);
      if (isList(value)) return value.values.length;
      if (isTable(value)) return value.values.size;
      return scriptRuntimeFail('E_SCRIPT_RUNTIME_ERROR', 'Length requires string, list, or table.', { ...context(request), location });
    default: return scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Unknown unary operator ${operator}.`, { ...context(request), location });
  }
}

function binary(operator: string, left: VmValue, right: VmValue, location: ScriptLocation | undefined, request: ScriptInvocationRequest): VmValue {
  switch (operator) {
    case 'add': return normalizeNumber(expectNumber(left, location, request) + expectNumber(right, location, request));
    case 'subtract': return normalizeNumber(expectNumber(left, location, request) - expectNumber(right, location, request));
    case 'multiply': return normalizeNumber(expectNumber(left, location, request) * expectNumber(right, location, request));
    case 'divide': return normalizeNumber(expectNumber(left, location, request) / expectNumber(right, location, request));
    case 'modulo': return normalizeNumber(expectNumber(left, location, request) % expectNumber(right, location, request));
    case 'power': return normalizeNumber(expectNumber(left, location, request) ** expectNumber(right, location, request));
    case 'equal': return left === right;
    case 'not-equal': return left !== right;
    case 'less': return comparable(left, location, request) < comparable(right, location, request);
    case 'less-equal': return comparable(left, location, request) <= comparable(right, location, request);
    case 'greater': return comparable(left, location, request) > comparable(right, location, request);
    case 'greater-equal': return comparable(left, location, request) >= comparable(right, location, request);
    case 'and': return truthy(left) ? right : left;
    case 'or': return truthy(left) ? left : right;
    case 'concat': return `${scalarString(left, location, request)}${scalarString(right, location, request)}`;
    default: return scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Unknown binary operator ${operator}.`, { ...context(request), location });
  }
}

function getPath(root: VmValue, path: readonly string[]): VmValue {
  let value = root;
  for (const entry of path) {
    if (!isTable(value)) return null;
    value = value.values.get(entry) ?? null;
  }
  return value;
}

function getValue(target: VmValue, keyValue: VmValue, location: ScriptLocation | undefined, request: ScriptInvocationRequest): VmValue {
  if (isList(target)) {
    const index = expectNumber(keyValue, location, request);
    return Number.isInteger(index) ? target.values[index] ?? null : null;
  }
  if (isTable(target)) return target.values.get(scalarString(keyValue, location, request)) ?? null;
  return scriptRuntimeFail('E_SCRIPT_RUNTIME_ERROR', 'Index target must be a list or table.', { ...context(request), location });
}

function setValue(
  target: VmValue,
  keyValue: VmValue,
  value: VmValue,
  location: ScriptLocation | undefined,
  request: ScriptInvocationRequest,
  allocate: (bytes: number) => void,
): void {
  if (isList(target)) {
    if (!target.owned) scriptRuntimeFail('E_SCRIPT_CAPABILITY_DENIED', 'Input snapshots are immutable.', { ...context(request), location });
    const index = expectNumber(keyValue, location, request);
    if (!Number.isSafeInteger(index) || index < 0 || index >= target.values.length) scriptRuntimeFail('E_SCRIPT_RUNTIME_ERROR', 'List write is out of range.', { ...context(request), location });
    target.values[index] = value; return;
  }
  if (isTable(target)) {
    if (!target.owned) scriptRuntimeFail('E_SCRIPT_CAPABILITY_DENIED', 'Input snapshots are immutable.', { ...context(request), location });
    const entryKey = safeKey(scalarString(keyValue, location, request), location, request);
    if (!target.values.has(entryKey)) allocate(utf8Bytes(entryKey) + 16);
    target.values.set(entryKey, value); return;
  }
  scriptRuntimeFail('E_SCRIPT_RUNTIME_ERROR', 'Write target must be a local list or table.', { ...context(request), location });
}

function expectNumber(value: VmValue, location: ScriptLocation | undefined, request: ScriptInvocationRequest): number {
  if (typeof value !== 'number') scriptRuntimeFail('E_SCRIPT_RUNTIME_ERROR', 'Numeric operation requires numbers.', { ...context(request), location });
  return value;
}

function comparable(value: VmValue, location: ScriptLocation | undefined, request: ScriptInvocationRequest): number | string {
  if (typeof value !== 'number' && typeof value !== 'string') scriptRuntimeFail('E_SCRIPT_RUNTIME_ERROR', 'Comparison requires matching number or string scalars.', { ...context(request), location });
  return value;
}

function scalarString(value: VmValue, location: ScriptLocation | undefined, request: ScriptInvocationRequest): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'nil';
  return scriptRuntimeFail('E_SCRIPT_RUNTIME_ERROR', 'String conversion requires scalar value.', { ...context(request), location });
}

function truthy(value: VmValue): boolean { return value !== null && value !== false; }
function normalizeNumber(value: number): number { return Object.is(value, -0) ? 0 : Number.isNaN(value) ? Number.NaN : value; }
function isList(value: VmValue): value is VmList { return typeof value === 'object' && value !== null && value.kind === 'list'; }
function isTable(value: VmValue): value is VmTable { return typeof value === 'object' && value !== null && value.kind === 'table'; }

function isHandle(value: object): value is ScriptCapabilityHandle {
  const candidate = value as Partial<ScriptCapabilityHandle>;
  return typeof candidate.kind === 'string' && typeof candidate.id === 'string' && Number.isSafeInteger(candidate.generation)
    && typeof candidate.token === 'string' && /^[0-9a-f]{64}$/.test(candidate.token) && Array.isArray(candidate.permissions);
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> { return typeof (value as Promise<T>)?.then === 'function'; }

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function deepFreezeWire<T extends ScriptWireValue>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const entry of Object.values(value as Readonly<Record<string, ScriptWireValue>>)) deepFreezeWire(entry, seen);
  return Object.freeze(value);
}

function assertPlainWireGraph(
  value: unknown,
  path: string,
  maxDepth: number,
  depth: number,
  active: Set<object>,
  visited: Set<object>,
): void {
  if (depth > maxDepth) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Host value nesting exceeded at ${path}.`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Host value must be finite at ${path}.`);
    return;
  }
  if (typeof value !== 'object') scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Host value is not portable data at ${path}.`);
  const objectValue = value as object;
  if (active.has(objectValue)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Cyclic host value at ${path}.`);
  if (visited.has(objectValue)) return;
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(objectValue);
  if ((isArray && prototype !== Array.prototype) || (!isArray && prototype !== Object.prototype && prototype !== null)) {
    scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Host object prototype is forbidden at ${path}.`);
  }
  active.add(objectValue);
  if (isArray) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Sparse host array is forbidden at ${path}[${index}].`);
    }
  }
  for (const propertyKey of Reflect.ownKeys(objectValue)) {
    if (typeof propertyKey !== 'string') scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Symbol host key is forbidden at ${path}.`);
    if (isArray && propertyKey === 'length') continue;
    if (isArray && !/^(?:0|[1-9][0-9]*)$/.test(propertyKey)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Named host array property is forbidden at ${path}.${propertyKey}.`);
    if (!isArray && FORBIDDEN_KEYS.has(propertyKey)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Unsafe host key at ${path}.${propertyKey}.`);
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, propertyKey);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Host accessors and hidden data are forbidden at ${path}.${propertyKey}.`);
    }
    assertPlainWireGraph(descriptor.value, isArray ? `${path}[${propertyKey}]` : `${path}.${propertyKey}`, maxDepth, depth + 1, active, visited);
  }
  active.delete(objectValue);
  visited.add(objectValue);
}

function exactRuntimeKeys(value: Record<string, unknown>, path: string, allowed: readonly string[], optional = false): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Unknown field ${path}.${key}.`);
  if (!optional) for (const key of allowed) if (!Object.hasOwn(value, key)) scriptRuntimeFail('E_SCRIPT_PROTOCOL', `Missing field ${path}.${key}.`);
}

class Xoshiro128 {
  private readonly state: Uint32Array;
  constructor(seed: readonly [number, number, number, number]) {
    this.state = new Uint32Array(seed.map(value => value >>> 0));
    if (this.state.every(value => value === 0)) this.state[0] = 0x9e3779b9;
  }
  next(): number {
    const s = this.state;
    const result = Math.imul(rotl(Math.imul(s[1]!, 5), 7), 9) >>> 0;
    const t = (s[1]! << 9) >>> 0;
    s[2] = (s[2]! ^ s[0]!) >>> 0; s[3] = (s[3]! ^ s[1]!) >>> 0; s[1] = (s[1]! ^ s[2]!) >>> 0; s[0] = (s[0]! ^ s[3]!) >>> 0;
    s[2] = (s[2]! ^ t) >>> 0; s[3] = rotl(s[3]!, 11);
    return result / 0x1_0000_0000;
  }
}

function rotl(value: number, shift: number): number { return ((value << shift) | (value >>> (32 - shift))) >>> 0; }
