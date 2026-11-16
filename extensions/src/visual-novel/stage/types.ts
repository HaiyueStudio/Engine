import type { HyaPlayerHost, HyaFrame, HyaFrameRequest } from '../../hya-player';
import type { NarrativeVariables } from '../../narrative/types';
import type { StoryCueGroups, StorySlot } from '../story/types';

export interface StageSlot extends StorySlot { readonly stateId?: string }
export interface StageView {
  readonly viewport: readonly [number, number];
  readonly dpr: number;
}
export interface StageFrame extends StageView {
  readonly sequence: number;
  readonly deltaSeconds: number;
}
export interface StageState {
  readonly data?: NarrativeVariables;
  readonly time?: number;
}
/** A range on the original HYA transport. The timer lives on the stage frame clock. */
export interface StageTransition {
  readonly fromTime: number;
  readonly toTime: number;
  readonly stateId?: string;
}
export interface StageAsset {
  readonly source: unknown;
  readonly bytes: number;
  readonly designSize: readonly [number, number];
  readonly playback?: { readonly mode: 'loop' | 'once'; readonly duration: number } | { readonly mode: 'hold' };
  readonly states?: Readonly<Record<string, StageState>>;
  readonly transitions?: Readonly<Record<string, StageTransition>>;
  readonly parameters?: Readonly<Record<string, {
    readonly instance: string | Readonly<{ part: string; id: string }>;
    readonly path: readonly (string | number)[];
  }>>;
  /** Per-instance ports for the original Player. Shared resources are separate leases. */
  readonly host?: (slot: StageSlot) => Partial<HyaPlayerHost>;
}
export interface StageAssetLease {
  readonly value: StageAsset;
  release(): void;
}
export interface StagePlayer {
  advance(request: HyaFrameRequest): HyaFrame;
  seek(time: number): HyaFrame;
  setVisible(visible: boolean): void;
  configure(data: NarrativeVariables): void;
  resize(view: StageView): readonly [number, number];
  takeInvalidation(): boolean;
  dispose(): void;
}
export interface StagePort {
  acquire(slot: StorySlot, signal: AbortSignal): Promise<StageAssetLease>;
  create(asset: StageAsset, slot: StageSlot, instance: number, signal: AbortSignal, fail: (error: unknown) => void): Promise<StagePlayer>;
  invalidate?(): void;
}
export interface StageOptions {
  readonly port: StagePort;
  readonly concurrency?: number;
  readonly maxPreloadBytes?: number;
  readonly prepareTimeoutMs?: number;
  readonly waitTimeoutSeconds?: number;
  readonly onError?: (error: unknown) => void;
  readonly onDispose?: () => void;
}
export interface StageAction {
  readonly sessionId: string;
  readonly actionId: number;
  readonly cues: StoryCueGroups;
  readonly reducedMotion?: boolean;
  readonly signal?: AbortSignal;
}
export interface StageCompletion {
  readonly sessionId: string;
  readonly actionId: number;
}
export interface StageWaiting {
  readonly group: number;
  readonly kind: 'resources' | 'cues';
  readonly durationRemaining: number;
  readonly events: readonly { readonly slotId: string; readonly name: string }[];
}
