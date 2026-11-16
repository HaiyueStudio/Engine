import type { HaiyueEngine } from '@haiyue/engine';
import type { OwnerSafeAudioMixer } from '@haiyue/engine/audio';
import type { I18n, LocalePack, I18nParams } from '@haiyue/extensions/i18n';
import type { NarrativeDefinition, NarrativeSnapshot, NarrativeVariables } from '@haiyue/extensions/narrative';

type Asset = { readonly kind: 'hya' | 'audio' | 'image'; readonly path: string };
type Slot = { readonly id: string; readonly assetId: string; readonly bounds: readonly [number,number,number,number];
  readonly order: number; readonly time?: number; readonly variantId?: string; readonly data?: NarrativeVariables;
  readonly fit?: 'contain' | 'cover' | 'stretch'; readonly stateId?: string };
type Preferences = { readonly textSpeed: number; readonly fontScale: number; readonly highContrast: boolean;
  readonly reducedMotion: boolean; readonly voiceVolume: number };
type History = { readonly key: string; readonly lineId: string; readonly textKey: string; readonly params: I18nParams; readonly speakerKey?: string };
type Reading = { readonly nodeId: string | null; readonly lineId: string | null; readonly text: string; readonly speaker: string;
  readonly kind: string | null; readonly locale: string; readonly visible: number; readonly offsets: readonly number[]; readonly preferences: Preferences;
  readonly choices: readonly { readonly id: string; readonly enabled: boolean; readonly text: string }[] };
export interface VisualNovelDefinition {
  readonly schemaVersion: 1;
  readonly narrative: NarrativeDefinition;
  readonly assets: Readonly<Record<string,Asset>>;
  readonly presets: Readonly<Record<string,readonly Slot[]>>;
  readonly cues: Readonly<Record<string, readonly (readonly unknown[])[]>>;
  readonly replays?: Readonly<Record<string, { readonly startLineId: string; readonly endLineId: string }>>;
}
export interface VisualNovelOptions {
  readonly engine: HaiyueEngine;
  readonly i18n: I18n;
  readonly mixer: OwnerSafeAudioMixer;
  readonly assetRoot: URL;
  readonly storage: Storage;
  readonly story: { readonly definition: VisualNovelDefinition; readonly defaultLocale: string;
    readonly locales: Readonly<Record<string,LocalePack>>;
    readonly lines: Readonly<Record<string,{ readonly nodeId: string; readonly textKey: string; readonly voices: Readonly<Record<string,string>> }>> };
  readonly music?: string;
  readonly manualSlots?: readonly string[];
  readonly onError?: (error: unknown) => void;
}
export interface VisualNovelSnapshot {
  readonly schemaVersion: 1;
  readonly narrative: NarrativeSnapshot;
  readonly slots: readonly Slot[];
  readonly history?: readonly Pick<History,'lineId'|'params'>[];
}
export interface VisualNovelView {
  readonly reading: Reading | null;
  readonly history: readonly History[];
  readonly replayId: string | null;
  readonly transitioning: boolean;
  readonly slots: readonly Slot[];
  readonly audio: OwnerSafeAudioMixer['stats'];
  readonly resources: Readonly<Record<string, unknown>> | null;
}
export interface VisualNovelSession {
  readonly view: VisualNovelView;
  start(id: string, initial?: NarrativeVariables): Promise<void>;
  advance(): boolean;
  choose(id: string): boolean;
  setPreferences(patch: Partial<Preferences>): void;
  replayVoice(key: string): Promise<boolean>;
  save(slot: string, request?: { name?: string; thumbnail?: boolean }): Promise<void>;
  load(slot: string): Promise<boolean>;
  continueLatest(): Promise<boolean>;
  listReplays(): readonly string[];
  startReplay(id: string): Promise<void>;
  endReplay(): boolean;
  subscribe(callback: () => void): () => void;
  dispose(): Promise<void>;
}
export declare function createVisualNovel(options: VisualNovelOptions): VisualNovelSession;
export declare function validateVisualNovelDefinition(definition: VisualNovelDefinition): VisualNovelDefinition;
