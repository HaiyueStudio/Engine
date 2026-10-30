/** ADR 0134 named design, not installed package declarations or G11 implementation evidence. */
declare module '@haiyue/extensions/hya-player' {
  import type {HyaCompositionDocument, HyaCompositionParseOptions, HyaCompositionValue} from '@haiyue/animation-spec/hya-production';
  import type {Scene} from '@haiyue/engine/scene';
  import type {GuiSystem, GuiRoot} from '@haiyue/engine/gui';
  import type {InteractionActionPort, InteractionGeometryPort, RoutedInteractionEvent} from '@haiyue/extensions/animation';
  import type {HyaLayoutFrame} from '@haiyue/extensions/hya-layout';
  import type {HyaFontPort} from '@haiyue/extensions/hya-text';
  import type {HyaAudioHost} from '@haiyue/extensions/hya-audio';
  import type {HyaData, HyaSemanticHost, HyaSemanticSnapshot, createHyaData} from '@haiyue/extensions/hya-data';
  export interface HyaDiagnostic {readonly code: string; readonly path: string; readonly capability: string; readonly message: string;}
  export interface HyaResourceHandle {readonly value: unknown; readonly generation: number; readonly bytes: number; release(): void;}
  export interface HyaResourcePort {
    acquire(request: Readonly<{kind: 'font' | 'image' | 'audio' | 'blob' | 'artboard'; part: string; asset: string; integrity: string; signal: AbortSignal}>): Promise<HyaResourceHandle>;
  }
  export interface HyaFrameRequest {
    readonly sequence: number; readonly deltaSeconds: number;
    readonly viewport: readonly [number, number]; readonly dpr: number;
    readonly input?: readonly Readonly<Omit<RoutedInteractionEvent, 'sequence' | 'phase' | 'currentTarget' | 'target'> & {target?: string; pointerType?: 'mouse' | 'touch' | 'pen'; consumed: boolean}>[];
  }
  export interface HyaFrame {
    readonly sequence: number; readonly generation: number; readonly time: number;
    readonly ready: boolean; readonly diagnostics: readonly HyaDiagnostic[];
    readonly changed: Readonly<{layout: boolean; geometry: boolean; presentation: boolean}>;
    readonly layout: HyaLayoutFrame | null; readonly semantics: HyaSemanticSnapshot | null;
    readonly events: readonly Readonly<{id: string; part: string; instance: string; time: number; sequence: number; kind: string; target: string; payload?: HyaCompositionValue}>[];
  }
  export interface HyaPlayerHost {
    readonly resources?: HyaResourcePort; readonly fonts?: HyaFontPort; readonly audio?: HyaAudioHost; readonly semantics?: HyaSemanticHost;
    readonly capabilities: ReadonlySet<string>;
    readonly actions?: InteractionActionPort; readonly geometry?: InteractionGeometryPort;
    readonly converter?: NonNullable<Parameters<typeof createHyaData>[1]>['converter'];
    readonly conditions?: Readonly<{protocols: ReadonlySet<string>; begin(transaction: number): void; invoke(request: Readonly<{protocol: string; port: string; arguments: Readonly<Record<string, HyaCompositionValue>>}>): HyaCompositionValue; commit(transaction: number): void; rollback(transaction: number): void}>;
    invalidate(reason: string): void;
    events?(events: HyaFrame['events']): void;
    diagnostic?(diagnostic: HyaDiagnostic): void;
  }
  export interface HyaPlayerOptions {
    readonly host: HyaPlayerHost; readonly scene?: Scene; readonly gui?: GuiSystem; readonly root?: GuiRoot; readonly mode: 'evaluate' | 'render';
    readonly viewport: readonly [number, number]; readonly dpr?: number; readonly signal?: AbortSignal;
    readonly parse?: HyaCompositionParseOptions;
  }
  export interface HyaPlayer {
    readonly status: 'running' | 'paused' | 'stopped' | 'disposed'; readonly document: HyaCompositionDocument;
    readonly data: Pick<HyaData, 'read' | 'readBinding' | 'run' | 'subscribe' | 'rebind' | 'replaceResource'> | null;
    readonly lastFrame: HyaFrame | null;
    advance(request: HyaFrameRequest): HyaFrame;
    seek(time: number): HyaFrame;
    setRate(rate: number): void;
    play(): void; pause(): void; resume(): void; stop(): void;
    unlockAudio(): Promise<void>;
    dispose(): void;
  }
  export function createHyaPlayer(source: unknown, options: HyaPlayerOptions): Promise<HyaPlayer>;
}

declare module '@haiyue/extensions/hya-text' {
  import type {ResponsiveLayoutDocument} from '@haiyue/animation-spec/hya-production';
  export interface HyaTextRequest {
    readonly editingViewport?: boolean;
    readonly block: string; readonly dpr?: number; readonly strings?: Readonly<Record<string, string>>;
    readonly rasterOrigin?: readonly [number, number];
    readonly selections?: Readonly<Record<string, readonly [number, number]>>;
    readonly cursors?: Readonly<Record<string, number>>;
    readonly styles?: Readonly<Record<string, Partial<ResponsiveLayoutDocument['textStyles'][number]>>>;
    readonly constraints?: Readonly<Partial<{width: Readonly<{mode: 'exact' | 'at-most' | 'unbounded'; value?: number}>; height: Readonly<{mode: 'exact' | 'at-most' | 'unbounded'; value?: number}>}>>;
  }
  export interface HyaGlyph {
    readonly id: number; readonly clusterUtf16: number; readonly sequence: string;
    readonly rect: readonly [number, number, number, number]; readonly advance: number;
    readonly transform: readonly [number, number, number, number, number, number]; readonly opacity: number;
    readonly paint: Readonly<{kind: 'outline'; commands: string; values: readonly number[]}> | Readonly<{kind: 'bitmap'; source: Readonly<{value: unknown; generation: number; bytes: number}>; uv: readonly [number, number, number, number]}>;
  }
  export interface HyaGlyphRun {readonly font: string; readonly style: ResponsiveLayoutDocument['textStyles'][number]; readonly glyphs: readonly HyaGlyph[];}
  export interface HyaTextResult {
    readonly block: string; readonly size: readonly [number, number]; readonly contentSize: readonly [number, number];
    readonly runs: readonly HyaGlyphRun[];
    readonly lines: readonly Readonly<{rect: readonly [number, number, number, number]; startUtf16: number; endUtf16: number}>[];
    readonly editing?: Readonly<{
      text: string;
      carets: readonly Readonly<{offset: number; line: number; rect: readonly [number, number, number, number]}>[];
      cells: readonly Readonly<{start: number; end: number; line: number; rect: readonly [number, number, number, number]}>[];
    }>;
    readonly controls: readonly Readonly<{kind: 'selection' | 'cursor'; rect: readonly [number, number, number, number]; radius?: number}>[];
  }
  export interface HyaFontPort {
    acquire(document: ResponsiveLayoutDocument, signal: AbortSignal): Promise<Readonly<{shape(request: HyaTextRequest): HyaTextResult; release(): void}>>;
  }
  export interface HyaTextShaper {shape(request: HyaTextRequest): HyaTextResult; dispose(): void;}
  export function createHyaTextShaper(document: ResponsiveLayoutDocument, fonts: HyaFontPort, options?: Readonly<{signal?: AbortSignal}>): Promise<HyaTextShaper>;
}

declare module '@haiyue/extensions/hya-layout' {
  import type {ResponsiveLayoutDocument, HyaCompositionValue} from '@haiyue/animation-spec/hya-production';
  import type {HyaTextResult, HyaTextShaper} from '@haiyue/extensions/hya-text';
  export interface HyaLayoutRequest {
    readonly viewport: readonly [number, number]; readonly dpr: number; readonly time: number;
    readonly strings?: Readonly<Record<string, string>>; readonly lists?: Readonly<Record<string, readonly HyaCompositionValue[]>>;
    readonly selections?: Readonly<Record<string, readonly [number, number]>>; readonly cursors?: Readonly<Record<string, number>>;
    readonly styles?: Readonly<Record<string, Partial<ResponsiveLayoutDocument['textStyles'][number]>>>;
    readonly scroll?: Readonly<Record<string, Readonly<{offset: readonly [number, number]; velocity?: readonly [number, number]; active?: boolean; settled?: boolean}>>>;
    readonly componentInputs?: Readonly<Record<string, Readonly<Record<string, HyaCompositionValue>>>>;
    readonly componentReplacements?: Readonly<Record<string, string>>;
    readonly componentEvents?: Readonly<Record<string, readonly Readonly<{name: string; payload?: HyaCompositionValue}>[]>>;
    readonly componentStateTimes?: Readonly<Record<string, number>>;
  }
  export interface HyaLayoutNode {
    readonly part: string; readonly instance: string; readonly artboard: string; readonly node: string;
    readonly kind: 'container' | 'leaf' | 'text' | 'image' | 'component' | 'list' | 'n-slice';
    /** Fitted layout coordinates to the shared viewport; rect, glyph and clip geometry remain local. */
    readonly transform?: readonly [number, number, number, number, number, number];
    readonly rect: readonly [number, number, number, number]; readonly clip?: readonly [number, number, number, number]; readonly opacity: number;
    readonly clipShapes?: readonly Readonly<{rect: readonly [number, number, number, number]; radii: readonly [number, number, number, number]}>[];
    readonly text?: HyaTextResult; readonly source?: Readonly<{kind: 'asset' | 'node'; id: string}>;
    readonly background?: readonly [number, number, number, number]; readonly borderColor?: readonly [number, number, number, number];
    readonly borderWidth: readonly [number, number, number, number]; readonly cornerRadius: readonly [number, number, number, number];
    readonly nSlice?: readonly Readonly<{rect: readonly [number, number, number, number]; uv: readonly [number, number, number, number]; tile: 'stretch' | 'repeat' | 'mirror'}>[];
  }
  export interface HyaLayoutFrame {
    readonly revision: number; readonly viewport: readonly [number, number]; readonly dpr: number; readonly nodes: readonly HyaLayoutNode[];
    readonly instances: readonly Readonly<{part: string; id: string; artboard: string; parent?: string; host?: string; rect: readonly [number, number, number, number]; transform?: readonly [number, number, number, number, number, number]; times: readonly number[]; mixWeight: number; inputs: Readonly<Record<string, HyaCompositionValue>>; events: readonly Readonly<{name: string; payload?: HyaCompositionValue}>[]}>[];
  }
  export interface HyaLayout {evaluate(request: HyaLayoutRequest): HyaLayoutFrame; dispose(): void;}
  export function createHyaLayout(document: ResponsiveLayoutDocument, options?: Readonly<{text?: HyaTextShaper; signal?: AbortSignal}>): HyaLayout;
}

declare module '@haiyue/extensions/hya-data' {
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
  export function createHyaData(document: HyaDataBindingDocument, options?: Readonly<{signal?: AbortSignal; resources?: HyaResourcePort; resourceCatalogue?: readonly Readonly<{kind: 'image' | 'artboard' | 'font' | 'blob'; id: string; integrity: string}>[]; converter?: Readonly<{protocols: ReadonlySet<string>; begin(transaction: number): void; invoke(request: Readonly<{protocol: string; port: string; value: HyaCompositionValue; arguments: Readonly<Record<string, HyaCompositionValue>>}>): HyaCompositionValue; commit(transaction: number): void; rollback(transaction: number): void}>}>): HyaData;
  export function createHyaSemantics(document: HyaSemanticsDocument, options: Readonly<{bindings: Pick<HyaData, 'readBinding'>; host?: HyaSemanticHost; action(target: string, action: 'tap' | 'increase' | 'decrease' | 'focus'): void}>): HyaSemantics;
}

declare module '@haiyue/extensions/hya-audio' {
  import type {HyaAudioEventDocument, HyaCompositionValue} from '@haiyue/animation-spec/hya-production';
  export type HyaAudioResource = HyaAudioEventDocument['resources'][number];
  export interface HyaAudioRequest {
    readonly domain: 'composition' | 'state' | 'event'; readonly time: number; readonly rate: number;
    readonly operation: 'advance' | 'seek' | 'pause' | 'resume' | 'stop';
  }
  export interface HyaAudioTrace {readonly sequence: number; readonly operation: string; readonly token: string; readonly resource: string; readonly sampleFrame: number; readonly details: Readonly<Record<string, HyaCompositionValue>>;}
  export interface HyaAudioHost {
    readonly profile: 'sample-accurate' | 'html-media-restricted'; readonly sampleRate: number;
    readonly state: 'running' | 'suspended' | 'closed';
    nowFrame(): number; unlock(): Promise<void>;
    resolve?(resource: HyaAudioResource, signal: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
    decode(resource: HyaAudioResource, signal: AbortSignal, encoded: ArrayBuffer): Promise<Readonly<{value: unknown; sampleRate: number; channels: number; frames: number; bytes: number; release(): void}>>;
    /** gain already includes the runtime-owned bus chain; bus identifies routing/trace, not a second gain multiplier. */
    schedule(request: Readonly<{token: string; value: unknown; startFrame: number; offsetFrame: number; stopFrame?: number; durationFrames?: number; gain: number; rate: number; bus: string; loop?: Readonly<{startFrame: number; endFrame: number}>; onEnded(): void}>): Readonly<{stop(frame?: number): void; setGain(gain: number, frame?: number): void; setRate(rate: number, frame?: number): void; release(): void}>;
  }
  export interface HyaAudio {
    /** advance/seek use the selected domain's time. pause/resume/stop operate on the owner; control request times do not advance clocks. */
    update(request: HyaAudioRequest): Promise<void>;
    play(cue: string, domain?: HyaAudioRequest['domain']): Promise<void>;
    /** Await outstanding async operations before changing a bus synchronously. unlock must be called from the actual user gesture. */
    stop(cue: string): Promise<void>; setBusGain(bus: string, gain: number): void; unlock(): Promise<void>;
    readonly trace: readonly HyaAudioTrace[]; dispose(): void;
  }
  export function createHyaAudio(document: HyaAudioEventDocument, host: HyaAudioHost, options?: Readonly<{signal?: AbortSignal}>): Promise<HyaAudio>;
  export function createBrowserHyaAudioHost(context: AudioContext): Promise<HyaAudioHost>;
}
