import {ProductionDataOwner, type ProductionDataWrite} from './DataOwner.js';
import {ProductionFrameTransaction, ProductionFrameError, type ProductionFrameStage} from './FrameTransaction.js';
import {ProductionResourcePending} from './ResourceStage.js';
import {DataResourceOwner} from '../interaction/DataResourceOwner.js';
import type {RuntimeDataDocument, RuntimePath, RuntimeValue, CustomConverterPort, DataChange, DataObservationBatch, DataResourcePort} from '../interaction/runtime-types.js';

type Reference = string | Readonly<{part: string; id: string}>;
type Kind = Parameters<DataResourcePort['acquire']>[0];
type Change = Omit<DataChange, 'transactionId' | 'previous' | 'value'> & {readonly part: ''; readonly transaction: number; readonly previous?: RuntimeValue; readonly value?: RuntimeValue};
interface Write extends Omit<ProductionDataWrite, 'set' | 'setBinding' | 'trigger' | 'insert' | 'remove' | 'move' | 'group'> {
  set(instance: Reference, path: RuntimePath, value: RuntimeValue): void;
  setBinding(binding: Reference, value: RuntimeValue): void;
  trigger(instance: Reference, path: RuntimePath): void;
  insert(instance: Reference, path: RuntimePath, index: number, value: RuntimeValue): void;
  remove(instance: Reference, path: RuntimePath, index: number): void;
  move(instance: Reference, path: RuntimePath, from: number, to: number): void;
  group(group: Reference, instance: Reference): void;
}
interface Pending {ready: Promise<void>; state: 'pending' | 'ready' | 'failed'; error?: unknown;}
function fail(code: string, path: string, message: string): never {throw new ProductionFrameError(code, path, message);}
function reference(value: Reference): string {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && value.part === '' && typeof value.id === 'string' && value.id
    && Object.keys(value).every(key => key === 'part' || key === 'id')) return value.id;
  return fail('E_HYA_RUNTIME_REFERENCE', '$.data.reference', 'standalone addresses use a local ID or the empty part namespace');
}
const changes = (items: readonly DataChange[]): readonly Change[] => Object.freeze(items.map(({transactionId, previous, value, ...item}) => Object.freeze({...item,
  part: '' as const, transaction: transactionId, ...(previous === undefined ? {} : {previous}), ...(value === undefined ? {} : {value})})));

/** Standalone facade over the original queued data, frame barrier and resource lease owner. */
export function createProductionData(document: RuntimeDataDocument, options: Readonly<{signal?: AbortSignal; converter?: CustomConverterPort; resources?: DataResourcePort}> = {}) {
  const signal = options.signal;
  if (signal?.aborted) fail('E_HYA_RUNTIME_ABORTED', '$.signal', 'data creation was cancelled');
  let disposed = false, sequence = 0, preparingResources = false;
  const issues: unknown[] = [], pending = new Map<string, Pending>(), slots = new Set<string>();
  const resources = options.resources && new DataResourceOwner(options.resources);
  const owner = new ProductionDataOwner(document, {...(options.converter ? {converter: options.converter} : {}), diagnostic: error => issues.push(error)});
  const live = (): void => {if (disposed) fail(signal?.aborted ? 'E_HYA_RUNTIME_ABORTED' : 'E_HYA_RUNTIME_DISPOSED', '$.data', 'data owner is disposed');};
  const resourceStage: ProductionFrameStage = {id: 'standalone-resources', phase: 'atomic-data', prepare() {
    live(); preparingResources = true;
    try {
      const selected = [...pending];
      const failed = selected.find(([, item]) => item.state === 'failed'); if (failed) throw failed[1].error;
      const waiting = selected.filter(([, item]) => item.state === 'pending');
      if (waiting.length) throw new ProductionResourcePending(Promise.all(waiting.map(([, item]) => item.ready)).then(() => {}));
      const step = resources?.prepareStaged(selected.map(([slot]) => slot));
      return {commit() {step?.commit(); for (const [slot, item] of selected) if (pending.get(slot) === item) pending.delete(slot); preparingResources = false;},
        rollback() {step?.rollback(); preparingResources = false;}, publish() {for (const error of step?.publish() ?? []) issues.push(error);}};
    } catch (error) {preparingResources = false; throw error;}
  }};
  const frame = new ProductionFrameTransaction([...owner.stages('standalone-data'), resourceStage], error => issues.push(error));
  const dispose = (): void => {
    if (disposed) return;
    disposed = true; signal?.removeEventListener('abort', dispose); pending.clear(); slots.clear();
    try {frame.dispose();} finally {try {owner.dispose();} finally {resources?.dispose();}}
  };
  signal?.addEventListener('abort', dispose, {once: true});
  if (signal?.aborted) {dispose(); live();}
  return Object.freeze({
    read(instance: Reference, path: RuntimePath) {live(); return owner.read(reference(instance), path);},
    readBinding(binding: Reference) {live(); return owner.readBinding(reference(binding));},
    run(callback: (write: Write) => void): number {
      live(); if (typeof callback !== 'function') fail('E_HYA_RUNTIME_DATA', '$.data.run', 'transaction callback is required');
      return owner.run(write => callback(Object.freeze({id: write.id,
        set: (id: Reference, path: RuntimePath, value: RuntimeValue) => write.set(reference(id), path, value),
        setBinding: (id: Reference, value: RuntimeValue) => write.setBinding(reference(id), value),
        trigger: (id: Reference, path: RuntimePath) => write.trigger(reference(id), path),
        insert: (id: Reference, path: RuntimePath, index: number, value: RuntimeValue) => write.insert(reference(id), path, index, value),
        remove: (id: Reference, path: RuntimePath, index: number) => write.remove(reference(id), path, index),
        move: (id: Reference, path: RuntimePath, from: number, to: number) => write.move(reference(id), path, from, to),
        group: (group: Reference, instance: Reference) => write.group(reference(group), reference(instance)),
      })));
    },
    advance(deltaSeconds = 0): readonly Change[] {
      live(); if (frame.stats.running) fail('E_HYA_RUNTIME_REENTRANT', '$.data.advance', 'data frame is already active');
      if (!Number.isSafeInteger(sequence + 1)) fail('E_HYA_RUNTIME_LIMIT', '$.data.advance', 'data frame sequence is exhausted');
      issues.length = 0;
      const receipt = frame.advance({sequence: sequence + 1, deltaSeconds, viewport: [0, 0], dpr: 1}); sequence++;
      const batch = receipt.values['standalone-data'] as DataObservationBatch, value = changes(batch.changes);
      if (issues.length) {
        const error = new AggregateError([...issues], 'Data frame committed; rejected intents or borrowed publication callbacks reported errors');
        Object.defineProperties(error, {code: {value: 'E_HYA_RUNTIME_DATA'}, committed: {value: true}, changes: {value}});
        throw error;
      }
      return value;
    },
    subscribe(callback: (items: readonly Change[]) => void) {
      live(); if (typeof callback !== 'function') fail('E_HYA_RUNTIME_DATA', '$.data.subscribe', 'observer is required');
      return owner.subscribe(items => callback(changes(items)));
    },
    rebind(component: Reference, instance: Reference) {live(); owner.rebind(reference(component), reference(instance));},
    async replaceResource(slot: string, kind: Kind, id: string): Promise<void> {
      live();
      if (owner.stats.preparing || preparingResources) fail('E_HYA_RUNTIME_REENTRANT', '$.data.resources', 'resource changes cannot reenter a prepared frame');
      if (!resources) fail('E_HYA_RUNTIME_HOST_PORT', '$.data.resources', 'an explicit resource catalogue/port is required');
      if (typeof slot !== 'string' || !slot || typeof id !== 'string' || !id || !['image', 'artboard', 'font', 'blob'].includes(kind)) fail('E_HYA_RUNTIME_REFERENCE', '$.data.resources', 'invalid resource slot, kind or identity');
      if (!slots.has(slot) && slots.size >= 100_000) fail('E_HYA_RUNTIME_LIMIT', '$.data.resources', 'resource slots exceed the original 100000 entry ceiling');
      slots.add(slot); pending.delete(slot);
      let ready: Promise<unknown>; try {ready = resources.stage(slot, kind, id);} catch (error) {return Promise.reject(error);}
      const item: Pending = {ready: Promise.resolve(), state: 'pending'}; pending.set(slot, item);
      item.ready = ready.then(() => {live(); if (pending.get(slot) !== item) fail('E_HYA_RUNTIME_ABORTED', '$.data.resources', 'resource candidate was superseded'); item.state = 'ready';}, error => {if (pending.get(slot) === item) {item.state = 'failed'; item.error = error;} throw error;});
      return item.ready;
    },
    dispose,
  });
}
