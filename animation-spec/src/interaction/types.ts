export const HYA_INTERACTION_EXTENSION_ID = 'org.haiyue.interaction@1' as const;
export const HYA_INTERACTION_FORMAT = 'haiyue-interaction' as const;
export const HYA_INTERACTION_VERSION = 1 as const;

export interface InteractionLimits { readonly maxTargets: number; readonly maxListeners: number; readonly maxActions: number; readonly maxPathDepth: number; readonly maxEventQueue: number; readonly maxEventRecursion: number; readonly maxPointers: number; readonly maxPolygonPoints: number; readonly maxStringBytes: number }
export interface InteractionObject { readonly [key: string]: InteractionValue }
export type InteractionValue = number | string | boolean | null | readonly InteractionValue[] | InteractionObject;
export type InteractionEventKind = 'pointer-enter' | 'pointer-exit' | 'pointer-move' | 'pointer-down' | 'pointer-up' | 'click' | 'drag-start' | 'drag' | 'drag-end' | 'keyboard' | 'text-input' | 'gamepad' | 'focus' | 'blur' | 'data-change' | 'reported-event' | 'component-event' | 'semantic-action';
export type InteractionPhase = 'capture' | 'target' | 'bubble';
export type HitArea =
  | Readonly<{ kind: 'rect'; rect: readonly [number, number, number, number] }>
  | Readonly<{ kind: 'ellipse'; center: readonly [number, number]; radius: readonly [number, number] }>
  | Readonly<{ kind: 'polygon'; points: readonly (readonly [number, number])[] }>
  | Readonly<{ kind: 'geometry'; port: string }>;

export interface InteractionTargetDefinition {
  readonly id: string; readonly parent?: string; readonly component?: string; readonly order: number;
  readonly transform?: readonly [number, number, number, number, number, number]; readonly hitArea: HitArea; readonly clips?: readonly string[];
  readonly enabled?: boolean; readonly focusable?: boolean; readonly tabIndex?: number;
}

export type InteractionAction =
  | Readonly<{ kind: 'data-set'; binding: string; value: InteractionValue }>
  | Readonly<{ kind: 'data-trigger'; binding: string }>
  | Readonly<{ kind: 'property-group'; group: string }>
  | Readonly<{ kind: 'state-input'; machine: string; input: string; value: InteractionValue }>
  | Readonly<{ kind: 'state-control'; machine: string; operation: 'play' | 'pause' | 'resume' | 'stop' | 'reset'; value?: number }>
  | Readonly<{ kind: 'report-event'; name: string; payload?: InteractionValue }>
  | Readonly<{ kind: 'audio'; operation: 'play' | 'pause' | 'stop' | 'seek'; target: string; value?: number }>
  | Readonly<{ kind: 'semantic'; operation: 'announce' | 'focus' | 'increment' | 'decrement' | 'activate'; target: string; value?: InteractionValue }>
  | Readonly<{ kind: 'align-target'; target: string; alignment: readonly [number, number]; preserveOffset: boolean }>
  | Readonly<{ kind: 'open-url'; url: string; target: 'same-context' | 'new-context' }>
  | Readonly<{ kind: 'component-input'; component: string; input: string; value: InteractionValue }>
  | Readonly<{ kind: 'component-event'; component: string; event: string; payload?: InteractionValue }>
  | Readonly<{ kind: 'pointer-capture' | 'pointer-release' }>
  | Readonly<{ kind: 'focus'; target?: string }>
  | Readonly<{ kind: 'custom'; protocol: string; port: string; arguments?: InteractionObject }>;

export interface InteractionListenerDefinition {
  readonly id: string; readonly target: string; readonly event: InteractionEventKind; readonly phases: readonly InteractionPhase[];
  readonly pointerButton?: number; readonly key?: string; readonly keyPhase?: 'down' | 'up' | 'repeat'; readonly modifiers?: readonly ('alt' | 'control' | 'meta' | 'shift')[];
  readonly gamepad?: Readonly<{ index?: number; control: string; phase: 'down' | 'up' | 'change' }>;
  readonly semanticAction?: 'tap' | 'increase' | 'decrease' | 'focus'; readonly actions: readonly InteractionAction[];
}

export interface HyaInteractionDocument {
  readonly format: typeof HYA_INTERACTION_FORMAT; readonly version: typeof HYA_INTERACTION_VERSION; readonly extension: typeof HYA_INTERACTION_EXTENSION_ID;
  readonly dragThreshold: number; readonly targets: readonly InteractionTargetDefinition[]; readonly listeners: readonly InteractionListenerDefinition[];
  readonly limits?: Readonly<Pick<InteractionLimits, 'maxEventQueue' | 'maxEventRecursion' | 'maxPointers'>>;
}
export interface InteractionParseOptions { readonly limits?: Partial<InteractionLimits> }
