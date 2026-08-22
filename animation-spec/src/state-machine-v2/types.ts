export const HYA_STATE_MACHINE_V2_EXTENSION_ID = 'org.haiyue.animation-state-machine@2' as const;
export const HYA_STATE_MACHINE_V2_FORMAT = 'haiyue-animation-state-machine@2' as const;

export type TimelineValue = number | boolean | string | readonly number[] | null | Readonly<Record<string, unknown>>;
export type TimelineValueKind =
  | 'number'
  | 'vector'
  | 'color'
  | 'boolean'
  | 'string'
  | 'id'
  | 'integer'
  | 'unsigned'
  | 'callback';

export type TimelineInterpolation =
  | Readonly<{ kind: 'linear' }>
  | Readonly<{ kind: 'hold' }>
  | Readonly<{ kind: 'cubic-ease'; controls: readonly [number, number, number, number] }>
  | Readonly<{ kind: 'cubic-value'; outTangent: readonly number[]; inTangent: readonly number[] }>
  | Readonly<{ kind: 'elastic'; easing: 'in' | 'out' | 'in-out'; amplitude: number; period: number }>;

export interface TimelineKeyframe {
  readonly time: number;
  readonly value: TimelineValue;
  /** Interpolation from this key to the next key. Omitted on the final key. */
  readonly interpolation?: TimelineInterpolation;
}

export type HyaChannelFamily =
  | 'transform'
  | 'paint-path'
  | 'rig'
  | 'text-layout'
  | 'resource-data'
  | 'visibility-order'
  | 'event-audio-script';

export type HyaChannelPolicy = 'override' | 'additive' | 'discrete' | 'ownership';
export type HyaChannelEffectKind = 'event' | 'audio' | 'script';

export interface HyaTimelineChannel {
  readonly id: string;
  readonly target: string;
  readonly path: string;
  readonly family: HyaChannelFamily;
  readonly valueKind: TimelineValueKind;
  readonly valueSize?: number;
  readonly numericMode?: 'linear' | 'angle-radians';
  readonly defaultValue?: TimelineValue;
  readonly policy: HyaChannelPolicy;
  readonly effectKind?: HyaChannelEffectKind;
}

export interface HyaTimelineTrack {
  readonly id: string;
  readonly channel: string;
  readonly keys: readonly TimelineKeyframe[];
}

export interface HyaTimelineClip {
  readonly id: string;
  readonly name?: string;
  readonly duration: number;
  readonly fps?: number;
  readonly quantize?: boolean;
  readonly workArea?: Readonly<{ start: number; end: number }>;
  readonly tracks: readonly HyaTimelineTrack[];
}

export type HyaPlaybackMode = 'one-shot' | 'loop' | 'ping-pong';

export interface HyaClipMotion {
  readonly kind: 'clip';
  readonly clip: string;
  readonly speed?: number;
  readonly speedInput?: string;
  readonly playback?: HyaPlaybackMode;
  readonly timeRemapInput?: string;
}

export interface HyaBlend1DMotion {
  readonly kind: 'blend-1d';
  readonly input: string;
  readonly children: readonly Readonly<{ threshold: number; motion: HyaStateMotion }>[];
}

export interface HyaBlend2DMotion {
  readonly kind: 'blend-2d';
  readonly algorithm: 'cartesian' | 'directional';
  readonly inputX: string;
  readonly inputY: string;
  readonly children: readonly Readonly<{ position: readonly [number, number]; motion: HyaStateMotion }>[];
}

export interface HyaAdditiveBlendMotion {
  readonly kind: 'blend-additive';
  readonly base: HyaStateMotion;
  readonly children: readonly Readonly<{ motion: HyaStateMotion; weight?: number; weightInput?: string }>[];
}

export interface HyaNestedMotion {
  readonly kind: 'nested';
  readonly component: string;
  readonly speed?: number;
  readonly timeRemapInput?: string;
  readonly mixInput?: string;
  readonly playingInput?: string;
  readonly inputBindings?: Readonly<Record<string, string>>;
}

export type HyaStateMotion = HyaClipMotion | HyaBlend1DMotion | HyaBlend2DMotion | HyaAdditiveBlendMotion | HyaNestedMotion;

export type HyaMachineInput =
  | Readonly<{ id: string; type: 'number'; defaultValue: number }>
  | Readonly<{ id: string; type: 'integer'; defaultValue: number }>
  | Readonly<{ id: string; type: 'boolean'; defaultValue: boolean }>
  | Readonly<{ id: string; type: 'trigger' }>;

export type HyaComparator = 'equal' | 'not-equal' | 'greater' | 'greater-or-equal' | 'less' | 'less-or-equal';

export type HyaTransitionCondition =
  | Readonly<{ kind: 'input'; input: string; comparator: HyaComparator; value: TimelineValue }>
  | Readonly<{ kind: 'trigger'; input: string }>
  | Readonly<{ kind: 'observable'; protocol: string; port: string; comparator: HyaComparator; value: TimelineValue; arguments?: Readonly<Record<string, TimelineValue>> }>
  | Readonly<{ kind: 'custom'; protocol: string; port: string; arguments?: Readonly<Record<string, TimelineValue>> }>;

export interface HyaTransitionEffect {
  readonly channel: string;
  readonly phase: 'start' | 'complete';
  readonly payload?: TimelineValue | Readonly<Record<string, TimelineValue>>;
}

export interface HyaStateDefinition {
  readonly id: string;
  readonly motion: HyaStateMotion;
  readonly entryEffects?: readonly HyaTransitionEffect[];
  readonly exitEffects?: readonly HyaTransitionEffect[];
}

export type HyaTransitionEndpoint = '@entry' | '@any' | '@exit' | string;

export interface HyaTransitionDefinition {
  readonly id: string;
  readonly from: HyaTransitionEndpoint;
  readonly to: HyaTransitionEndpoint;
  /** OR across groups, AND within a group. An empty list is unconditional. */
  readonly conditionGroups: readonly (readonly HyaTransitionCondition[])[];
  readonly exitTime?: number;
  readonly randomWeight?: number;
  readonly pauseWhenExiting?: boolean;
  readonly duration: number;
  readonly destinationOffset?: number;
  readonly interruption?: 'none' | 'source' | 'destination' | 'source-then-destination' | 'destination-then-source';
  readonly exitMotion?: HyaStateMotion;
  readonly interpolation?: TimelineInterpolation;
  readonly effects?: readonly HyaTransitionEffect[];
}

export interface HyaStateLayer {
  readonly id: string;
  readonly order: number;
  readonly weight?: number;
  readonly weightInput?: string;
  readonly mode?: 'override' | 'additive';
  readonly mask?: Readonly<{ include?: readonly string[]; exclude?: readonly string[] }>;
  readonly states: readonly HyaStateDefinition[];
  /** Declaration order is the stable transition priority. */
  readonly transitions: readonly HyaTransitionDefinition[];
}

export interface HyaStateMachineV2 {
  readonly id: string;
  readonly inputs: readonly HyaMachineInput[];
  readonly layers: readonly HyaStateLayer[];
}

export interface HyaNestedComponentDefinition {
  readonly id: string;
  readonly target: string;
  readonly source: Readonly<{ kind: 'clip'; clip: string } | { kind: 'state-machine'; machine: string }>;
  readonly playback: 'simple' | 'remap' | 'mix' | 'state-machine';
  readonly exposedInputs?: readonly string[];
  readonly exposedEvents?: readonly string[];
}

export interface HyaStateMachineV2Document {
  readonly format: typeof HYA_STATE_MACHINE_V2_FORMAT;
  readonly extension: typeof HYA_STATE_MACHINE_V2_EXTENSION_ID;
  readonly channels: readonly HyaTimelineChannel[];
  readonly clips: readonly HyaTimelineClip[];
  readonly stateMachines: readonly HyaStateMachineV2[];
  readonly components?: readonly HyaNestedComponentDefinition[];
}

export interface HyaStateMachineV1MigrationResult {
  readonly document: HyaStateMachineV2Document;
  readonly diagnostics: readonly Readonly<{ code: 'W_STATE_MACHINE_V1_MIGRATED' | 'W_STATE_MACHINE_V1_CHANNEL_POLICY_REQUIRED'; path: string; message: string }>[];
}
