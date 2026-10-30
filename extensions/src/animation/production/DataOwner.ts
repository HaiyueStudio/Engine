import {DataBindingRuntime, type StatefulDataComponentBinding} from '../interaction/DataBindingRuntime.js';
import type {CustomConverterPort, DataChange, DataObservationBatch, DataSubscription, RuntimeDataDocument, RuntimePath, RuntimeValue} from '../interaction/runtime-types.js';
import {snapshotPlainTextData} from '../text/PlainTextData.js';
import {ProductionFrameError, type ProductionFrameStage} from './FrameTransaction.js';
import {ProductionTransactionPort} from './TransactionPort.js';

export type ProductionDataCommand = Readonly<{op: 'set' | 'trigger' | 'insert' | 'remove' | 'move'; instance: string; path: RuntimePath; value?: RuntimeValue; index?: number; from?: number; to?: number}>
  | Readonly<{op: 'binding'; binding: string; value: RuntimeValue; context?:readonly string[]}>
  | Readonly<{op: 'group'; group: string; instance: string}>
  | Readonly<{op: 'rebind'; component: string; instance: string}>;
type Command = ProductionDataCommand;
export interface ProductionDataWrite {
  readonly id: number;
  set(instance: string, path: RuntimePath, value: RuntimeValue): void;
  setBinding(binding: string, value: RuntimeValue): void;
  trigger(instance: string, path: RuntimePath): void;
  insert(instance: string, path: RuntimePath, index: number, value: RuntimeValue): void;
  remove(instance: string, path: RuntimePath, index: number): void;
  move(instance: string, path: RuntimePath, from: number, to: number): void;
  group(group: string, instance: string): void;
}
interface Intent {readonly id: number; readonly commands: readonly Command[]; readonly bytes: number; readonly nodes: number;}
interface FrameState {
  readonly token: object; readonly bindings: Map<string, StatefulDataComponentBinding>; readonly cache: Map<string, RuntimeValue>;
  readonly input: Intent[]; batch?: DataObservationBatch; selected?: readonly Intent[];
  readonly nextCache: Map<string, RuntimeValue>; readonly rejected: {intent: number; error: unknown}[];
  revision?: number; rebound?: boolean;
  delta?: number;
}
export interface ProductionDataOptions {
  readonly converter?: CustomConverterPort;
  readonly diagnostic?: (error: unknown, transaction?: number) => void;
  readonly invalidate?: () => void;
  readonly replaceResource?: (slot: string, kind: 'image' | 'artboard' | 'font' | 'blob', id: string) => Promise<void>;
}

/** Queued public data commands over the original runtime, with no secondary binding/converter implementation. */
export class ProductionDataOwner {
  private readonly runtime: DataBindingRuntime;
  private readonly converter: ProductionTransactionPort<Parameters<CustomConverterPort['invoke']>, RuntimeValue> | undefined;
  private readonly ownsConverter: boolean;
  private readonly queue: Intent[] = [];
  private queuedBytes = 0; private queuedNodes = 0; private sequence = 0;
  private readonly observers = new Set<(changes: readonly DataChange[]) => void>();
  private bindings = new Map<string, StatefulDataComponentBinding>();
  private cache = new Map<string, RuntimeValue>();
  private frame: FrameState | undefined;
  private collecting = false; private disposed = false;
  private revision = 0;
  constructor(readonly document: RuntimeDataDocument, private readonly options: ProductionDataOptions = {}, converter?: ProductionTransactionPort<Parameters<CustomConverterPort['invoke']>, RuntimeValue>) {
    this.options = Object.freeze({...options});
    this.ownsConverter = converter === undefined;
    this.converter = converter ?? (options.converter && new ProductionTransactionPort(options.converter));
    this.runtime = new DataBindingRuntime(document, {frameConverters: true, ...(this.converter ? {converterPort: this.converter.createPort()} : {})});
  }
  read(instance: string, path: RuntimePath): RuntimeValue {this.publicIdle(); return plain(this.runtime.read(instance, path));}
  readBinding(binding: string,context:readonly string[]=[]): RuntimeValue {
    this.publicIdle(); const key = JSON.stringify([binding, this.runtime.bindingInstance(binding,context)]);
    if (this.cache.has(key)) return this.cache.get(key)!;
    const token = this.runtime.captureFrame();
    let transaction: ReturnType<ProductionFrameStage['prepare']> | undefined;
    try {
      transaction = this.converter?.stage('read-converter').prepare({request: {sequence: 0, deltaSeconds: 0, viewport: [0, 0], dpr: 1}, values: new Map()});
      const value = plain(this.runtime.readBinding(binding,context)); this.live(); transaction?.commit(); transaction?.finalize?.();
      this.runtime.releaseFrame(token); this.cache.set(key, value); transaction?.publish?.(); this.live(); return value;
    } catch (error) {
      // Host commit is contractually infallible; a violating publisher cannot be replayed.
      try {transaction?.rollback();} finally {try {this.runtime.restoreFrame(token);} catch {/* A completed read checkpoint is already committed. */}}
      throw error;
    }
  }
  run(callback: (write: ProductionDataWrite) => void): number {
    this.publicIdle(); if (this.collecting) fail('E_HYA_RUNTIME_REENTRANT', '$.data.run', 'nested command collection is not allowed');
    if (typeof callback !== 'function') fail('E_HYA_RUNTIME_DATA', '$.data.run', 'transaction callback is required');
    const commands: Command[] = [], id = this.nextId(); let active = true, bytes = 2, nodes = 1; this.collecting = true;
    const add = (command: Command): void => {
      this.live(); if (!active) fail('E_HYA_RUNTIME_TRANSACTION', '$.data.write', 'transaction writer has expired');
      const copy = plain(command) as Command, cost = measure(copy); bytes += cost.bytes + (commands.length ? 1 : 0); nodes += cost.nodes;
      this.capacity({id, commands: [], bytes, nodes}); commands.push(copy);
    };
    try {
      callback(Object.freeze({id,
        set: (instance: string, path: RuntimePath, value: RuntimeValue) => add({op: 'set', instance, path, value}),
        setBinding: (binding: string, value: RuntimeValue) => add({op: 'binding', binding, value}),
        trigger: (instance: string, path: RuntimePath) => add({op: 'trigger', instance, path}),
        insert: (instance: string, path: RuntimePath, index: number, value: RuntimeValue) => add({op: 'insert', instance, path, index, value}),
        remove: (instance: string, path: RuntimePath, index: number) => add({op: 'remove', instance, path, index}),
        move: (instance: string, path: RuntimePath, from: number, to: number) => add({op: 'move', instance, path, from, to}),
        group: (group: string, instance: string) => add({op: 'group', group, instance}),
      }));
      if (commands.length) this.enqueue(this.intent(id, commands)); return id;
    } finally {active = false; this.collecting = false;}
  }
  rebind(component: string, instance: string): void {this.publicIdle(); if (this.collecting) fail('E_HYA_RUNTIME_REENTRANT', '$.data.rebind', 'component rebinding cannot escape a collected transaction'); this.enqueue(this.intent(this.nextId(), [{op: 'rebind', component, instance}]));}
  replaceResource(slot: string, kind: 'image' | 'artboard' | 'font' | 'blob', id: string): Promise<void> {
    this.publicIdle(); if (!this.options.replaceResource) fail('E_HYA_RUNTIME_HOST_PORT', '$.data.resources', 'a composition asset catalogue/resource owner is required');
    return this.options.replaceResource(slot, kind, id);
  }
  subscribe(callback: (changes: readonly DataChange[]) => void): DataSubscription {
    this.publicIdle(); if (typeof callback !== 'function') fail('E_HYA_RUNTIME_DATA', '$.data.subscribe', 'observer must be callable');
    if (this.observers.size >= 1_000_000) fail('E_HYA_RUNTIME_LIMIT', '$.data.observers', 'original observer ceiling exceeded');
    this.observers.add(callback); let active = true;
    return Object.freeze({unsubscribe: () => {if (!active) return; active = false; this.observers.delete(callback);}});
  }
  /** Private composition access, never exposed on the player's public data facade. */
  readPrepared(instance: string, path: RuntimePath): RuntimeValue {this.prepared(); return plain(this.runtime.read(instance, path));}
  readBindingPrepared(binding: string, context: readonly string[] = []): RuntimeValue {
    const frame = this.prepared(), key = JSON.stringify([binding, this.runtime.bindingInstance(binding, context)]);
    if (!frame.nextCache.has(key)) frame.nextCache.set(key, plain(this.runtime.readBindingFrame(binding, context, frame.delta!)));
    return frame.nextCache.get(key)!;
  }
  bindingInstance(binding:string,context:readonly string[]=[]):string {this.live();return this.runtime.bindingInstance(binding,context);}
  bindingHasModelItems(binding: string, context: readonly string[] = []): boolean {this.prepared(); return this.runtime.bindingHasModelItems(binding, context);}
  componentInstance(component: string): string | undefined {this.live(); return this.bindings.get(component)?.instance;}
  get bindingRevision(): number {return this.prepared().revision!;}
  /** Routed GUI actions enqueue into the current input phase and disappear with a failed frame. */
  input(commands: readonly Command[]): void {
    this.live(); if (!this.frame || this.frame.batch) fail('E_HYA_RUNTIME_STAGE', '$.data.input', 'routed commands require the input phase');
    const intent = this.intent(this.nextId(), commands); this.capacity(intent, this.frame.input);
    this.frame.input.push(intent);
  }
  stages(id: string): readonly ProductionFrameStage[] {
    const port = this.converter && this.ownsConverter ? [this.converter.stage(id + ':converter')] : [];
    return Object.freeze([...port, {id: id + ':checkpoint', phase: 'input-queue', prepare: () => {
      this.live(); if (this.frame || this.collecting) fail('E_HYA_RUNTIME_REENTRANT', '$.data', 'data owner is not idle');
      const frame: FrameState = {token: this.runtime.captureFrame(), bindings: new Map(this.bindings), cache: this.cache, input: [], nextCache: new Map(), rejected: []};
      this.frame = frame;
      return {commit: () => this.runtime.releaseFrame(frame.token), rollback: () => this.rollback(frame)};
    }, dispose: () => {if (this.frame) this.rollback(this.frame);}},
    {id, phase: 'atomic-data', prepare: context => {
      const frame = this.frame; if (!frame) fail('E_HYA_RUNTIME_STAGE', '$.data', 'data checkpoint is absent');
      frame.selected = Object.freeze([...this.queue]);
      for (const intent of [...frame.selected, ...frame.input]) {
        try {this.apply(intent); if (intent.commands.some(command => command.op === 'rebind')) frame.rebound = true;} catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || !['E_DATA_RUNTIME_PATH', 'E_DATA_RUNTIME_TYPE', 'E_DATA_RUNTIME_LIMIT'].includes(String(error.code))) throw error;
          frame.rejected.push({intent: intent.id, error});
        }
      }
      const moving = this.runtime.hasActiveInterpolation;
      const batch = this.runtime.advance(context.request.deltaSeconds, 'prepare'); frame.batch = batch;
      frame.delta = context.request.deltaSeconds;
      for (const [key] of frame.cache) {
        const [binding, instance] = JSON.parse(key) as [string, string];
        frame.nextCache.set(key, plain(this.runtime.readBindingFrame(binding, [instance], frame.delta)));
      }
      frame.revision = this.revision + (batch.changes.length || frame.rebound || moving ? 1 : 0);
      return {value: batch, commit: () => {
        this.live();
        this.queue.splice(0, frame.selected!.length);
        for (const intent of frame.selected!) {this.queuedBytes -= intent.bytes; this.queuedNodes -= intent.nodes;}
        this.cache = new Map(frame.nextCache); this.revision = frame.revision!; this.frame = undefined;
      }, rollback() {}, publish: () => {
        this.runtime.publishPreparedAdvance(batch);
        // Raw trigger values are consumed, while stateful converted values remain this frame's snapshot.
        for (const [key] of this.cache) {const [binding] = JSON.parse(key) as [string]; if (!this.document.bindings.find(value => value.id === binding)?.converter) this.cache.delete(key);}
        for (const rejected of frame.rejected) this.report(rejected.error, rejected.intent);
        const changes = Object.freeze(batch.changes.map(({previous, value, ...change}) => Object.freeze({...change,
          ...(previous === undefined ? {} : {previous: plain(previous)}), ...(value === undefined ? {} : {value: plain(value)})}))) as readonly DataChange[];
        for (const observer of [...this.observers]) {
          if (this.disposed || !this.observers.has(observer)) continue;
          try {if (changes.length) observer(changes);} catch (error) {this.report(error);}
        }
      }};
    }}]);
  }
  get stats(): Readonly<{pending: number; bytes: number; nodes: number; preparing: boolean; disposed: boolean}> {
    return Object.freeze({pending: this.queue.length, bytes: this.queuedBytes, nodes: this.queuedNodes, preparing: !!this.frame, disposed: this.disposed});
  }
  dispose(): void {
    if (this.disposed) return;
    if (this.frame) this.rollback(this.frame);
    this.disposed = true; this.queue.length = 0; this.queuedBytes = this.queuedNodes = 0; this.observers.clear(); this.cache.clear(); this.bindings.clear();
    try {this.runtime.dispose();} finally {if (this.ownsConverter) this.converter?.dispose();}
  }
  private apply(intent: Intent): void {
    this.prepareCommands(intent.commands).commit();
  }
  /** One original runtime transaction may participate in a cross-part data intent. */
  prepareCommands(commands: readonly ProductionDataCommand[]): Readonly<{transaction: number; commit(): void; rollback(): void}> {
    this.live(); if (!this.frame || this.frame.batch) fail('E_HYA_RUNTIME_STAGE', '$.data', 'cross-part commands require the atomic-data phase');
    const expanded = commands.reduce((count, command) => count + (command.op === 'group' ? this.document.propertyGroups.find(group => group.id === command.group)?.operations.length ?? 1 : 1), 0);
    if (expanded + this.runtime.stats.pendingChanges > 1_000_000) fail('E_DATA_RUNTIME_LIMIT', '$.data.commands', 'expanded data mutations exceed the original composition node ceiling');
    const previous = new Map([...this.bindings].map(([id, binding]) => [id, {binding, instance: binding.instance}]));
    const transaction = this.runtime.beginTransaction();
    let active = true;
    const rollback = (): void => {
      if (!active) return; active = false; this.runtime.rollback(transaction);
      for (const [id, binding] of this.bindings) if (!previous.has(id)) binding.dispose();
      this.bindings = new Map([...previous].map(([id, value]) => {value.binding.rebind(value.instance); return [id, value.binding];}));
    };
    try {
      for (const command of commands) {
        if (command.op === 'binding') this.runtime.writeBinding(command.binding, command.value, transaction,command.context??[]);
        else if (command.op === 'group') this.runtime.applyGroup(command.group, command.instance, transaction);
        else if (command.op === 'rebind') {
          const binding = this.bindings.get(command.component);
          if (binding) binding.rebind(command.instance); else this.bindings.set(command.component, this.runtime.createComponentBinding(command.component, command.instance));
        } else if (command.op === 'set') this.runtime.set(command.instance, command.path, command.value!, transaction);
        else if (command.op === 'trigger') this.runtime.trigger(command.instance, command.path, transaction);
        else if (command.op === 'insert') this.runtime.listInsert(command.instance, command.path, command.index!, command.value!, transaction);
        else if (command.op === 'remove') this.runtime.listRemove(command.instance, command.path, command.index!, transaction);
        else this.runtime.listMove(command.instance, command.path, command.from!, command.to!, transaction);
      }
      return Object.freeze({transaction, commit: () => {
        if (!active) fail('E_HYA_RUNTIME_TRANSACTION', '$.data', 'data intent is no longer active');
        this.runtime.commit(transaction); active = false;
        if (commands.some(command => command.op === 'rebind')) this.frame!.rebound = true;
      }, rollback});
    } catch (error) {
      rollback(); throw error;
    }
  }
  private rollback(frame: FrameState): void {
    if (this.frame !== frame) return;
    this.frame = undefined; this.runtime.restoreFrame(frame.token); this.bindings = frame.bindings; this.cache = frame.cache;
  }
  private intent(id: number, value: readonly Command[]): Intent {
    const commands = plain(value) as unknown as readonly Command[];
    return Object.freeze({id, commands, ...measure(commands)});
  }
  private capacity(intent: Intent, additional: readonly Intent[] = []): void {
    if (this.queuedBytes + intent.bytes + additional.reduce((n, value) => n + value.bytes, 0) > 64 * 1024 * 1024
      || this.queuedNodes + intent.nodes + additional.reduce((n, value) => n + value.nodes, 0) > 1_000_000)
      fail('E_HYA_RUNTIME_LIMIT', '$.data.queue', 'queued intents exceed original composition JSON byte/node ceilings');
  }
  private enqueue(intent: Intent): void {this.live(); this.capacity(intent); this.queue.push(intent); this.queuedBytes += intent.bytes; this.queuedNodes += intent.nodes; try {this.options.invalidate?.();} catch (error) {this.report(error);}}
  private nextId(): number {if (!Number.isSafeInteger(this.sequence + 1)) fail('E_HYA_RUNTIME_LIMIT', '$.data.transaction', 'transaction sequence exhausted'); return ++this.sequence;}
  private prepared(): FrameState {this.live(); if (!this.frame?.batch) fail('E_HYA_RUNTIME_STAGE', '$.data', 'prepared binding reads require atomic-data completion'); return this.frame;}
  private publicIdle(): void {this.live(); if (this.frame) fail('E_HYA_RUNTIME_REENTRANT', '$.data', 'public data access is unavailable during frame preparation');}
  private live(): void {if (this.disposed) fail('E_HYA_RUNTIME_DISPOSED', '$.data', 'data owner is disposed');}
  private report(error: unknown, transaction?: number): void {try {this.options.diagnostic?.(error, transaction);} catch {/* Diagnostics cannot replay observers. */}}
}
function fail(code: string, path: string, message: string): never {throw new ProductionFrameError(code, path, message);}
function plain(value: unknown): RuntimeValue {return snapshotPlainTextData(value, '$.data', (path, message, limit) => fail(limit ? 'E_HYA_RUNTIME_LIMIT' : 'E_HYA_RUNTIME_DATA', path, message), {strict: true, maxBytes: 64 * 1024 * 1024}) as RuntimeValue;}
function measure(value: unknown): Readonly<{bytes: number; nodes: number}> {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let nodes = 0; const stack: unknown[] = [value];
  while (stack.length) {const value = stack.pop(); nodes++; if (value && typeof value === 'object') for (const child of Object.values(value)) stack.push(child);}
  return {bytes, nodes};
}
