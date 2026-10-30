import {textContent} from '../text/parameterized/TextContent.js';
import {compileGuiTextPlans,type GuiTextPlan} from './CompositionGuiTextPlan.js';
import {productionTextEditing} from '../text/production/ProductionTextEditing.js';
import type {ProductionLayoutNode} from '../layout/production/types.js';
import {parseAnimation, type AnimationDocument, type ParsedAnimation} from '@haiyue/animation-spec';
import {ProductionCompositionAudioOwner, type CompositionAudioFrame} from './CompositionAudioOwner.js';
import {validateProductionAudioHost} from '../audio/ProductionAudioBackend.js';
import type {ProductionAudioCommand} from '../audio/ProductionAudioOwner.js';
import type {ProductionAudioHost} from '../audio/ProductionAudioHost.js';
import type {RuntimeAudioDocument, RuntimeClockSnapshot} from '../audio/runtime-types.js';
import {ProductionCompositionInputOwner, type CompositionInteractionEvent, type CompositionGuiInput, type CompositionGuiTarget} from './CompositionInputOwner.js';
import {ProductionCompositionSemanticsOwner, type CompositionSemanticSnapshot} from './CompositionSemanticsOwner.js';
import type {RuntimeInteractionDocument, RuntimeSemanticsDocument, RuntimeInteractionAction, RoutedInteractionEvent, InteractionGeometryPort, InteractionActionPort, SemanticHostBridge} from '../interaction/runtime-types.js';
import {ProductionCoreBindingPlan} from './CoreBindingPlan.js';
import type {ProductionCompositionCore, ProductionCompositionCoreFactory, PreparedCompositionCore} from './CoreCompositionVisual.js';
import type {RuntimeDataDocument, RuntimePath, RuntimeValue, DataSubscription, CustomConverterPort} from '../interaction/runtime-types.js';
import type {RuntimeLayoutDocument} from '../layout/parameterized/runtime-types.js';
import type {LayoutTextContext, PreparedLayoutNodeBindings} from '../layout/parameterized/LayoutEvaluator.js';
import {LayoutAssetOwner, type LayoutNetworkPolicy, type LayoutAssetResolver} from '../layout/parameterized/AssetOwner.js';
import {ProductionResourceStage, type ProductionResourceSelection} from './ResourceStage.js';
import {ProductionLayoutOwner} from '../layout/production/ProductionLayoutOwner.js';
import type {ProductionLayoutFrame} from '../layout/production/types.js';
import {ProductionTextOwner} from '../text/production/ProductionTextOwner.js';
import type {ProductionFontPort, ProductionTextRequest} from '../text/production/types.js';
import {snapshotPlainTextData} from '../text/PlainTextData.js';
import type {RuntimeDocument, StateMachinePose, SideEffectPort, ChannelOwnershipPort, DeterministicInvocationPort, NestedRuntimeFactory} from '../../hya-state-machine/v2/runtime-types.js';
import {ProductionDataOwner, type ProductionDataCommand, type ProductionDataOptions} from './DataOwner.js';
import {ProductionStateResourceOwnership} from './StateResourceOwnership.js';
import {ProductionStateController} from './StateController.js';
import {stateFrameStage} from './StateFrameStage.js';
import {ProductionTransactionPort} from './TransactionPort.js';
import {ProductionFrameTransaction, ProductionFrameError, checkpointFrameStage, snapshotProductionFrameRequest, snapshotProductionFrameTransport, type ProductionFrameTransport, type ProductionFrameRequest, type ProductionFrameStage, type PreparedProductionFrameStep} from './FrameTransaction.js';

export interface ProductionCompositionAssetOptions {
  readonly policy: LayoutNetworkPolicy; readonly resolver?: LayoutAssetResolver;
  readonly maxAssetBytes?: number; readonly maxTotalBytes?: number;
}
type Part = Readonly<{id: string; dependencies: readonly string[]}> & (
  Readonly<{kind: 'core'; document: AnimationDocument; materialize?: ProductionCompositionCoreFactory}>
  | Readonly<{kind: 'audio'; document: RuntimeAudioDocument; host: ProductionAudioHost; stateClock?: Readonly<{part: string; machine: string}>}>
  | Readonly<{kind: 'interaction'; document: RuntimeInteractionDocument; geometry?: InteractionGeometryPort; actions?: InteractionActionPort & {kinds: ReadonlySet<string>; protocols?: ReadonlySet<string>}}>
  | Readonly<{kind: 'semantics'; document: RuntimeSemanticsDocument; bridge?: SemanticHostBridge; bounds?: (target: string, layouts: Readonly<Record<string, ProductionLayoutFrame>>) => readonly [number, number, number, number] | undefined}>
  | Readonly<{kind: 'data'; document: RuntimeDataDocument; options?: ProductionDataOptions & {converter?: CustomConverterPort & {protocols: ReadonlySet<string>}}}>
  | Readonly<{kind: 'state'; document: RuntimeDocument; roots: readonly string[]; ownership?: ChannelOwnershipPort; conditions?: DeterministicInvocationPort & {protocols: ReadonlySet<string>}; nested?: NestedRuntimeFactory}>
  | Readonly<{kind: 'layout'; document: RuntimeLayoutDocument; assetOwner?: LayoutAssetOwner; fonts?: ProductionFontPort; assetOptions?: ProductionCompositionAssetOptions; contexts?: Readonly<Record<string, readonly string[]>>}>);
interface Target {readonly id: string; readonly part: string; readonly kind: 'state-input' | 'text-block' | 'layout-node' | 'asset' | 'animation-node' | 'interaction-target' | 'semantic-node' | 'audio-cue'; readonly address: readonly string[];}
/** Internal compiler output. Serialized input is still parsed/negotiated by the original format package. */
export interface ProductionCompositionDefinition {readonly parts: readonly Part[]; readonly targets: readonly Target[];}
type Reference = string | Readonly<{part: string; id: string}>;
type RoutedCommand = Readonly<{part: string; command: ProductionDataCommand}>;
interface Intent {readonly id: number; readonly commands: readonly RoutedCommand[]; readonly resource?: Readonly<{slot: string; id: string}>; readonly bytes: number; readonly nodes: number;}
export interface ProductionCompositionWrite {
  readonly id: number;
  set(instance: Reference, path: RuntimePath, value: RuntimeValue): void;
  setBinding(binding: Reference, value: RuntimeValue): void;
  trigger(instance: Reference, path: RuntimePath): void;
  insert(instance: Reference, path: RuntimePath, index: number, value: RuntimeValue): void;
  remove(instance: Reference, path: RuntimePath, index: number): void;
  move(instance: Reference, path: RuntimePath, from: number, to: number): void;
  group(group: Reference, instance: Reference): void;
}
export interface ProductionCompositionChange {
  readonly part: string; readonly sequence: number; readonly transaction: number; readonly instance: string;
  readonly path: RuntimePath; readonly kind: string; readonly previous?: RuntimeValue; readonly value?: RuntimeValue;
}
export interface ProductionCompositionFrame {
  readonly sequence: number; readonly time: number;
  readonly layouts: Readonly<Record<string, ProductionLayoutFrame>>;
  readonly states: Readonly<Record<string, readonly StateMachinePose[]>>;
  readonly effects: readonly Readonly<{part: string; machine: string; effect: Parameters<SideEffectPort['invoke']>[0]}>[];
  readonly audio: Readonly<Record<string, CompositionAudioFrame>>;
  readonly semantics: Readonly<Record<string, CompositionSemanticSnapshot>>;
  readonly input: Readonly<{focused: string | null; events: readonly CompositionInteractionEvent[]}>;
  readonly cores: Readonly<Record<string, Readonly<{revision: string}>>>;
  readonly changes: readonly ProductionCompositionChange[];
}
export interface ProductionCompositionHost {
  presentation?(frame:ProductionCompositionFrame,texts:readonly GuiTextModel[]):ProductionCompositionFrame;
  readonly guiText?:boolean;
  invalidate(reason: string): void;
  diagnostic?(error: unknown, transaction?: number): void;
  interactionEvents?(events: readonly CompositionInteractionEvent[]): void;
  events?(events: readonly Readonly<{part: string; machine: string; effect: Parameters<SideEffectPort['invoke']>[0]}>[]): void;
  /** Actual render integration supplies its prepared draw/resource transaction here; no diagnostic draw is synthesized. */
  draw?(frame: ProductionCompositionFrame, cores: ReadonlyMap<string, PreparedCompositionCore>): PreparedProductionFrameStep;
}
interface Link {readonly data: string; readonly binding: string; readonly target: Target; readonly path: readonly string[];}
export type GuiTextAddress=Readonly<{part:string;block:string;instance:string;node:string}>;
export type GuiTextView=Readonly<{value:string;selection?:readonly[number,number];cursor?:number;base?:string;source?:string;composing?:boolean;composition?:readonly[number,number];presentation?:Readonly<{scroll:readonly[number,number];caretVisible:boolean}>}>;
export interface GuiTextModel {readonly key:string;readonly address:GuiTextAddress;readonly plan:GuiTextPlan;readonly value:string;readonly source:string;readonly writers:readonly Readonly<{part:string;binding:string;model:string}>[];readonly base:ScopedText;readonly bytes:number;readonly view?:GuiTextView;readonly node:ProductionLayoutNode;readonly dpr:number;}
type ScopedText = Pick<ProductionTextRequest, 'strings' | 'selections' | 'cursors' | 'styles'>;
const lifecycle = {reset() {}, pause() {}, resume() {}, stop() {}, dispose() {}};

/** Owns the compiled data/state/text/layout graph and its cross-part transaction boundary. */
export class ProductionCompositionOwner {
  private readonly audioOwners = new Map<string, ProductionCompositionAudioOwner>();
  private readonly audioStateClocks = new Map<string, {part: string; machine: string}>();
  private readonly audioCommands = new Map<string, ProductionAudioCommand[]>();
  private inputOwner: ProductionCompositionInputOwner | undefined;
  private readonly semanticOwners = new Map<string, ProductionCompositionSemanticsOwner>();
  private readonly semanticBindings = new Map<string, ReadonlyMap<string, {part: string; id: string}>>();
  private readonly actionPlans = new Map<object, Readonly<{kind: 'data'; part: string; binding: string; value: RuntimeValue}> | Readonly<{kind: 'state'; part: string; machine: string; input: string; value: RuntimeValue}> | Readonly<{kind: 'audio'; part: string; command: ProductionAudioCommand}> | Readonly<{kind: 'host'}>>();
  private readonly inputCommands = new Map<number, RoutedCommand[]>();
  private readonly stateInputCommands: {part: string; machine: string; input: string; value: RuntimeValue}[] = [];
  private inputBytes = 0; private inputNodes = 0;
  private readonly coreOwners = new Map<string, ProductionCompositionCore>();
  private readonly corePlans = new Map<string, ProductionCoreBindingPlan>();
  private readonly coreDocuments = new Map<string, ParsedAnimation>();
  private readonly dataOwners = new Map<string, ProductionDataOwner>();
  private readonly stateOwners = new Map<string, ProductionStateController[]>();
  private readonly layouts = new Map<string, ProductionLayoutOwner>();
  private readonly texts: ProductionTextOwner[] = [];
  private guiTextPreparing:readonly GuiTextModel[]=[];
  private readonly guiTextFonts=new Map<string,ProductionTextOwner>();
  private readonly guiTextPlans:ReadonlyMap<string,GuiTextPlan>;
  private guiTextBases=new Map<string,Omit<GuiTextModel,'node'|'dpr'>>();
  private guiTextPrepared:ProductionCompositionOwner['guiTextBases']|undefined;
  private guiTextPreparedBytes=0;
  private guiTextModels:readonly GuiTextModel[]=Object.freeze([]);
  private readonly guiTextPreviews=new Map<string,Readonly<{address:Readonly<{part:string;block:string;instance:string;node:string}>;view:GuiTextView;bytes:number}>>();
  private guiTextPreviewBytes=0;
  private guiTextPreviewRevision=0;
  private guiTextPreviewAttempt:Readonly<{sequence:number;revision:number;values:ProductionCompositionOwner['guiTextPreviews']}>|undefined;
  private guiTextPreviewFrame:ProductionCompositionOwner['guiTextPreviews']=new Map();
  private readonly resourceSlots = new Map<string, {part: string; id: string; kind: 'image' | 'font' | 'blob' | 'artboard'}>();
  private readonly assets = new Map<string, LayoutAssetOwner>();
  private resources: ProductionResourceStage | undefined;
  private readonly dataResourceSlots = new Set<string>();
  private readonly stateResourceLinks = new Map<string, Map<string, string>>();
  private readonly stateResourcePorts = new Map<string, ProductionStateResourceOwnership>();
  private manualResources: ProductionResourceStage | undefined;
  private readonly manualSlots = new Map<string, {part: string; kind: 'image' | 'font' | 'blob' | 'artboard'; base: string; board?: string; node?: string}>();
  private readonly manualAliases = new Map<string, string>();
  private manualChoices = new Map<string, string>();
  private preparedManual: Map<string, string> | undefined;
  private frameIntents: readonly Intent[] = [];
  private publishing = false;
  private readonly ports: {stage(id: string): ProductionFrameStage; dispose(): void}[] = [];
  private readonly links: readonly Link[];
  private readonly ordered: readonly Part[];
  private readonly observers = new Set<(changes: readonly ProductionCompositionChange[]) => void>();
  private readonly queue: Intent[] = [];
  private transaction = 0; private changeSequence = 0;
  private queuedBytes = 0; private queuedNodes = 0;
  private readonly identities = new Map<string, Map<string, Set<string>>>();
  private readonly linkIndex = new Map<string, Link[]>();
  private collecting = false; private running = false; private disposed = false;
  private transportStatus: 'running'|'paused'|'stopped' = 'running'; private transportRate=1;
  private time = 0; private last: ProductionCompositionFrame | undefined;
  private frame: ProductionFrameTransaction | undefined;
  private readonly abort = () => this.dispose();
  private constructor(readonly definition: ProductionCompositionDefinition, private readonly host: ProductionCompositionHost, private readonly signal?: AbortSignal) {
    const metadata = copy({parts: definition.parts.map(part => ({id: part.id, kind: part.kind, dependencies: part.dependencies, document: part.document,
      ...(part.kind === 'state' ? {roots: part.roots} : {}), ...(part.kind === 'audio' && part.stateClock ? {stateClock: part.stateClock} : {}), ...(part.kind === 'layout' && part.contexts ? {contexts: part.contexts} : {})})), targets: definition.targets});
    this.definition = Object.freeze({parts: Object.freeze(definition.parts.map((part, index) => Object.freeze({...part, ...metadata.parts[index]}))), targets: metadata.targets}) as ProductionCompositionDefinition;
    this.ordered = order(this.definition.parts); this.links = compileLinks(this.definition);this.guiTextPlans=compileGuiTextPlans(this.definition);
    for (const link of this.links) if (link.target.kind === 'asset') {
      const part = this.ordered.find(part => part.id === link.target.part)!;
      const asset = part.kind === 'layout' && part.document.assets.find(asset => asset.id === link.target.address[0]);
      if (!asset || !['image', 'font', 'blob'].includes(asset.kind)) fail('E_HYA_RUNTIME_CAPABILITY', link.target.id, 'asset kind has no data selector adapter yet');
      const key = JSON.stringify([part.id, asset.id]); this.dataResourceSlots.add(key); this.resourceSlots.set(key, {part: part.id, id: asset.id, kind: asset.kind as 'image' | 'font' | 'blob'});
    }
    for (const target of this.definition.targets) {
      const part = this.ordered.find(part => part.id === target.part); if (part?.kind !== 'layout') continue;
      if (target.kind === 'asset') {
        const asset = part.document.assets.find(asset => asset.id === target.address[0]);
        if (!asset || !['image', 'font', 'blob'].includes(asset.kind)) continue;
        const key = JSON.stringify([part.id, 'asset', asset.id]); this.manualAliases.set(target.id, key); this.manualSlots.set(key, {part: part.id, kind: asset.kind as 'image' | 'font' | 'blob', base: asset.id});
      } else if (target.kind === 'layout-node') {
        const node = part.document.artboards.find(board => board.id === target.address[0])?.nodes.find(node => node.id === target.address[1]);
        if (node?.kind !== 'component' || !node.component) continue;
        const key = JSON.stringify([part.id, 'component', ...target.address]); this.manualAliases.set(target.id, key); this.manualSlots.set(key, {part: part.id, kind: 'artboard', base: node.component.artboard, board: target.address[0]!, node: target.address[1]!});
      }
    }
    for (const part of this.ordered) if (part.kind === 'state' && !part.ownership) {
      const links = new Map<string, string>();
      for (const channel of part.document.channels) if (channel.policy === 'ownership' && channel.valueKind !== 'callback') {
        const manual = this.manualAliases.get(channel.target), target = manual && this.manualSlots.get(manual);
        if (!manual || !target || channel.family !== 'resource-data' || channel.valueKind !== 'id') continue;
        if (!part.dependencies.includes(target.part)) fail('E_HYA_RUNTIME_REFERENCE', '$.parts.' + part.id + '.channels.' + channel.id, 'state resource target requires its explicit part dependency');
        const slot = target.kind === 'artboard' ? manual : JSON.stringify([target.part, target.base]);
        links.set(channel.id, slot); this.resourceSlots.set(slot, {part: target.part, id: target.base, kind: target.kind});
        for (const value of [channel.defaultValue, ...part.document.clips.flatMap(clip => clip.tracks.filter(track => track.channel === channel.id).flatMap(track => track.keys.map(key => key.value)))]) this.validateStateResource(slot, value ?? null, channel.id);
      }
      if (links.size) this.stateResourceLinks.set(part.id, links);
    }
    for (const link of this.links) {
      const key = JSON.stringify([link.target.part, link.target.kind, ...(link.target.kind === 'state-input' ? link.target.address.slice(0, 1) : link.target.address)]);
      const values = this.linkIndex.get(key) ?? []; values.push(link); this.linkIndex.set(key, values);
    }
    if (typeof host.invalidate !== 'function') fail('E_HYA_RUNTIME_HOST_PORT', '$options.host.invalidate', 'invalidation host is required');
    for (const part of this.ordered) if (part.kind === 'data') for (const [kind, values] of [['instance', part.document.instances], ['binding', part.document.bindings], ['group', part.document.propertyGroups], ['component', part.document.components]] as const) {
      const index = this.identities.get(kind) ?? new Map<string, Set<string>>();
      for (const value of values) {const parts = index.get(value.id) ?? new Set<string>(); parts.add(part.id); index.set(value.id, parts);} this.identities.set(kind, index);
    }
    this.preflightInput();
    for (const part of this.ordered) if (part.kind === 'core') {
      const animation = parseAnimation(part.document); this.coreDocuments.set(part.id, animation);
      const links = this.links.filter(link => link.target.kind === 'animation-node').map(link => ({data: link.data, binding: link.binding, target: link.target.id, path: link.path}));
      this.corePlans.set(part.id, new ProductionCoreBindingPlan(part.id, animation, this.definition.targets, links, this.ordered.filter((part): part is Extract<Part, {kind: 'state'}> => part.kind === 'state')));
      if (!part.materialize || !host.draw) fail('E_HYA_RUNTIME_HOST_PORT', '$.parts.' + part.id, 'core render composition requires its original core and draw adapters');
    }
    preflight(this.ordered, this.stateResourceLinks); if (signal?.aborted) fail('E_HYA_RUNTIME_ABORTED', '$options.signal', 'composition creation was cancelled');
  }
  static async create(definition: ProductionCompositionDefinition, host: ProductionCompositionHost, signal?: AbortSignal): Promise<ProductionCompositionOwner> {
    const owner = new ProductionCompositionOwner(definition, host, signal);
    try {await owner.initialize(); return owner;} catch (error) {owner.dispose(); throw error;}
  }
  read(instance: Reference, path: RuntimePath): RuntimeValue {const ref = this.resolve(instance, 'instance'); return this.dataOwners.get(ref.part)!.read(ref.id, path);}
  readBinding(binding: Reference): RuntimeValue {const ref = this.resolve(binding, 'binding'); return this.dataOwners.get(ref.part)!.readBinding(ref.id);}
  run(callback: (write: ProductionCompositionWrite) => void): number {
    this.live(); if (this.running && this.dataPreparing() || this.collecting) fail('E_HYA_RUNTIME_REENTRANT', '$.data.run', 'cannot collect a transaction during preparation or another transaction');
    const id = this.nextTransaction(), commands: RoutedCommand[] = []; this.collecting = true; let active = true, bytes = 2, nodes = 1;
    const add = (reference: Reference, kind: 'instance' | 'binding' | 'group', command: (id: string) => ProductionDataCommand): void => {
      this.live(); if (!active) fail('E_HYA_RUNTIME_TRANSACTION', '$.data.write', 'writer has expired');
      const ref = this.resolve(reference, kind), value = copy({part: ref.part, command: command(ref.id)}), cost = measure(value);
      bytes += cost.bytes + (commands.length ? 1 : 0); nodes += cost.nodes; this.capacity(bytes, nodes); commands.push(value);
    };
    try {
      callback(Object.freeze({id,
        set: (ref: Reference, path: RuntimePath, value: RuntimeValue) => add(ref, 'instance', instance => ({op: 'set', instance, path, value})),
        setBinding: (ref: Reference, value: RuntimeValue) => add(ref, 'binding', binding => ({op: 'binding', binding, value})),
        trigger: (ref: Reference, path: RuntimePath) => add(ref, 'instance', instance => ({op: 'trigger', instance, path})),
        insert: (ref: Reference, path: RuntimePath, index: number, value: RuntimeValue) => add(ref, 'instance', instance => ({op: 'insert', instance, path, index, value})),
        remove: (ref: Reference, path: RuntimePath, index: number) => add(ref, 'instance', instance => ({op: 'remove', instance, path, index})),
        move: (ref: Reference, path: RuntimePath, from: number, to: number) => add(ref, 'instance', instance => ({op: 'move', instance, path, from, to})),
        group: (ref: Reference, instance: Reference) => {
          const source = this.resolve(instance, 'instance'), group = this.resolve(ref, 'group');
          if (source.part !== group.part) fail('E_HYA_RUNTIME_REFERENCE', '$.data.group', 'property group and model instance belong to different parts');
          add(ref, 'group', id => ({op: 'group', group: id, instance: source.id}));
        },
      }));
      if (commands.length) this.enqueue(this.intent(id, commands)); return id;
    } finally {active = false; this.collecting = false;}
  }
  rebind(component: Reference, instance: Reference): void {
    this.live(); if (this.collecting || this.dataPreparing()) fail('E_HYA_RUNTIME_REENTRANT', '$.data.rebind', 'cannot rebind during preparation or collection');
    const ref = this.resolve(component, 'component'), model = this.resolve(instance, 'instance');
    if (ref.part !== model.part) fail('E_HYA_RUNTIME_REFERENCE', '$.data.rebind', 'component/model parts differ');
    this.enqueue(this.intent(this.nextTransaction(), [{part: ref.part, command: {op: 'rebind', component: ref.id, instance: model.id}}]));
  }
  async replaceResource(alias: string, kind: 'image' | 'artboard' | 'font' | 'blob', id: string): Promise<void> {
    this.live(); if (this.collecting || this.running && !this.publishing) fail('E_HYA_RUNTIME_REENTRANT', '$.data.replaceResource', 'resource intent cannot reenter frame preparation or collection');
    const slot = this.manualAliases.get(alias), definition = slot && this.manualSlots.get(slot);
    if (!slot || !definition || definition.kind !== kind || typeof id !== 'string' || !id) fail('E_HYA_RUNTIME_REFERENCE', '$.data.replaceResource', 'declared resource alias, kind and non-empty ID are required');
    const part = this.ordered.find(part => part.id === definition.part)!;
    if (part.kind !== 'layout' || (kind === 'artboard' ? !part.document.artboards.some(board => board.id === id) : !part.document.assets.some(asset => asset.id === id && asset.kind === kind)))
      fail('E_HYA_RUNTIME_REFERENCE', '$.data.replaceResource', 'replacement is absent or has the wrong kind');
    const choices = new Map(this.manualChoices); for (const intent of this.queue) if (intent.resource) choices.set(intent.resource.slot, intent.resource.id); choices.set(slot, id);
    const resolved = kind === 'artboard' ? id : this.resolveManualAsset(definition.part, definition.base, choices);
    const resource = copy({slot, id}), cost = measure(resource); this.capacity(cost.bytes, cost.nodes);
    const intent: Intent = Object.freeze({id: this.nextTransaction(), commands: Object.freeze([]), resource, bytes: cost.bytes, nodes: cost.nodes});
    let ready: Promise<void>; this.collecting = true;
    try {ready = this.manualResources!.ready(slot, JSON.stringify([definition.part, resolved])); this.enqueue(intent);} finally {this.collecting = false;}
    return ready;
  }
  subscribe(callback: (changes: readonly ProductionCompositionChange[]) => void): DataSubscription {
    this.live(); if (this.observers.size >= 1_000_000) fail('E_HYA_RUNTIME_LIMIT', '$.data.observers', 'original observer ceiling exceeded');
    this.observers.add(callback); let active = true;
    return Object.freeze({unsubscribe: () => {if (!active) return; active = false; this.observers.delete(callback);}});
  }
  advance(request: ProductionFrameRequest, intent?: ProductionFrameTransport): ProductionCompositionFrame {
    this.live(); if (this.running || this.collecting) fail('E_HYA_RUNTIME_REENTRANT', '$.advance', 'composition is already active');
    request = snapshotProductionFrameRequest(request);
    intent = intent === undefined ? undefined : snapshotProductionFrameTransport(intent);
    if (!intent && !Number.isFinite(this.time + request.deltaSeconds)) fail('E_HYA_RUNTIME_TIME', '$.time', 'composition time exceeds finite arithmetic');
    if (intent) for (const owner of this.audioOwners.values()) owner.assertRate(intent.rate);
    // GUI routing is added at the same input phase. Never silently discard supplied input.
    if (request.input?.some(input => !input.consumed) && !this.inputOwner) fail('E_HYA_RUNTIME_HOST_PORT', '$.input', 'the compiled GUI input adapter is not connected yet');
    if(!this.guiTextPreviewAttempt||this.guiTextPreviewAttempt.sequence!==request.sequence)this.guiTextPreviewAttempt=Object.freeze({sequence:request.sequence,revision:this.guiTextPreviewRevision,values:new Map(this.guiTextPreviews)});
    this.guiTextPreviewFrame=this.guiTextPreviewAttempt.values;this.guiTextPrepared=new Map(this.guiTextBases);this.guiTextPreparedBytes=[...this.guiTextBases.values()].reduce((n,m)=>n+m.bytes,0);
    this.frameIntents = Object.freeze([...this.queue]); this.running = true;
    try {const value=this.frame!.advance(request,intent).values['composition'] as ProductionCompositionFrame;this.guiTextPreviewAttempt=undefined;return value;} finally {this.guiTextPreparing=[];this.guiTextPrepared=undefined;this.guiTextPreviewFrame=new Map();this.running = false; this.publishing = false; this.frameIntents = []; this.preparedManual = undefined;}
  }
  assertRate(rate:number):void {this.live();if(!Number.isFinite(rate)||rate===0)fail('E_HYA_RUNTIME_TIME','$.rate','rate must be finite and nonzero');for(const owner of this.audioOwners.values())owner.assertRate(rate);}
  unlockAudio(): Promise<void> {
    this.live(); if (this.running || this.collecting) fail('E_HYA_RUNTIME_REENTRANT', '$.audio.unlock', 'unlock must enter through the actual host gesture outside frame preparation');
    return Promise.all([...this.audioOwners].map(([id, owner]) => owner.unlock(() => this.audioClocks(id, this.time, false),()=>({status:this.transportStatus,rate:this.transportRate})))).then(() => undefined);
  }
  whenAudioSettled(): Promise<void> {this.live(); return Promise.all([...this.audioOwners.values()].map(owner => owner.whenSettled())).then(() => undefined);}
  get audioTraces() {this.live(); return Object.freeze(Object.fromEntries([...this.audioOwners].map(([id, owner]) => [id, owner.trace])));}
  get audioStats() {return Object.freeze(Object.fromEntries([...this.audioOwners].map(([id, owner]) => [id, owner.stats])));}
  get lastFrame(): ProductionCompositionFrame | undefined {return this.last;}
  /** Private G06 view metadata; no editor value is committed through this path. */
  setGuiTextPreview(address:Readonly<{part:string;block:string;instance:string;node:string}>,view:GuiTextView|null):void {
    this.live();const a=copy(address);if(!a||Object.keys(a).length!==4||Object.keys(a).some(k=>!['part','block','instance','node'].includes(k))||Object.values(a).some(v=>typeof v!=='string'||!v))fail('E_HYA_RUNTIME_REFERENCE','$.gui.text','invalid opaque text address');
    const key=JSON.stringify([a.part,a.block,a.instance,a.node]),previous=this.guiTextPreviews.get(key);
    if(view===null){if(previous){this.guiTextPreviews.delete(key);this.guiTextPreviewBytes-=previous.bytes;this.guiTextPreviewRevision++;this.invalidate('gui-text-preview');}return;}
    const part=this.ordered.find(p=>p.id===a.part),node=this.last?.layouts[a.part]?.nodes.find(n=>n.instance===a.instance&&n.node===a.node&&n.text?.block===a.block);
    if(part?.kind!=='layout'||!part.document.textBlocks.find(b=>b.id===a.block)?.input||!node)fail('E_HYA_RUNTIME_REFERENCE','$.gui.text','text view must address a committed editable instance/node');
    const v=copy(view);if(!v||Object.keys(v).some(k=>!['value','selection','cursor','base','source','composing','composition','presentation'].includes(k))||typeof v.value!=='string'||v.base!==undefined&&typeof v.base!=='string'||v.source!==undefined&&typeof v.source!=='string'||v.composing!==undefined&&typeof v.composing!=='boolean'||v.composition!==undefined&&(!Array.isArray(v.composition)||v.composition.length!==2||v.composition.some(n=>!Number.isSafeInteger(n)||n<0||n>v.value.length))||v.presentation!==undefined&&(!v.presentation||Object.keys(v.presentation).some(k=>!['scroll','caretVisible'].includes(k))||typeof v.presentation.caretVisible!=='boolean'||!Array.isArray(v.presentation.scroll)||v.presentation.scroll.length!==2||v.presentation.scroll.some(n=>typeof n!=='number'||!Number.isFinite(n)))||v.selection!==undefined&&(!Array.isArray(v.selection)||v.selection.length!==2||v.selection.some(n=>!Number.isSafeInteger(n)||n<0||n>v.value.length))||v.cursor!==undefined&&(!Number.isSafeInteger(v.cursor)||v.cursor<0||v.cursor>v.value.length))fail('E_HYA_RUNTIME_BINDING','$.gui.text','invalid G06 view metadata');
    if(previous&&JSON.stringify(previous.view)===JSON.stringify(v))return;
    const bytes=new TextEncoder().encode(JSON.stringify([a,v])).byteLength,total=this.guiTextPreviewBytes-(previous?.bytes??0)+bytes;
    if(!Number.isSafeInteger(this.guiTextPreviewRevision+1)||total>64*1024*1024||!previous&&this.guiTextPreviews.size>=250_000)fail('E_HYA_RUNTIME_LIMIT','$.gui.text','view metadata exceeds the original frame/node ceiling');
    this.guiTextPreviews.set(key,Object.freeze({address:a,view:v,bytes}));this.guiTextPreviewBytes=total;this.guiTextPreviewRevision++;this.invalidate('gui-text-preview');
  }
  get guiTextPreviewTrace(){return Object.freeze({views:this.guiTextPreviews.size,bytes:this.guiTextPreviewBytes,revision:this.guiTextPreviewRevision,retrySequence:this.guiTextPreviewAttempt?.sequence??null});}
  get hasGuiText():boolean{return this.guiTextPlans.size>0;}
  get guiTexts():readonly GuiTextModel[]{this.live();return this.guiTextModels;}
  guiShapeText(model:GuiTextModel,view:GuiTextView,scroll:readonly[number,number]=[0,0]){
    this.live();if(!this.guiTextModels.includes(model)&&!this.guiTextPreparing.includes(model))fail('E_HYA_RUNTIME_REFERENCE','$.gui.text','text presentation requires a committed model');
    const input=model.plan.block.input!,r=model.node.rect,base=model.base;
    return this.guiTextFonts.get(model.address.part)!.shape({block:model.address.block,editingViewport:true,dpr:model.dpr,rasterOrigin:[r[0]-scroll[0],r[1]-scroll[1]],...(base.styles?{styles:base.styles}:{}),strings:{...base.strings,[input.valuePort]:view.value},selections:{...base.selections,...(input.selectionPort&&view.selection?{[input.selectionPort]:view.selection}:{})},cursors:{...base.cursors,...(input.cursorPort&&view.cursor!==undefined?{[input.cursorPort]:view.cursor}:{})},constraints:{width:{mode:'exact',value:r[2]},height:{mode:'exact',value:r[3]}}});
  }
  guiWriteText(model:GuiTextModel,value:string):number|null {
    this.live();if(!this.guiTextModels.includes(model)||typeof value!=='string')fail('E_HYA_RUNTIME_REFERENCE','$.gui.text','text edit must address a committed model');
    if(this.collecting||this.running&&!this.publishing)fail('E_HYA_RUNTIME_REENTRANT','$.gui.text','text edit cannot reenter preparation');
    if(!model.writers.length)return null;
    const id=this.nextTransaction();this.enqueue(this.intent(id,model.writers.map(w=>({part:w.part,command:{op:'binding',binding:w.binding,value,context:[w.model]}}))));return id;
  }
  guiCommitText(model:GuiTextModel,value:string,text:string,changed=true):number|null {
    this.live();if(!this.guiTextModels.includes(model)||typeof value!=='string'||typeof text!=='string')fail('E_HYA_RUNTIME_REFERENCE','$.gui.text','committed edit must address a live immutable text model');
    if(this.collecting||this.running&&!this.publishing)fail('E_HYA_RUNTIME_REENTRANT','$.gui.text','committed edit cannot reenter preparation');
    const target=model.plan.target,packet=target&&this.inputOwner!.guiHandlesText(target)?this.inputOwner!.prepareGui({kind:'text-input',text},target):undefined;
    const id=changed&&model.writers.length?this.nextTransaction():null,intent=id===null?undefined:this.intent(id,model.writers.map(w=>({part:w.part,command:{op:'binding',binding:w.binding,value,context:[w.model]}})));
    // Both original queues are admitted before any host invalidation can run a frame.
    packet?.commit();if(intent)this.enqueue(intent,false);if(packet||intent)this.invalidate('gui-text-commit');return id;
  }
  guiTransactionPending(id:number):boolean {this.live();return this.queue.some(q=>q.id===id);}
  registerGuiTextGeometry(target:CompositionGuiTarget,resolve:()=>ProductionLayoutNode):()=>void{this.live();return this.inputOwner!.registerGuiTextGeometry(target,resolve);}
  registerGuiTextFocus(target:CompositionGuiTarget):()=>void {this.live();return this.inputOwner!.registerGuiFocus(target);}
  get guiTargets(){this.live();return this.inputOwner?.guiTargets??Object.freeze([]);}
  guiBounds(target:CompositionGuiTarget){this.live();return this.inputOwner?.guiBounds(target);}
  guiHit(target:CompositionGuiTarget,point:readonly[number,number]):boolean{this.live();return this.inputOwner?.guiHit(target,point)??false;}
  guiTargetEnabled(target:CompositionGuiTarget):boolean{this.live();return this.inputOwner?.guiTargetEnabled(target)??false;}
  guiHandlesGamepad(target:CompositionGuiTarget,index:number,control:string,phase?:'down'|'up'|'change'):boolean{this.live();return this.inputOwner?.guiHandlesGamepad(target,index,control,phase)??false;}
  guiHandlesKeyboard(target:CompositionGuiTarget,key:string,phase:'down'|'up'|'repeat',modifiers:readonly string[]):boolean{this.live();return this.inputOwner?.guiHandlesKeyboard(target,key,phase,modifiers)??false;}
  /** Private bridge entry: only an existing G05 owner supplies these routed events. */
  enqueueGuiBatch(inputs:readonly CompositionGuiInput[],target:CompositionGuiTarget):void {
    this.live();if(!this.inputOwner)fail('E_HYA_RUNTIME_HOST_PORT','$.gui.input','composition has no interaction owner');if(!inputs.length)return;
    this.inputOwner.prepareGuiBatch(inputs,target).commit();this.invalidate('gui-input');
  }
  enqueueGui(input:CompositionGuiInput,target?:CompositionGuiTarget):void {
    this.live();if(!this.inputOwner)fail('E_HYA_RUNTIME_HOST_PORT','$.gui.input','composition has no interaction owner');
    this.inputOwner.enqueueGui(input,target);this.invalidate('gui-input');
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.signal?.removeEventListener('abort', this.abort);
    const failures: unknown[] = [];
    const dispose = (value: {dispose(): void}): void => {try {value.dispose();} catch (error) {failures.push(error);}};
    if (this.frame) dispose(this.frame);
    for (const owner of [...this.layouts.values(), ...this.texts, ...[...this.stateOwners.values()].flat(), ...this.dataOwners.values(), ...this.coreOwners.values(), ...this.semanticOwners.values(), ...this.audioOwners.values(), ...(this.inputOwner ? [this.inputOwner] : []), ...this.ports].reverse()) dispose(owner);
    if (this.resources) dispose(this.resources); if (this.manualResources) dispose(this.manualResources); for (const port of this.stateResourcePorts.values()) dispose(port); this.stateResourcePorts.clear(); this.manualChoices.clear(); this.preparedManual = undefined; for (const owner of this.assets.values()) dispose(owner); this.assets.clear();
    this.guiTextFonts.clear();this.guiTextBases.clear();this.guiTextModels=Object.freeze([]);this.guiTextPrepared=undefined;this.guiTextPreviews.clear();this.guiTextPreviewFrame.clear();this.guiTextPreviewAttempt=undefined;this.guiTextPreviewBytes=0;this.queue.length = 0; this.queuedBytes = this.queuedNodes = 0; this.observers.clear(); this.layouts.clear(); this.dataOwners.clear(); this.stateOwners.clear(); this.coreOwners.clear(); this.semanticOwners.clear(); this.audioOwners.clear(); this.audioCommands.clear(); this.inputOwner = undefined; this.inputCommands.clear(); this.stateInputCommands.length = 0; this.texts.length = 0; this.ports.length = 0; this.last = undefined;
    if (failures.length) this.report(new AggregateError(failures, 'Composition disposal failed'));
  }
  private dataDependency(source: Part, id: string): {part: string; id: string} {
    const found = this.ordered.filter((part): part is Extract<Part, {kind: 'data'}> => part.kind === 'data' && source.dependencies.includes(part.id) && part.document.bindings.some(binding => binding.id === id));
    if (found.length !== 1) fail('E_HYA_RUNTIME_REFERENCE', id, 'binding needs one explicit data-part dependency'); return {part: found[0]!.id, id};
  }
  private preflightInput(): void {
    const targets = new Map(this.definition.targets.map(target => [target.id, target]));
    for (const part of this.ordered) if (part.kind === 'audio') {
      validateProductionAudioHost(part.host);
      if (part.host.state === 'closed') fail('E_AUDIO_RUNTIME_STATE', part.id, 'a closed audio host cannot materialize a player');
      if (part.host.profile !== part.document.playbackProfile || part.host.sampleRate !== part.document.clock.sampleRate) fail('E_AUDIO_RUNTIME_PROFILE', part.id, 'audio host profile/sample rate must match its original document');
      if (part.stateClock || part.document.timelineEvents.some(event => event.clock === 'state')) {
        const roots = this.ordered.flatMap(value => value.kind === 'state' && part.dependencies.includes(value.id) ? value.roots.map(machine => ({part: value.id, machine})) : []);
        const clock = part.stateClock ?? (roots.length === 1 ? roots[0] : undefined);
        if (!clock || !roots.some(root => root.part === clock.part && root.machine === clock.machine)) fail('E_HYA_RUNTIME_REFERENCE', part.id, 'state-domain audio needs one explicit original root clock');
        this.audioStateClocks.set(part.id, clock);
      }
    }
    for (const part of this.ordered) if (part.kind === 'interaction') {
      for (const target of part.document.targets) if (target.hitArea.kind === 'geometry' && !part.geometry?.containsGeometry) fail('E_HYA_RUNTIME_HOST_PORT', target.id, 'original geometry port is missing');
      for (const listener of part.document.listeners) for (const action of listener.actions) {
        if (['focus', 'pointer-capture', 'pointer-release', 'report-event'].includes(action.kind)) continue;
        if (action.kind === 'data-set' || action.kind === 'data-trigger') {
          const ref = this.dataDependency(part, String(action.binding)), data = this.ordered.find(value => value.id === ref.part) as Extract<Part, {kind: 'data'}>;
          if (data.document.bindings.find(binding => binding.id === ref.id)!.direction === 'read') fail('E_HYA_RUNTIME_BINDING', ref.id, 'interaction binding is not writable');
          this.actionPlans.set(action, {kind: 'data', part: ref.part, binding: ref.id, value: action.kind === 'data-trigger' ? true : action.value as RuntimeValue});
        } else if (action.kind === 'state-input') {
          const owners = this.ordered.filter((value): value is Extract<Part, {kind: 'state'}> => value.kind === 'state' && part.dependencies.includes(value.id) && value.roots.includes(String(action.machine)));
          const owner = owners.length === 1 ? owners[0] : undefined, input = owner?.document.stateMachines.find(value => value.id === action.machine)?.inputs.find(value => value.id === action.input);
          if (!owner || !input || (input.type === 'number' ? typeof action.value !== 'number' : typeof action.value !== 'boolean')) fail('E_HYA_RUNTIME_REFERENCE', listener.id, 'state action needs one root/input dependency and a matching value');
          this.actionPlans.set(action, {kind: 'state', part: owner.id, machine: String(action.machine), input: input.id, value: action.value as RuntimeValue});
        } else if (action.kind === 'audio') {
          const target = targets.get(String(action.target)), audio = target && this.ordered.find(value => value.id === target.part);
          if (!target || target.kind !== 'audio-cue' || audio?.kind !== 'audio' || !part.dependencies.includes(audio.id)) fail('E_HYA_RUNTIME_REFERENCE', listener.id, 'audio action needs its declared cue alias and dependency');
          if (!['play', 'stop'].includes(String(action.operation))) fail('E_HYA_RUNTIME_CAPABILITY', listener.id, 'cue pause/seek needs its dedicated retained voice-control adapter');
          this.actionPlans.set(action, {kind: 'audio', part: audio.id, command: action.operation === 'play' ? {kind: 'play', cue: target.address[0]!, domain: 'event'} : {kind: 'stop-cue', cue: target.address[0]!}});
        } else {
          if (!part.actions?.kinds.has(action.kind) || action.kind === 'custom' && !part.actions.protocols?.has(String(action.protocol))) fail('E_HYA_RUNTIME_HOST_PORT', listener.id, 'action kind/protocol has no explicit transactional owner port');
          this.actionPlans.set(action, {kind: 'host'});
        }
      }
    }
    for (const part of this.ordered) if (part.kind === 'semantics') {
      if (part.document.nodes.length && !part.bounds) fail('E_HYA_RUNTIME_HOST_PORT', part.id, 'semantic bounds require the prepared geometry adapter');
      const bindings = new Map<string, {part: string; id: string}>();
      for (const node of part.document.nodes) {
        const target = targets.get(node.target); if (!target || !part.dependencies.includes(target.part)) fail('E_HYA_RUNTIME_REFERENCE', node.id, 'semantic target needs its declared alias and dependency');
        if (node.actions?.length && target.kind !== 'interaction-target') fail('E_HYA_RUNTIME_REFERENCE', node.id, 'semantic actions need their original interaction target');
        for (const value of [node.label, node.value, node.hint, ...Object.values(node.state ?? {})]) if (value?.kind === 'binding') bindings.set(value.binding!, this.dataDependency(part, value.binding!));
      }
      this.semanticBindings.set(part.id, bindings);
    }
  }
  private audioClocks(part: string, time: number, prepared: boolean): RuntimeClockSnapshot {
    const clock = this.audioStateClocks.get(part); let state = time;
    if (clock) {const source = this.ordered.find(value => value.id === clock.part) as Extract<Part, {kind: 'state'}>; const owner = this.stateOwners.get(clock.part)![source.roots.indexOf(clock.machine)]!; state = prepared ? owner.frameClock : owner.clock;}
    return Object.freeze({composition: time, state, event: time});
  }
  private async initialize(): Promise<void> {
    this.signal?.addEventListener('abort', this.abort, {once: true});
    const converterPorts = new Map<object, ProductionTransactionPort<Parameters<CustomConverterPort['invoke']>, RuntimeValue>>();
    const conditionPorts = new Map<object, ProductionTransactionPort<Parameters<DeterministicInvocationPort['invoke']>, ReturnType<DeterministicInvocationPort['invoke']>>>();
    const ownershipPorts = new Map<object, ProductionTransactionPort<Parameters<ChannelOwnershipPort['transfer']>, void>>();
    const effects: {part: string; machine: string; effect: Parameters<SideEffectPort['invoke']>[0]}[] = [];
    const effectPorts = new ProductionTransactionPort({begin() {effects.length = 0;}, invoke: (part: string, machine: string, effect: Parameters<SideEffectPort['invoke']>[0]) => {effects.push(Object.freeze({part, machine, effect: Object.freeze({...effect, payload: copy(effect.payload)})}));}, commit: () => {if (effects.length) this.host.events?.(Object.freeze([...effects]));}, rollback() {effects.length = 0;}});
    this.ports.push(effectPorts);
    for (const part of this.ordered) {
      this.live();
      if (part.kind === 'core') {
        const owner = part.materialize!(this.coreDocuments.get(part.id)!, this.corePlans.get(part.id)!.channels, part.id);
        if (!owner || typeof owner.prepare !== 'function' || typeof owner.dispose !== 'function') {owner?.dispose?.(); fail('E_HYA_RUNTIME_HOST_PORT', part.id, 'core factory did not return its owned adapter');}
        this.coreOwners.set(part.id, owner);
      } else if (part.kind === 'data') {
        const host = part.options?.converter; let converter = host && converterPorts.get(host);
        if (host && !converter) {converter = new ProductionTransactionPort(host); converterPorts.set(host, converter); this.ports.push(converter);}
        this.dataOwners.set(part.id, new ProductionDataOwner(part.document, {...part.options, invalidate: () => this.invalidate('data'), diagnostic: (error, id) => this.report(error, id)}, converter));
      } else if (part.kind === 'state') {
        let condition = part.conditions && conditionPorts.get(part.conditions);
        if (part.conditions && !condition) {condition = new ProductionTransactionPort(part.conditions); conditionPorts.set(part.conditions, condition); this.ports.push(condition);}
        let ownership = part.ownership && ownershipPorts.get(part.ownership);
        if (part.ownership && !ownership) {const host = part.ownership; ownership = new ProductionTransactionPort({begin: id => host.begin(id), invoke: change => host.transfer(change), commit: id => host.commit(id), rollback: id => host.rollback(id)}); ownershipPorts.set(part.ownership, ownership); this.ports.push(ownership);}
        if (!ownership && this.stateResourceLinks.has(part.id)) {
          const bridge = new ProductionStateResourceOwnership((channel, value) => {const slot = this.stateResourceLinks.get(part.id)!.get(channel.id); if (!slot) fail('E_HYA_RUNTIME_REFERENCE', channel.id, 'state resource channel has no compiled target'); this.validateStateResource(slot, value, channel.id);});
          this.stateResourcePorts.set(part.id, bridge); ownership = new ProductionTransactionPort({begin: id => bridge.begin(id), invoke: change => bridge.transfer(change), commit: id => bridge.commit(id), rollback: id => bridge.rollback(id)}); this.ports.push(ownership);
        }
        const owners = part.roots.map(machine => {
          const localEffects = effectPorts.createPort(), localOwnership = ownership?.createPort();
          return new ProductionStateController(part.document, machine, {sideEffectPort: {begin: id => localEffects.begin(id), invoke: effect => localEffects.invoke(part.id, machine, effect), commit: id => localEffects.commit(id), rollback: id => localEffects.rollback(id), ...lifecycle},
            ...(condition ? {invocationPort: condition.createPort()} : {}), ...(localOwnership ? {ownershipPort: {...localOwnership, transfer: change => localOwnership.invoke(change), reset() {}, dispose() {}}} : {}), ...(part.nested ? {nestedFactory: part.nested} : {})}, {generation: 0, part: part.id, instance: machine});
        });
        this.stateOwners.set(part.id, owners);
      }
    }
    for (const part of this.ordered) if (part.kind === 'layout' && ([...this.resourceSlots.values()].some(slot => slot.part === part.id) || [...this.manualSlots.values()].some(slot => slot.part === part.id)))
      this.assets.set(part.id, part.assetOwner ?? new LayoutAssetOwner(part.document, part.assetOptions ?? {policy: {mode: 'deny'}}));
    if (this.resourceSlots.size) this.resources = new ProductionResourceStage([...this.resourceSlots].map(([slot, value]) => ({slot, kind: value.kind})), {acquire: async (kind, identity, signal) => {
      const [part, id] = JSON.parse(identity) as [string, string], assets = this.assets.get(part);
      if (kind === 'artboard' && assets) {const board = assets.document.artboards.find(board => board.id === id); if (!board) fail('E_HYA_RUNTIME_REFERENCE', '$.resources', 'selected inline artboard is absent'); return Object.freeze({value: board, release() {}});}
      const asset = assets?.document.assets.find(asset => asset.id === id);
      if (!assets || !asset || asset.kind !== kind) fail('E_HYA_RUNTIME_REFERENCE', '$.resources', 'selected asset has the wrong part or kind');
      const handle = await assets.load(id, {signal}); return {value: handle.bytes, release: handle.release};
    }}, () => this.invalidate('resources'), error => this.report(error));
    if (this.manualSlots.size) this.manualResources = new ProductionResourceStage([...this.manualSlots].map(([slot, value]) => ({slot, kind: value.kind})), {acquire: async (kind, identity, signal) => {
      const [part, id] = JSON.parse(identity) as [string, string], assets = this.assets.get(part);
      if (!assets) fail('E_HYA_RUNTIME_REFERENCE', '$.resources', 'replacement part is absent');
      if (kind === 'artboard') {
        const board = assets.document.artboards.find(board => board.id === id); if (!board) fail('E_HYA_RUNTIME_REFERENCE', '$.resources', 'inline artboard is absent');
        // The acquired value is the real immutable compiled descriptor; GPU children remain with the original layout/draw owners.
        return Object.freeze({value: board, release() {}});
      }
      const asset = assets.document.assets.find(asset => asset.id === id); if (!asset || asset.kind !== kind) fail('E_HYA_RUNTIME_REFERENCE', '$.resources', 'replacement asset kind differs');
      const handle = await assets.load(id, {signal}); return {value: handle.bytes, release: handle.release};
    }}, () => this.invalidate('manual-resources'), error => this.report(error));
    for (const part of this.ordered) if (part.kind === 'layout') {
      this.live(); let text: ProductionTextOwner | undefined;
      if (part.document.artboards.some(board => board.nodes.some(node => node.kind === 'text'))) {
        text = new ProductionTextOwner(part.document, part.fonts!, this.signal ? {signal: this.signal} : {}); this.texts.push(text);this.guiTextFonts.set(part.id,text); await text.prepare(); this.live();
      }
      this.layouts.set(part.id, new ProductionLayoutOwner(part.document, text, {editableText:this.host.guiText??false,
        ...(this.signal ? {signal: this.signal} : {}), resolveText: (block, context) => this.textBindings(part, block, context),
        resolveNode: context => this.nodeBindings(part, context), ...(this.resources || this.manualResources ? {resolveAsset: (id: string) => this.selectedAsset(part.id, id)} : {}),
      }, undefined, part.id));
    }
    for (const part of this.ordered) if (part.kind === 'audio') {
      this.live(); const owner = new ProductionCompositionAudioOwner(part.id, part.document, part.host, error => this.report(error), this.signal); this.audioOwners.set(part.id, owner);
      await owner.prepare(); this.live();
    }
    const actionPorts = new Map<InteractionActionPort, ProductionTransactionPort<[RuntimeInteractionAction, RoutedInteractionEvent], void>>();
    const interactions = this.ordered.filter((part): part is Extract<Part, {kind: 'interaction'}> => part.kind === 'interaction');
    if (interactions.length||this.host.guiText&&this.guiTextPlans.size) this.inputOwner = new ProductionCompositionInputOwner(interactions.map(part => {
      let transaction = part.actions && actionPorts.get(part.actions);
      if (part.actions && !transaction) {transaction = new ProductionTransactionPort(part.actions); actionPorts.set(part.actions, transaction); this.ports.push(transaction);}
      const local = transaction?.createPort();
      return {id: part.id, document: part.document, ...(part.geometry ? {geometry: part.geometry} : {}), invoke: (action: RuntimeInteractionAction, event: RoutedInteractionEvent, transaction: number) => {
        const plan = this.actionPlans.get(action)!;
        if (plan.kind === 'data') {
          const command: RoutedCommand = {part: plan.part, command: {op: 'binding', binding: plan.binding, value: plan.value}}, cost = measure(command);
          this.inputBytes += cost.bytes; this.inputNodes += cost.nodes; this.capacity(this.inputBytes, this.inputNodes);
          const commands = this.inputCommands.get(transaction) ?? []; commands.push(command); this.inputCommands.set(transaction, commands);
        } else if (plan.kind === 'audio') {const commands = this.audioCommands.get(plan.part) ?? []; if (commands.length >= 1_000_000) fail('E_AUDIO_RUNTIME_LIMIT', plan.part, 'audio action ceiling exceeded'); commands.push(plan.command); this.audioCommands.set(plan.part, commands);}
        else if (plan.kind === 'state') {if (this.stateInputCommands.length >= 1_000_000) fail('E_HYA_RUNTIME_LIMIT', '$.input.actions', 'state input action ceiling exceeded'); this.stateInputCommands.push(plan);}
        else {local!.begin(event.sequence); try {local!.invoke(action, event); local!.commit(event.sequence);} catch (error) {local!.rollback(event.sequence); throw error;}}
      }};
    }), this.definition.targets);
    for (const part of this.ordered) if (part.kind === 'semantics') {
      this.semanticOwners.set(part.id, new ProductionCompositionSemanticsOwner(part.id, part.document, {
        ...(part.bridge ? {host: part.bridge} : {}),
        read: (binding, prepared) => {const ref = this.semanticBindings.get(part.id)!.get(binding)!; const owner = this.dataOwners.get(ref.part)!; return prepared ? owner.readBindingPrepared(ref.id) : owner.readBinding(ref.id);},
        geometry: (target, layouts) => {
          const alias=this.definition.targets.find(value=>value.id===target);
          if(alias?.kind==='interaction-target')for(const plan of this.guiTextPlans.values())if(plan.target?.part===alias.part&&plan.target.id===alias.address[0]){
            const nodes=layouts[plan.part]?.nodes.filter(node=>node.text?.block===plan.block.id)??[];
            if(nodes.length>1)return undefined;
            if(nodes[0]?.transform)return this.inputOwner!.guiBoundsWithTransform(plan.target,nodes[0].transform);
          }
          return part.bounds!(target,layouts);
        },
        action: (target, action) => this.inputOwner!.semantic(target, action), diagnostic: error => this.report(error), invalidate: () => this.invalidate('semantics'),
      }));
    }
    let selected: readonly Intent[] = [], rejected: {id: number; error: unknown}[] = [], transactions = new Map<string, Map<number, number>>();
    const stages: ProductionFrameStage[] = this.ports.map((port, index) => port.stage('port:' + index));
    stages.unshift({id:'transport-admission',phase:'input-queue',prepare:context=>{const intent=context.transport;if(intent&&!intent.relocation&&intent.time!==this.time+intent.deltaSeconds)fail('E_HYA_RUNTIME_TIME','$.transport.time','forward transport must match the committed clock plus its delta');return{commit(){},rollback(){}};}});
    const dataStages = [...this.dataOwners].flatMap(([id, owner]) => [...owner.stages('data:' + id)]);
    stages.push(...dataStages.filter(stage => stage.phase === 'input-queue'));
    if (this.inputOwner) {
      const input = this.inputOwner.stage(() => {for (const owner of this.semanticOwners.values()) owner.input();});
      stages.push({...input, prepare: context => {
        const previous = this.transaction; this.inputCommands.clear(); this.audioCommands.clear(); this.stateInputCommands.length = 0; this.inputBytes = this.inputNodes = 0;
        try {const step = input.prepare(context); return {...step, rollback: () => {try {step.rollback();} finally {this.transaction = previous; this.inputCommands.clear(); this.stateInputCommands.length = 0;}}};}
        catch (error) {this.transaction = previous; throw error;}
      }});
    }

    stages.push({id: 'global-data', phase: 'atomic-data', prepare: () => {
      selected = [...this.frameIntents, ...[...this.inputCommands.values()].map(commands => this.intent(this.nextTransaction(), commands))]; this.preparedManual = new Map(this.manualChoices); rejected = []; transactions = new Map(); let expanded = 0;
      for (const intent of selected) {
        const byPart = new Map<string, ProductionDataCommand[]>(); for (const {part, command} of intent.commands) {const values = byPart.get(part) ?? []; values.push(command); byPart.set(part, values);}
        const prepared: {part: string; step: ReturnType<ProductionDataOwner['prepareCommands']>}[] = [];
        try {
          const cost = intent.commands.reduce((count, {part, command}) => count + (command.op === 'group' ? this.dataOwners.get(part)!.document.propertyGroups.find(group => group.id === command.group)?.operations.length ?? 1 : 1), 0);
          if (cost + expanded > 1_000_000) fail('E_DATA_RUNTIME_LIMIT', '$.data.commands', 'cross-part expanded mutations exceed the original composition node ceiling');
          for (const part of this.ordered) if (byPart.has(part.id)) prepared.push({part: part.id, step: this.dataOwners.get(part.id)!.prepareCommands(byPart.get(part.id)!)});
          for (const {part, step} of prepared) {step.commit(); const ids = transactions.get(part) ?? new Map(); ids.set(step.transaction, intent.id); transactions.set(part, ids);}
          expanded += cost; if (intent.resource) this.preparedManual.set(intent.resource.slot, intent.resource.id);
        } catch (error) {
          for (const {step} of prepared.reverse()) step.rollback();
          if (!this.frameIntents.includes(intent) || !isDataError(error)) throw error; rejected.push({id: intent.id, error});
        }
      }
      return {commit: () => {this.manualChoices = this.preparedManual!; this.preparedManual = undefined; this.queue.splice(0, this.frameIntents.length); for (const intent of this.frameIntents) {this.queuedBytes -= intent.bytes; this.queuedNodes -= intent.nodes;}}, rollback: () => {this.preparedManual = undefined;}};
    }});
    stages.push(...dataStages.filter(stage => stage.phase === 'atomic-data'));
    for (const part of this.ordered) if (part.kind === 'state') stages.push(stateFrameStage('state:' + part.id, this.stateOwners.get(part.id)!, (owner, index) => {
      const machine = part.roots[index];
      for (const link of this.linkIndex.get(JSON.stringify([part.id, 'state-input', machine])) ?? []) {
        const value = this.dataOwners.get(link.data)!.readBindingPrepared(link.binding), input = part.document.stateMachines.find(value => value.id === machine)!.inputs.find(value => value.id === link.target.address[1])!;
        if (input.type === 'trigger') {if (typeof value !== 'boolean') fail('E_HYA_RUNTIME_BINDING', link.binding, 'trigger binding needs a boolean'); if (value) owner.setTrigger(input.id); else owner.resetTrigger(input.id);}
        else if (input.type === 'boolean') owner.setBoolean(input.id, value as boolean); else owner.setNumber(input.id, value as number);
      }
      for (const command of this.stateInputCommands) if (command.part === part.id && command.machine === machine) {
        const input = part.document.stateMachines.find(value => value.id === machine)!.inputs.find(value => value.id === command.input)!;
        if (input.type === 'trigger') {if (command.value) owner.setTrigger(input.id); else owner.resetTrigger(input.id);}
        else if (input.type === 'boolean') owner.setBoolean(input.id, command.value as boolean); else owner.setNumber(input.id, command.value as number);
      }
    }));
    if (this.manualResources) stages.push({id: 'manual-resources', phase: 'state-timeline', prepare: () => this.manualResources!.prepare([...this.preparedManual!].map(([slot, id]) => {const definition = this.manualSlots.get(slot)!; return {slot, id: JSON.stringify([definition.part, definition.kind === 'artboard' ? id : this.resolveManualAsset(definition.part, definition.base)])};}))});
    if (this.resources) stages.push({id: 'resources', phase: 'state-timeline', prepare: context => this.resources!.prepare(this.resourceSelections(context))});
    for (const part of this.ordered) if (part.kind === 'layout') stages.push(checkpointFrameStage('layout:' + part.id, 'text-layout', this.layouts.get(part.id)!, context => ({value: this.layouts.get(part.id)!.evaluate({viewport: context.request.viewport, dpr: context.request.dpr,
      time: (context.transport?.time ?? this.time + context.request.deltaSeconds)}, JSON.stringify({guiText:this.guiTextPreviewAttempt?.revision??0,data: [...this.dataOwners].map(([id, owner]) => [id, owner.bindingRevision]), manual: [...(this.preparedManual ?? this.manualChoices)].filter(([slot]) => this.manualSlots.get(slot)?.part === part.id), resources: [...this.resourceSlots].filter(([, value]) => value.part === part.id).map(([slot]) => [slot, this.resources?.selection(slot)])}))})));
    for (const [part, owner] of this.coreOwners) stages.push({id: 'core:' + part, phase: 'geometry-draw', prepare: context => {
      const states = Object.fromEntries([...this.stateOwners.keys()].map(id => [id, context.values.get('state:' + id) as readonly StateMachinePose[]]));
      const channels = this.corePlans.get(part)!.resolve(states, (part, binding) => this.dataOwners.get(part)!.readBindingPrepared(binding));
      const value = owner.prepare((context.transport?.time ?? this.time + context.request.deltaSeconds), channels, context.request); return {value, commit() {}, rollback() {}};
    }});
    for (const owner of this.semanticOwners.values()) stages.push(owner.stage(context => Object.freeze(Object.fromEntries([...this.layouts.keys()].map(id => [id, context.values.get('layout:' + id) as ProductionLayoutFrame]))), () => this.inputOwner?.focused ?? null));
    for (const [id, owner] of this.audioOwners) stages.push(owner.stage(context => this.audioClocks(id, (context.transport?.time ?? this.time + context.request.deltaSeconds), true), () => this.audioCommands.get(id) ?? [], context => context.transport));
    stages.push({id: 'composition', phase: 'geometry-draw', prepare: context => {
      const layouts = Object.freeze(Object.fromEntries([...this.layouts.keys()].map(id => [id, context.values.get('layout:' + id)]))) as Readonly<Record<string, ProductionLayoutFrame>>;
      const states = Object.freeze(Object.fromEntries([...this.stateOwners.keys()].map(id => [id, Object.freeze((context.values.get('state:' + id) as readonly StateMachinePose[]).map(pose => Object.freeze({...pose,
        channels: Object.freeze(pose.channels.map(value => Object.freeze({...value, value: copy(value.value)}))),
        effects: Object.freeze(pose.effects.map(effect => Object.freeze({...effect, payload: copy(effect.payload)}))),
      })))]))) as Readonly<Record<string, readonly StateMachinePose[]>>;
      let changeSequence = this.changeSequence;
      const changes = this.ordered.flatMap(part => {
        if (part.kind !== 'data') return [];
        const batch = context.values.get('data:' + part.id) as {changes: readonly {sequence: number; transactionId: number; instance: string; path: RuntimePath; kind: string; previous?: RuntimeValue; value?: RuntimeValue}[]};
        return batch.changes.map(({previous, value, ...change}) => Object.freeze({part: part.id, sequence: ++changeSequence,
          transaction: transactions.get(part.id)?.get(change.transactionId) ?? change.transactionId, instance: change.instance, path: change.path, kind: change.kind,
          ...(previous === undefined ? {} : {previous: copy(previous)}), ...(value === undefined ? {} : {value: copy(value)})}));
      });
      const cores = new Map<string, PreparedCompositionCore>([...this.coreOwners.keys()].map(id => [id, context.values.get('core:' + id) as PreparedCompositionCore])), time = (context.transport?.time ?? this.time + context.request.deltaSeconds);
      const audio = Object.freeze(Object.fromEntries([...this.audioOwners.keys()].map(id => [id, context.values.get('audio:' + id)]))) as Readonly<Record<string, CompositionAudioFrame>>;
      const semantics = Object.freeze(Object.fromEntries([...this.semanticOwners.keys()].map(id => [id, context.values.get('semantics:' + id)]))) as Readonly<Record<string, CompositionSemanticSnapshot>>;
      const input = (context.values.get('composition-input') ?? Object.freeze({focused: null, events: Object.freeze([])})) as ProductionCompositionFrame['input'];
      let value: ProductionCompositionFrame = Object.freeze({effects: Object.freeze(effects.map(value => Object.freeze({...value, effect: Object.freeze({...value.effect, payload: copy(value.effect.payload)})}))), input, semantics, audio, sequence: context.request.sequence, time, layouts, states, cores: Object.freeze(Object.fromEntries([...cores].map(([id, core]) => [id, Object.freeze({revision: core.revision})]))), changes: Object.freeze(changes)});
      const guiModels:GuiTextModel[]=[];
      if(this.host.guiText)for(const [part,layout]of Object.entries(layouts))for(const node of layout.nodes)if(node.text&&node.opacity>0&&node.rect[2]>0&&node.rect[3]>0){
        const key=JSON.stringify([part,node.text.block,node.instance,node.node]),base=this.guiTextPrepared!.get(key);if(!base)continue;
        if(!node.text.editing)fail('E_HYA_RUNTIME_HOST_PORT',key,'editable GUI text requires geometry from the same prepared font owner');
        guiModels.push(Object.freeze({...base,node,dpr:layout.dpr}));
      }
      const associated=new Set<string>();for(const model of guiModels)if(model.plan.target){const key=JSON.stringify(model.plan.target);if(associated.has(key))fail('E_HYA_RUNTIME_REFERENCE',key,'repeated editable nodes require distinct declared interaction owners');associated.add(key);}
      if(guiModels.filter(m=>!m.plan.target).length+(this.inputOwner?.guiTargets.length??0)>100_000)fail('E_HYA_RUNTIME_LIMIT','$.gui.text','editable focus targets exceed the original interaction ceiling');
      this.guiTextPreparing=guiModels;value=this.host.presentation?.(value,guiModels)??value;
      const draw = this.host.draw?.(value, cores);
      return {value, commit: () => {draw?.commit(); this.changeSequence = changeSequence; this.time = value.time; if(context.transport){this.transportStatus=context.transport.status;this.transportRate=context.transport.rate;} this.last = value;this.guiTextModels=Object.freeze(guiModels);this.guiTextBases=new Map(guiModels.map(m=>[m.key,this.guiTextPrepared!.get(m.key)!]));}, rollback: () => draw?.rollback(), finalize: () => {draw?.finalize?.(); this.publishing = true;}, publish: () => {
        for (const failure of rejected) this.report(failure.error, failure.id);
        for (const observer of [...this.observers]) {if (this.disposed || !this.observers.has(observer)) continue; try {if (changes.length) observer(value.changes);} catch (error) {this.report(error);}}
        if (input.events.length) this.host.interactionEvents?.(input.events);
        draw?.publish?.();
      }};
    }});
    this.frame = new ProductionFrameTransaction(stages, error => this.report(error));
  }
  private textBindings(part: Extract<Part, {kind: 'layout'}>, block: string, context: LayoutTextContext): ScopedText {
    const result: {strings: Record<string, string>; selections: Record<string, readonly [number, number]>; cursors: Record<string, number>; styles: NonNullable<ScopedText['styles']> & Record<string, Partial<RuntimeLayoutDocument['textStyles'][number]>>} = {strings: {}, selections: {}, cursors: {}, styles: {}};
    for (const link of this.linkIndex.get(JSON.stringify([part.id, 'text-block', block])) ?? []) {
      const value = this.dataOwners.get(link.data)!.readBindingPrepared(link.binding, this.context(part, context, link.data)); const [kind, port, field] = link.path;
      if (kind === 'strings') {if (typeof value !== 'string') fail('E_HYA_RUNTIME_BINDING', link.binding, 'text binding must be a string'); result.strings[port!] = value;}
      else if (kind === 'selections') result.selections[port!] = value as readonly [number, number];
      else if (kind === 'cursors') result.cursors[port!] = value as number;
      else result.styles[port!] = {...result.styles[port!], [field!]: value};
    }
    for (const style of part.document.textStyles) {
      const fonts = result.styles[style.id]?.fontAssets ?? style.fontAssets;
      if (!Array.isArray(fonts)) fail('E_HYA_RUNTIME_BINDING', style.id, 'font fallback chain must be an array');
      const selected = fonts.map(id => this.selectedAsset(part.id, id)).filter((id): id is string => id !== null);
      if (selected.length !== fonts.length || selected.some((id, index) => id !== fonts[index])) result.styles[style.id] = {...result.styles[style.id], fontAssets: selected};
    }
    const editable=this.guiTextPlans.get(JSON.stringify([part.id,block]));
    if(editable?.reader){const port=editable.block.input!.valuePort,alias=editable.block.runs[0]?.valuePort;
      if(result.strings[port]===undefined&&alias&&result.strings[alias]!==undefined)result.strings[port]=result.strings[alias]!;
    }
    if(this.host.guiText){const plan=editable;if(plan){
      const address={part:part.id,block,instance:context.instanceId,node:context.node.id},key=JSON.stringify([part.id,block,context.instanceId,context.node.id]);
      const value=textContent(plan.block,result.strings);
      const reader=plan.reader?{...plan.reader,model:this.dataOwners.get(plan.reader.part)!.bindingInstance(plan.reader.binding,this.context(part,context,plan.reader.part))}:undefined;
      const writers=plan.writers.map(w=>Object.freeze({...w,model:this.dataOwners.get(w.part)!.bindingInstance(w.binding,this.context(part,context,w.part))}));
      const descriptor={key,address:copy(address),plan,value,source:JSON.stringify([reader??null,writers]),writers:Object.freeze(writers),base:copy(result)},bytes=measure(descriptor).bytes,total=this.guiTextPreparedBytes-(this.guiTextPrepared!.get(key)?.bytes??0)+bytes;
      if(total>64*1024*1024||!this.guiTextPrepared!.has(key)&&this.guiTextPrepared!.size>=250_000)fail('E_HYA_RUNTIME_LIMIT','$.gui.text','editable model metadata exceeds original frame/node ceilings');
      this.guiTextPrepared!.set(key,Object.freeze({...descriptor,bytes}));this.guiTextPreparedBytes=total;
    }}
    const previewKey=JSON.stringify([part.id,block,context.instanceId,context.node.id]),base=this.guiTextPrepared?.get(previewKey);let view=this.guiTextPreviewFrame.get(previewKey)?.view;
    if(view?.source!==undefined&&base&&view.source!==base.source)view=undefined;
    if(view&&base?.plan.reader&&view.base!==undefined&&base.value!==view.base&&!view.composing&&view.value!==base.value){
      const input=base.plan.block.input!,strings={...result.strings,[input.valuePort]:base.value};
      // Reconcile only presentation using the same prepared font geometry. The original G06 buffer is updated after commit; no editor/undo/composition state is mutated during a fallible frame.
      const shaped=this.guiTextFonts.get(part.id)!.shape({block,editingViewport:true,strings,styles:result.styles,...(context.rect?{constraints:{width:{mode:'exact',value:context.rect.width},height:{mode:'exact',value:context.rect.height}}}:{})});
      const caret=view.cursor===undefined?undefined:shaped.editing?.carets.findLast(c=>c.offset<=Math.min(view!.cursor!,base.value.length))?.offset;
      if(view.cursor!==undefined&&caret===undefined)fail('E_HYA_RUNTIME_HOST_PORT',previewKey,'external text synchronization requires visible original caret geometry');
      view={...view,value:base.value,...(caret===undefined?{}:{cursor:caret,selection:[caret,caret]})};
    }
    if(view){const input=part.document.textBlocks.find(b=>b.id===block)!.input!;result.strings[input.valuePort]=view.value;if(input.selectionPort&&view.selection)result.selections[input.selectionPort]=view.selection;if(input.cursorPort&&view.cursor!==undefined)result.cursors[input.cursorPort]=view.cursor;}
    if(base){const next={...base,...(view?{view}:{} )},bytes=measure(next).bytes,total=this.guiTextPreparedBytes-base.bytes+bytes;if(total>64*1024*1024)fail('E_HYA_RUNTIME_LIMIT','$.gui.text','editing views exceed original frame bytes');this.guiTextPrepared!.set(previewKey,Object.freeze({...next,bytes}));this.guiTextPreparedBytes=total;}
    return result;
  }
  private resourceSelections(context: import('./FrameTransaction.js').ProductionFrameContext): readonly ProductionResourceSelection[] {
    const values = new Map<string, string | null>([...this.resourceSlots].filter(([slot]) => this.dataResourceSlots.has(slot)).map(([slot, value]) => [slot, JSON.stringify([value.part, value.id])])), assigned = new Map<string, string | null>();
    for (const link of this.links) if (link.target.kind === 'asset') {
      const id = this.dataOwners.get(link.data)!.readBindingPrepared(link.binding), slot = JSON.stringify([link.target.part, link.target.address[0]]), definition = this.resourceSlots.get(slot)!;
      if (id !== null && (typeof id !== 'string' || !id)) fail('E_HYA_RUNTIME_BINDING', link.binding, 'asset selector requires a non-empty resource ID');
      if (id === null) {if (assigned.has(slot) && assigned.get(slot) !== null) fail('E_HYA_RUNTIME_BINDING', link.binding, 'conflicting bindings address the same asset slot'); assigned.set(slot, null); values.set(slot, null); continue;}
      const asset = this.assets.get(definition.part)!.document.assets.find(asset => asset.id === id);
      if (asset?.kind !== definition.kind) fail('E_HYA_RUNTIME_BINDING', link.binding, 'selected resource is absent or has the wrong kind');
      if (assigned.has(slot) && assigned.get(slot) !== id) fail('E_HYA_RUNTIME_BINDING', link.binding, 'conflicting bindings address the same asset slot');
      assigned.set(slot, id); values.set(slot, JSON.stringify([definition.part, this.resolveManualAsset(definition.part, id)]));
    }
    const owners = new Set<string>();
    for (const part of this.ordered) if (part.kind === 'state' && this.stateResourceLinks.has(part.id)) {
      const poses = context.values.get('state:' + part.id) as readonly StateMachinePose[];
      for (const pose of poses) for (const entry of pose.channels) {
        const slot = this.stateResourceLinks.get(part.id)!.get(entry.channel.id); if (!slot || entry.value === null) continue;
        if (owners.has(slot)) fail('E_STATE_MACHINE_CHANNEL_RESOURCE_SWITCH_OVERLAP', entry.channel.id, 'independent state owners overlap the same resource target'); owners.add(slot);
        this.validateStateResource(slot, entry.value, entry.channel.id); const definition = this.resourceSlots.get(slot)!, id = entry.value as string;
        values.set(slot, JSON.stringify([definition.part, definition.kind === 'artboard' ? id : this.resolveManualAsset(definition.part, id)]));
      }
    }
    return Object.freeze([...values].map(([slot, id]) => Object.freeze({slot, id})));
  }
  private validateStateResource(slot: string, value: unknown, channel: string): void {
    if (value === null) return;
    const definition = this.resourceSlots.get(slot), part = definition && this.ordered.find(part => part.id === definition.part);
    if (!definition || part?.kind !== 'layout' || typeof value !== 'string' || !value || (definition.kind === 'artboard' ? !part.document.artboards.some(board => board.id === value) : !part.document.assets.some(asset => asset.id === value && asset.kind === definition.kind)))
      fail('E_HYA_RUNTIME_REFERENCE', '$.state.resources.' + channel, 'selected state resource is absent or has the wrong kind');
  }
  private selectedAsset(part: string, id: string): string | null {
    const value = this.resources?.selection(JSON.stringify([part, id])); return value === null ? null : value ? (JSON.parse(value) as [string, string])[1] : this.resolveManualAsset(part, id);
  }
  private resolveManualAsset(part: string, id: string, choices = this.preparedManual ?? this.manualChoices): string {
    const seen = new Set<string>(); let current = id;
    while (true) {const next = choices.get(JSON.stringify([part, 'asset', current])); if (next === undefined || next === current) return current;
      if (seen.has(current)) fail('E_HYA_RUNTIME_REFERENCE', '$.data.replaceResource', 'replacement asset cycle'); seen.add(current); current = next;}
  }
  private nodeBindings(part: Extract<Part, {kind: 'layout'}>, context: LayoutTextContext): PreparedLayoutNodeBindings {
    const result: {items?: readonly RuntimeValue[]; inputs?: Record<string, RuntimeValue>; replacement?: string | null;scopes?:Record<string,readonly string[]>;itemScope?:string} = {};
    for (const link of this.linkIndex.get(JSON.stringify([part.id, 'layout-node', context.artboardId, context.node.id])) ?? []) {
      const data = this.dataOwners.get(link.data)!, value = data.readBindingPrepared(link.binding, this.context(part, context, link.data));
      if (link.path[0] === 'items') {
        if (!Array.isArray(value)) fail('E_HYA_RUNTIME_BINDING', link.binding, 'list binding must be an array');
        const modelItems = data.bindingHasModelItems(link.binding, this.context(part, context, link.data));
        if(modelItems)result.itemScope=link.data;
        result.items = value.map(value => modelItems && typeof value === 'string' ? Object.freeze({id: value}) : value);
      } else if (link.path[0] === 'context') {
        const source=this.ordered.find(part=>part.id===link.data) as Extract<Part,{kind:'data'}>,component=source.document.components.find(c=>c.id===link.path[1])!;
        const selected=data.componentInstance(component.id)??value;
        if(typeof selected!=='string'||!source.document.instances.some(i=>i.id===selected&&i.model===component.model))fail('E_HYA_RUNTIME_BINDING',link.binding,'component context must select an instance of its declared model');
        const current=result.scopes?.[link.data]??[];
        if(current.some(id=>source.document.instances.find(i=>i.id===id)?.model===component.model&&id!==selected))fail('E_HYA_RUNTIME_BINDING',link.binding,'one component context cannot select two instances of the same model');
        (result.scopes??={})[link.data]=Object.freeze([...new Set([...current,selected])]);
      } else if (link.path[0] === 'inputs') (result.inputs ??= {})[link.path[1]!] = value;
      else {if (value !== null && typeof value !== 'string') fail('E_HYA_RUNTIME_BINDING', link.binding, 'replacement artboard must be an ID or nullable clear'); result.replacement = value;}
    }
    if (context.node.kind === 'component' && context.node.component) {
      const slot = JSON.stringify([part.id, 'component', context.artboardId, context.node.id]), state = this.resources?.selection(slot); if (state !== undefined) result.replacement = state === null ? null : (JSON.parse(state) as [string, string])[1];
      const replacement = (this.preparedManual ?? this.manualChoices).get(slot);
      if (replacement !== undefined && (result.replacement === undefined ? context.node.component.artboard : result.replacement) === context.node.component.artboard) result.replacement = replacement;
    }
    return result;
  }
  private context(part: Extract<Part, {kind: 'layout'}>, context: LayoutTextContext, dataPart:string): readonly string[] {
    const item = context.item && typeof context.item === 'object' && 'id' in context.item ? (context.item as {id?: unknown}).id : undefined;
    return [...(context.scopes?.[dataPart] ?? []), ...(typeof item === 'string' && (context.itemScope===undefined||context.itemScope===dataPart) ? [item] : []), ...(part.contexts?.[context.instanceId] ?? [])];
  }
  private resolve(reference: Reference, kind: 'instance' | 'binding' | 'group' | 'component'): Readonly<{part: string; id: string}> {
    this.live(); const id = typeof reference === 'string' ? reference : reference.id;
    const matches = [...this.identities.get(kind)?.get(id) ?? []].filter(part => typeof reference === 'string' || part === reference.part);
    if (matches.length !== 1) fail('E_HYA_RUNTIME_REFERENCE', '$.data.' + kind, matches.length ? 'ambiguous unqualified data ID; provide {part,id}' : 'unknown data ID');
    return Object.freeze({part: matches[0]!, id});
  }
  private intent(id: number, commands: readonly RoutedCommand[]): Intent {
    const value = copy(commands), {bytes, nodes} = measure(value); this.capacity(bytes, nodes);
    return Object.freeze({id, commands: value, bytes, nodes});
  }
  private capacity(bytes: number, nodes: number): void {if (bytes + this.queuedBytes > 64 * 1024 * 1024 || nodes + this.queuedNodes > 1_000_000) fail('E_HYA_RUNTIME_LIMIT', '$.data.queue', 'cross-part intents exceed the original composition ceilings');}
  private enqueue(intent: Intent,notify=true): void {this.live(); this.queue.push(intent); this.queuedBytes += intent.bytes; this.queuedNodes += intent.nodes; if(notify)this.invalidate('data');}
  private nextTransaction(): number {if (!Number.isSafeInteger(this.transaction + 1)) fail('E_HYA_RUNTIME_LIMIT', '$.data.transaction', 'transaction identity exhausted'); return ++this.transaction;}
  private dataPreparing(): boolean {return [...this.dataOwners.values()].some(owner => owner.stats.preparing);}
  private live(): void {if (this.disposed) fail('E_HYA_RUNTIME_DISPOSED', '$.player', 'composition owner is disposed');}
  private invalidate(reason: string): void {try {this.host.invalidate(reason);} catch (error) {this.report(error);}}
  private report(error: unknown, id?: number): void {try {this.host.diagnostic?.(error, id);} catch {/* Diagnostics cannot resend a committed frame. */}}
}

function order(parts: readonly Part[]): readonly Part[] {
  if (parts.length > 16 || new Set(parts.map(part => part.id)).size !== parts.length) fail('E_HYA_RUNTIME_LIMIT', '$.parts', 'invalid compiled part identities/count');
  const found = new Map(parts.map(part => [part.id, part])), result: Part[] = [], active = new Set<string>(), done = new Set<string>();
  const visit = (part: Part): void => {if (done.has(part.id)) return; if (active.has(part.id)) fail('E_HYA_RUNTIME_REFERENCE', '$.parts', 'compiled dependency cycle'); active.add(part.id);
    for (const id of part.dependencies) {const dependency = found.get(id); if (!dependency) fail('E_HYA_RUNTIME_REFERENCE', '$.parts', 'missing compiled dependency'); visit(dependency);}
    active.delete(part.id); done.add(part.id); result.push(part);}; parts.forEach(visit); return Object.freeze(result);
}
function compileLinks(definition: ProductionCompositionDefinition): readonly Link[] {
  const targets = new Map(definition.targets.map(target => [target.id, target])), parts = new Map(definition.parts.map(part => [part.id, part]));
  if (targets.size !== definition.targets.length || targets.size > 100_000) fail('E_HYA_RUNTIME_REFERENCE', '$.targets', 'duplicate/excessive targets');
  for (const target of targets.values()) {
    const part = parts.get(target.part), address = target.address;
    const exists = target.kind === 'text-block' ? part?.kind === 'layout' && address.length === 1 && part.document.textBlocks.some(block => block.id === address[0])
      : target.kind === 'layout-node' ? part?.kind === 'layout' && address.length === 2 && part.document.artboards.find(board => board.id === address[0])?.nodes.some(node => node.id === address[1])
      : target.kind === 'audio-cue' ? part?.kind === 'audio' && address.length === 1 && part.document.cues.some(value => value.id === address[0])
      : target.kind === 'interaction-target' ? part?.kind === 'interaction' && address.length === 1 && part.document.targets.some(value => value.id === address[0])
      : target.kind === 'semantic-node' ? part?.kind === 'semantics' && address.length === 1 && part.document.nodes.some(value => value.id === address[0])
      : target.kind === 'animation-node' ? part?.kind === 'core' && address.length === 1 && part.document.nodes.some(node => node.id === address[0])
      : target.kind === 'asset' && part?.kind === 'layout' && address.length === 1 && part.document.assets.some(asset => asset.id === address[0])
      || target.kind === 'state-input' && part?.kind === 'state' && address.length === 2 && part.document.stateMachines.find(machine => machine.id === address[0])?.inputs.some(input => input.id === address[1]);
    if (!exists) fail('E_HYA_RUNTIME_REFERENCE', '$.targets.' + target.id, 'compiled target is absent or has the wrong address/kind');
  }
  const result: Link[] = [];
  for (const data of definition.parts) if (data.kind === 'data') for (const binding of data.document.bindings) {
    const target = targets.get(binding.target), part = target && parts.get(target.part), path = binding.targetPath;
    if (!target || !part || target.part !== data.id && !data.dependencies.includes(target.part)) fail('E_HYA_RUNTIME_REFERENCE', binding.id, 'binding target/dependency is absent');
    if (target.kind === 'state-input') {
      if (part.kind !== 'state' || path.length !== 1 || path[0] !== 'value' || !part.roots.includes(target.address[0]!)
        || !part.document.stateMachines.find(machine => machine.id === target.address[0])?.inputs.some(input => input.id === target.address[1])) fail('E_HYA_RUNTIME_BINDING', binding.id, 'unsupported/missing state-input target');
    } else if (target.kind === 'text-block') {
      const block = part.kind === 'layout' && part.document.textBlocks.find(block => block.id === target.address[0]);
      if (!block || !['strings', 'selections', 'cursors', 'styles'].includes(path[0]!) || path.length !== (path[0] === 'styles' ? 3 : 2)) fail('E_HYA_RUNTIME_BINDING', binding.id, 'unsupported text target path');
      if (path[0] === 'strings' && !block.runs.some(run => run.valuePort === path[1]) && block.input?.valuePort !== path[1]
        || path[0] === 'selections' && block.input?.selectionPort !== path[1] || path[0] === 'cursors' && block.input?.cursorPort !== path[1]
        || path[0] === 'styles' && !block.runs.some(run => run.style === path[1])) fail('E_HYA_RUNTIME_BINDING', binding.id, 'unknown text value/selection/cursor/style port');
      if (path[0] === 'styles' && !['fontAssets', 'fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'lineHeight', 'tracking', 'alignment', 'verticalAlignment', 'direction', 'language', 'script', 'axes', 'features', 'fills', 'strokes', 'background'].includes(path[2]!)) fail('E_HYA_RUNTIME_BINDING', binding.id, 'unadmitted text style field');
    } else if (target.kind === 'interaction-target') {
      if (binding.direction !== 'write' || path.length !== 1 || path[0] !== 'value') fail('E_HYA_RUNTIME_BINDING', binding.id, 'interaction sink requires its explicit write value binding');
    } else if (target.kind === 'animation-node') {
      if (part.kind !== 'core' || binding.direction !== 'read') fail('E_HYA_RUNTIME_BINDING', binding.id, 'core visual properties currently require read bindings');
    } else if (target.kind === 'asset') {
      if (part.kind !== 'layout' || path.length !== 1 || path[0] !== 'value') fail('E_HYA_RUNTIME_BINDING', binding.id, 'asset binding needs the value selector path');
    } else {
      const node = part.kind === 'layout' && part.document.artboards.find(board => board.id === target.address[0])?.nodes.find(node => node.id === target.address[1]);
      if (!node || !(node.kind === 'list' && path.length === 1 && path[0] === 'items'
        || node.kind === 'component' && path[0] === 'inputs' && path.length === 2 && node.component?.exposedInputs?.includes(path[1]!)
        || node.kind === 'component' && path[0] === 'artboard' && path.length === 1
        || node.kind === 'component' && path[0] === 'context' && path.length === 2 && binding.direction === 'read' && data.document.components.some(component=>component.id===path[1]))) fail('E_HYA_RUNTIME_BINDING', binding.id, 'unsupported scoped list/component target path');
    }
    if (binding.direction !== 'write') result.push(Object.freeze({data: data.id, binding: binding.id, target, path}));
  }
  return Object.freeze(result);
}
function preflight(parts: readonly Part[], stateResources: ReadonlyMap<string, ReadonlyMap<string, string>>): void {
  for (const part of parts) {
    if (!['core', 'data', 'state', 'layout', 'interaction', 'semantics', 'audio'].includes(part.kind)) fail('E_HYA_RUNTIME_CAPABILITY', '$.parts.' + part.id, 'part is not connected to this compiled graph yet');
    if (part.kind === 'layout' && part.document.artboards.some(board => board.nodes.some(node => node.kind === 'text')) && !part.fonts) fail('E_HYA_RUNTIME_HOST_PORT', '$.parts.' + part.id + '.fonts', 'real text requires an explicit prepared font host');
    if (part.kind === 'data') for (const converter of part.document.converters) for (const operation of converter.operations) if (operation.op === 'custom' && !part.options?.converter?.protocols.has(operation.protocol as string)) fail('E_HYA_RUNTIME_HOST_PORT', '$.parts.' + part.id + '.converters.' + converter.id, 'custom converter protocol is not available');
    if (part.kind === 'state') {
      if (new Set(part.roots).size !== part.roots.length || part.roots.some(id => !part.document.stateMachines.some(machine => machine.id === id))) fail('E_HYA_RUNTIME_REFERENCE', '$.parts.' + part.id + '.roots', 'invalid root state machines');
      if (part.document.channels.some(channel => channel.policy === 'ownership' && channel.valueKind !== 'callback' && !stateResources.get(part.id)?.has(channel.id)) && !part.ownership) fail('E_HYA_RUNTIME_HOST_PORT', '$.parts.' + part.id + '.ownership', 'ownership channels require a resource ownership host');
      const walk = (value: unknown): void => {if (!value || typeof value !== 'object') return; const object = value as Record<string, unknown>;
        if (object.kind === 'nested' && !part.nested) fail('E_HYA_RUNTIME_HOST_PORT', '$.parts.' + part.id + '.nested', 'nested motions require the compiled nested owner');
        if (['custom', 'observable'].includes(String(object.kind)) && !part.conditions?.protocols.has(String(object.protocol))) fail('E_HYA_RUNTIME_HOST_PORT', '$.parts.' + part.id + '.conditions', 'condition protocol is unavailable');
        Object.values(object).forEach(walk);}; walk(part.document);
    }
  }
}
function copy<T>(value: T): T {return snapshotPlainTextData(value, '$.composition', (path, message, limit) => fail(limit ? 'E_HYA_RUNTIME_LIMIT' : 'E_HYA_RUNTIME_FRAME', path, message), {strict: true, maxBytes: 64 * 1024 * 1024}) as T;}
function fail(code: string, path: string, message: string): never {throw new ProductionFrameError(code, path, message);}
function isDataError(error: unknown): boolean {return !!error && typeof error === 'object' && 'code' in error && ['E_DATA_RUNTIME_PATH', 'E_DATA_RUNTIME_TYPE', 'E_DATA_RUNTIME_LIMIT'].includes(String(error.code));}
function measure(value: unknown): Readonly<{bytes: number; nodes: number}> {
  let nodes = 0; const stack: unknown[] = [value]; while (stack.length) {const value = stack.pop(); nodes++; if (value && typeof value === 'object') for (const child of Object.values(value)) stack.push(child);}
  return {nodes, bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength};
}
