import type {HyaCompositionDocument, HyaCompositionParseOptions, HyaCompositionValue} from '@haiyue/animation-spec/hya-production';
import type {Scene} from '@haiyue/engine/scene';
import type {GuiSystem, GuiRoot} from '@haiyue/engine/gui';
import type {InteractionActionPort, InteractionGeometryPort, RoutedInteractionEvent} from '@haiyue/extensions/animation';
import type {HyaLayoutFrame} from '@haiyue/extensions/hya-layout';
import type {HyaFontPort} from '@haiyue/extensions/hya-text';
import type {HyaAudioHost} from '@haiyue/extensions/hya-audio';
import type {HyaData, HyaSemanticHost, HyaSemanticSnapshot, createHyaData} from './hya-data.js';
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
  /** Platform image decoding/snapshotting. Returned leases are released by the original texture owner. */
  readonly images?: Readonly<{
    decode(bytes: Uint8Array, signal: AbortSignal): Promise<Readonly<{value: ImageBitmap; release(): void}>>;
    snapshot(source: unknown, signal: AbortSignal): Promise<Readonly<{value: ImageBitmap; release(): void}>>;
  }>;
  readonly capabilities: ReadonlySet<string>;
  readonly actions?: InteractionActionPort; readonly geometry?: InteractionGeometryPort;
  readonly converter?: NonNullable<Parameters<typeof createHyaData>[1]>['converter'];
  readonly conditions?: Readonly<{protocols: ReadonlySet<string>; begin(transaction: number): void; invoke(request: Readonly<{protocol: string; port: string; arguments: Readonly<Record<string, HyaCompositionValue>>}>): HyaCompositionValue; commit(transaction: number): void; rollback(transaction: number): void}>;
  invalidate(reason: string): void;
  events?(events: HyaFrame['events']): void;
  diagnostic?(diagnostic: HyaDiagnostic): void;
}
export interface HyaPlayerOptions {
  /** Borrow an existing G04 region; the host owns its bounds, policy, GUI mapping and disposal. */
  readonly region?: ReturnType<Scene['renderView']['createRegion']>;
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

export {createHyaPlayer} from './animation/production/Player.js';
