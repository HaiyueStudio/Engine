import {parseHyaDataBinding,parseHyaSemantics} from '@haiyue/animation-spec/hya-production';
import {createProductionData} from './animation/production/createProductionData.js';
import {createProductionSemantics} from './animation/production/createProductionSemantics.js';
import {ProductionFrameError} from './animation/production/FrameTransaction.js';
import type {HyaCompositionValue, HyaDataBindingDocument, HyaSemanticsDocument} from '@haiyue/animation-spec/hya-production';
import type {HyaResourcePort} from '@haiyue/extensions/hya-player';
export interface HyaDataTransaction {
  readonly id: number;
  set(instance: string | Readonly<{part: string; id: string}>, path: readonly (string | number)[], value: HyaCompositionValue): void;
  setBinding(binding: string | Readonly<{part: string; id: string}>, value: HyaCompositionValue): void;
  trigger(instance: string | Readonly<{part: string; id: string}>, path: readonly (string | number)[]): void;
  insert(instance: string | Readonly<{part: string; id: string}>, path: readonly (string | number)[], index: number, value: HyaCompositionValue): void;
  remove(instance: string | Readonly<{part: string; id: string}> | Readonly<{part: string; id: string}>, path: readonly (string | number)[], index: number): void;
  move(instance: string | Readonly<{part: string; id: string}>, path: readonly (string | number)[], from: number, to: number): void;
  group(id: string | Readonly<{part: string; id: string}>, instance: string | Readonly<{part: string; id: string}>): void;
}
export interface HyaDataChange {
  readonly part: string; readonly sequence: number; readonly transaction: number; readonly instance: string; readonly path: readonly (string | number)[];
  readonly kind: 'set' | 'trigger' | 'list-insert' | 'list-remove' | 'list-move' | 'rebind';
  readonly previous?: HyaCompositionValue; readonly value?: HyaCompositionValue;
}
export interface HyaDataSubscription {unsubscribe(): void;}
export interface HyaData {
  read(instance: string | Readonly<{part: string; id: string}>, path: readonly (string | number)[]): HyaCompositionValue;
  readBinding(binding: string | Readonly<{part: string; id: string}>): HyaCompositionValue;
  run(transaction: (write: HyaDataTransaction) => void): number;
  advance(deltaSeconds?: number): readonly HyaDataChange[];
  subscribe(callback: (changes: readonly HyaDataChange[]) => void): HyaDataSubscription;
  rebind(component: string | Readonly<{part: string; id: string}>, instance: string | Readonly<{part: string; id: string}>): void;
  replaceResource(slot: string, kind: 'image' | 'artboard' | 'font' | 'blob', id: string): Promise<void>;
  dispose(): void;
}
export interface HyaSemanticSnapshot {
  readonly revision: number;
  readonly nodes: readonly Readonly<{id: string; target: string; role: string; label?: string; value?: string | number; hint?: string; bounds: readonly [number, number, number, number]; state: Readonly<Record<string, boolean>>; actions: readonly ('tap' | 'increase' | 'decrease' | 'focus')[]}>[];
  readonly readingOrder: readonly string[]; readonly navigationOrder: readonly string[];
  readonly announcements: readonly Readonly<{node: string; mode: 'polite' | 'assertive'; text: string}>[];
}
export interface HyaSemanticHost {
  update(snapshot: HyaSemanticSnapshot): void;
  subscribeActions(listener: (node: string, action: 'tap' | 'increase' | 'decrease' | 'focus') => void): HyaDataSubscription;
}
export interface HyaSemantics {
  update(frame: Readonly<{revision: number; geometry: Readonly<Record<string, readonly [number, number, number, number]>>; focused?: string}>): HyaSemanticSnapshot;
  readonly snapshot: HyaSemanticSnapshot | null;
  dispose(): void;
}
export function createHyaData(document: HyaDataBindingDocument, options?: Readonly<{signal?: AbortSignal; resources?: HyaResourcePort; resourceCatalogue?: readonly Readonly<{kind: 'image' | 'artboard' | 'font' | 'blob'; id: string; integrity: string}>[]; converter?: Readonly<{protocols: ReadonlySet<string>; begin(transaction: number): void; invoke(request: Readonly<{protocol: string; port: string; value: HyaCompositionValue; arguments: Readonly<Record<string, HyaCompositionValue>>}>): HyaCompositionValue; commit(transaction: number): void; rollback(transaction: number): void}>}>): HyaData {
  const parsed = parseHyaDataBinding(document);
  const catalogue = new Map<string, Readonly<{kind: 'image' | 'artboard' | 'font' | 'blob'; id: string; integrity: string}>>();
  if (options?.resourceCatalogue !== undefined) {
    if (!Array.isArray(options.resourceCatalogue) || options.resourceCatalogue.length > 100_000) throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.data.resourceCatalogue', 'resource catalogue exceeds the original entry ceiling');
    for (const entry of options.resourceCatalogue) {
      if (!entry || Object.keys(entry).some(k => !['kind','id','integrity'].includes(k)) || !['image','artboard','font','blob'].includes(entry.kind) || typeof entry.id !== 'string' || !entry.id || typeof entry.integrity !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(entry.integrity)) throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE', '$.data.resourceCatalogue', 'expected declared kind, ID and SHA-256 integrity');
      const key=JSON.stringify([entry.kind,entry.id]);if(catalogue.has(key))throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE', '$.data.resourceCatalogue', 'duplicate resource catalogue identity');
      catalogue.set(key,Object.freeze({...entry}));
    }
  }
  if(options?.resources && typeof options.resources.acquire !== 'function')throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT', '$.data.resources', 'resource acquisition port is required');
  const host=options?.resources;
  const resources=host && {async acquire(kind:'image'|'artboard'|'font'|'blob',id:string,signal:AbortSignal){
    const entry=catalogue.get(JSON.stringify([kind,id]));if(!entry)throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE', '$.data.resourceCatalogue', 'resource is absent from the explicit SHA catalogue');
    const handle=await host.acquire({kind,asset:id,part:'',integrity:entry.integrity,signal});
    try{if(!handle||typeof handle.release!=='function'||!Number.isSafeInteger(handle.generation)||handle.generation<0||!Number.isSafeInteger(handle.bytes)||handle.bytes<0)throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT', '$.data.resources.acquire', 'resource handle must report generation, bytes and release');
      return Object.freeze({value:handle.value,release:()=>handle.release()});
    }catch(error){if(handle&&typeof handle.release==='function'){try{handle.release()}catch(cleanup){throw new AggregateError([error,cleanup],'Invalid data resource and release failed')}}throw error}
  }};
  return createProductionData(parsed,{...(options?.signal?{signal:options.signal}:{}),...(options?.converter?{converter:options.converter}:{}),...(resources?{resources}:{})});
}

export function createHyaSemantics(document: HyaSemanticsDocument, options: Readonly<{bindings: Pick<HyaData, 'readBinding'>; host?: HyaSemanticHost; action(target: string, action: 'tap' | 'increase' | 'decrease' | 'focus'): void}>): HyaSemantics {
  const parsed=parseHyaSemantics(document);
  return createProductionSemantics({...parsed,nodes:parsed.nodes.map(({state,capabilities,...node})=>({...node,...(state?{state:{...state}}:{}),...(capabilities?{capabilities:{...capabilities}}:{})})),reducedMotion:{...parsed.reducedMotion}},options);
}
