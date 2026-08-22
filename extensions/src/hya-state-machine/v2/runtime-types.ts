export type RuntimeValue = number | boolean | string | readonly number[] | null | Readonly<Record<string, unknown>>;
export type RuntimePolicy = 'override' | 'additive' | 'discrete' | 'ownership';

export interface RuntimeChannel {
  readonly id: string; readonly target: string; readonly path: string;
  readonly family: string; readonly valueKind: string; readonly valueSize?: number;
  readonly numericMode?: 'linear' | 'angle-radians';
  readonly defaultValue?: RuntimeValue; readonly policy: RuntimePolicy;
  readonly effectKind?: 'event' | 'audio' | 'script';
}

export interface RuntimeInterpolation {
  readonly kind: 'linear' | 'hold' | 'cubic-ease' | 'cubic-value' | 'elastic';
  readonly controls?: readonly [number, number, number, number];
  readonly outTangent?: readonly number[]; readonly inTangent?: readonly number[];
  readonly easing?: 'in' | 'out' | 'in-out'; readonly amplitude?: number; readonly period?: number;
}

export interface RuntimeKeyframe { readonly time: number; readonly value: RuntimeValue; readonly interpolation?: RuntimeInterpolation }
export interface RuntimeTrack { readonly id: string; readonly channel: string; readonly keys: readonly RuntimeKeyframe[] }
export interface RuntimeClip {
  readonly id: string; readonly duration: number; readonly fps?: number; readonly quantize?: boolean;
  readonly workArea?: Readonly<{ start: number; end: number }>; readonly tracks: readonly RuntimeTrack[];
}

export type RuntimeMotion =
  | Readonly<{ kind: 'clip'; clip: string; speed?: number; speedInput?: string; playback?: PlaybackMode; timeRemapInput?: string }>
  | Readonly<{ kind: 'blend-1d'; input: string; children: readonly Readonly<{ threshold: number; motion: RuntimeMotion }>[] }>
  | Readonly<{ kind: 'blend-2d'; algorithm: 'cartesian' | 'directional'; inputX: string; inputY: string; children: readonly Readonly<{ position: readonly [number, number]; motion: RuntimeMotion }>[] }>
  | Readonly<{ kind: 'blend-additive'; base: RuntimeMotion; children: readonly Readonly<{ motion: RuntimeMotion; weight?: number; weightInput?: string }>[] }>
  | Readonly<{ kind: 'nested'; component: string; speed?: number; timeRemapInput?: string; mixInput?: string; playingInput?: string; inputBindings?: Readonly<Record<string, string>> }>;

export type RuntimeCondition =
  | Readonly<{ kind: 'input'; input: string; comparator: Comparator; value: RuntimeValue }>
  | Readonly<{ kind: 'trigger'; input: string }>
  | Readonly<{ kind: 'observable'; protocol: string; port: string; comparator: Comparator; value: RuntimeValue; arguments?: Readonly<Record<string, RuntimeValue>> }>
  | Readonly<{ kind: 'custom'; protocol: string; port: string; arguments?: Readonly<Record<string, RuntimeValue>> }>;
export type Comparator = 'equal' | 'not-equal' | 'greater' | 'greater-or-equal' | 'less' | 'less-or-equal';
export interface RuntimeEffect { readonly channel: string; readonly phase: 'start' | 'complete'; readonly payload?: RuntimeValue }
export interface RuntimeState { readonly id: string; readonly motion: RuntimeMotion; readonly entryEffects?: readonly RuntimeEffect[]; readonly exitEffects?: readonly RuntimeEffect[] }
export interface RuntimeTransition {
  readonly id: string; readonly from: string; readonly to: string;
  readonly conditionGroups: readonly (readonly RuntimeCondition[])[]; readonly exitTime?: number;
  readonly randomWeight?: number;
  readonly pauseWhenExiting?: boolean; readonly duration: number; readonly destinationOffset?: number;
  readonly interruption?: 'none' | 'source' | 'destination' | 'source-then-destination' | 'destination-then-source';
  readonly exitMotion?: RuntimeMotion;
  readonly interpolation?: RuntimeInterpolation; readonly effects?: readonly RuntimeEffect[];
}
export interface RuntimeLayer {
  readonly id: string; readonly order: number; readonly weight?: number; readonly weightInput?: string;
  readonly mode?: 'override' | 'additive'; readonly mask?: Readonly<{ include?: readonly string[]; exclude?: readonly string[] }>;
  readonly states: readonly RuntimeState[]; readonly transitions: readonly RuntimeTransition[];
}
export interface RuntimeInput { readonly id: string; readonly type: 'number' | 'integer' | 'boolean' | 'trigger'; readonly defaultValue?: number | boolean }
export interface RuntimeMachine { readonly id: string; readonly inputs: readonly RuntimeInput[]; readonly layers: readonly RuntimeLayer[] }
export interface RuntimeComponent {
  readonly id: string; readonly target: string; readonly source: Readonly<{ kind: 'clip'; clip: string } | { kind: 'state-machine'; machine: string }>;
  readonly playback: 'simple' | 'remap' | 'mix' | 'state-machine'; readonly exposedInputs?: readonly string[]; readonly exposedEvents?: readonly string[];
}
export interface RuntimeDocument {
  readonly channels: readonly RuntimeChannel[]; readonly clips: readonly RuntimeClip[];
  readonly stateMachines: readonly RuntimeMachine[]; readonly components?: readonly RuntimeComponent[];
}
export type PlaybackMode = 'one-shot' | 'loop' | 'ping-pong';

export interface TimelineContribution {
  readonly channel: RuntimeChannel; readonly value: RuntimeValue; readonly weight: number;
  readonly layerOrder: number; readonly actionOrder: number; readonly blendMode: 'override' | 'additive';
}
export interface TimelineEffectOccurrence {
  readonly id: string; readonly channel: RuntimeChannel; readonly clipId: string;
  readonly trackId: string; readonly keyIndex: number; readonly occurrenceTime: number; readonly payload: RuntimeValue;
}
export interface TimelineSample { readonly localTime: number; readonly contributions: readonly TimelineContribution[]; readonly effects: readonly TimelineEffectOccurrence[] }

export interface StateMachinePose {
  readonly sequence: number; readonly channels: readonly Readonly<{ channel: RuntimeChannel; value: RuntimeValue }>[];
  readonly effects: readonly TimelineEffectOccurrence[]; readonly settled: boolean;
}

export interface DeterministicInvocationPort {
  /** begin/invoke may fail and will be rolled back; commit must be infallible. */
  begin(transactionId: number): void;
  invoke(request: Readonly<{ protocol: string; port: string; arguments: Readonly<Record<string, RuntimeValue>> }>): RuntimeValue;
  commit(transactionId: number): void;
  rollback(transactionId: number): void;
}

export interface SideEffectPort {
  /** invoke stages effects; commit must be atomic and infallible. */
  begin(transactionId: number): void;
  invoke(effect: TimelineEffectOccurrence): void;
  commit(transactionId: number): void;
  rollback(transactionId: number): void;
  reset(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  dispose(): void;
}

export interface ChannelOwnershipPort {
  /** transfer stages ownership changes; commit must be atomic and infallible. */
  begin(transactionId: number): void;
  transfer(change: Readonly<{ channel: RuntimeChannel; previous: RuntimeValue; next: RuntimeValue }>): void;
  commit(transactionId: number): void;
  rollback(transactionId: number): void;
  reset(): void;
  dispose(): void;
}

export interface NestedSample {
  readonly contributions: readonly Omit<TimelineContribution, 'layerOrder' | 'actionOrder' | 'blendMode'>[];
  readonly effects?: readonly TimelineEffectOccurrence[]; readonly settled: boolean;
}
export interface NestedRuntimeInstance {
  setInput(name: string, value: number | boolean): void;
  evaluate(timeSeconds: number, deltaSeconds: number): NestedSample;
  reset(): void; pause(): void; resume(): void; stop(): void; dispose(): void;
  beginTransaction?(transactionId: number): void;
  commitTransaction?(transactionId: number): void;
  rollbackTransaction?(transactionId: number): void;
}
export interface NestedRuntimeFactory { create(component: RuntimeComponent, generation: number): NestedRuntimeInstance }
