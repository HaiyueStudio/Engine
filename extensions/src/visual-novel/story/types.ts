import type { NarrativeDefinition, NarrativeVariables } from '../../narrative/types';
import type { LocalePack } from '../../i18n/types';

export type StoryPath = readonly (string | number)[];
export interface StorySource { readonly file: string; readonly path: StoryPath }
export interface StoryDiagnostic extends StorySource {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
}
export interface StoryDocument { readonly file: string; readonly data: unknown }
export interface StoryInputs {
  readonly project: StoryDocument;
  readonly chapters: readonly StoryDocument[];
  readonly locales: Readonly<Record<string, StoryDocument>>;
}

export interface StoryAsset {
  readonly kind: 'hya' | 'image' | 'audio';
  readonly path: string;
}
export interface StorySlot {
  readonly id: string;
  readonly assetId: string;
  readonly bounds: readonly [number, number, number, number];
  readonly order: number;
  readonly variantId?: string;
  readonly fit?: 'contain' | 'cover' | 'stretch';
  readonly time?: number;
  readonly data?: NarrativeVariables;
}
export type StoryWait =
  | { readonly kind: 'duration'; readonly seconds: number }
  | { readonly kind: 'event'; readonly slotId: string; readonly event: string };
type CueMotion = { readonly decorative: boolean };
export type StoryCue =
  | { readonly op: 'show'; readonly presetId: string; readonly slots: readonly StorySlot[] }
  | { readonly op: 'hide'; readonly slotId: string }
  | { readonly op: 'state'; readonly slotId: string; readonly stateId: string }
  | ({ readonly op: 'transition'; readonly slotId: string; readonly transitionId: string; readonly seconds: number } & CueMotion)
  | { readonly op: 'wait'; readonly wait: StoryWait };
export type StoryCueGroups = readonly (readonly StoryCue[])[];

export interface StoryLine {
  readonly nodeId: string;
  readonly textKey: string;
  readonly voices: Readonly<Record<string, string>>;
}
export interface StoryReplay {
  readonly startLineId: string;
  readonly endLineId: string;
}
export interface StoryDefinition {
  readonly schemaVersion: 1;
  readonly narrative: NarrativeDefinition;
  readonly assets: Readonly<Record<string, StoryAsset>>;
  readonly presets: Readonly<Record<string, readonly StorySlot[]>>;
  readonly cues: Readonly<Record<string, StoryCueGroups>>;
  readonly replays?: Readonly<Record<string, StoryReplay>>;
}
export type StoryRouteStep =
  | { readonly nodeId: string; readonly choiceId: string }
  | { readonly nodeId: string; readonly stage: true }
  | { readonly nodeId: string; readonly result: NarrativeVariables };
export interface StoryRoute {
  readonly locale: string;
  readonly initial: NarrativeVariables;
  readonly steps: readonly StoryRouteStep[];
}
export interface AuthoredStory {
  readonly definition: StoryDefinition;
  readonly lines: Readonly<Record<string, StoryLine>>;
  readonly locales: Readonly<Record<string, LocalePack>>;
  readonly routes: Readonly<Record<string, StoryRoute>>;
  readonly defaultLocale: string;
}
export interface StoryCompilation {
  readonly story: AuthoredStory | null;
  readonly diagnostics: readonly StoryDiagnostic[];
}
