export type NarrativeValue = string | number | boolean;
export type NarrativeVariables = Readonly<Record<string, NarrativeValue>>;
export type NarrativeCondition =
  | { readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; readonly variable: string; readonly value: NarrativeValue }
  | { readonly op: 'all' | 'any'; readonly conditions: readonly NarrativeCondition[] }
  | { readonly op: 'not'; readonly condition: NarrativeCondition };
export type NarrativeEffect =
  | { readonly op: 'set'; readonly variable: string; readonly value: NarrativeValue }
  | { readonly op: 'add'; readonly variable: string; readonly value: number };
export interface NarrativeArtwork { readonly assetKey: string; readonly textKey: string }
export interface NarrativeOption {
  readonly id: string;
  readonly textKey: string;
  readonly next: string;
  readonly visibleWhen?: NarrativeCondition;
  readonly enabledWhen?: NarrativeCondition;
  readonly effects?: readonly NarrativeEffect[];
}
interface Presentation {
  readonly textKey: string;
  readonly speakerKey?: string;
  readonly artwork?: NarrativeArtwork;
}
export type NarrativeNode =
  | (Presentation & { readonly type: 'dialogue'; readonly next: string })
  | (Presentation & { readonly type: 'choice'; readonly options: readonly NarrativeOption[] })
  | { readonly type: 'branch'; readonly condition: NarrativeCondition; readonly then: string; readonly otherwise: string }
  | { readonly type: 'effect'; readonly effects: readonly NarrativeEffect[]; readonly next: string }
  | { readonly type: 'action'; readonly name: string; readonly payload?: NarrativeVariables; readonly textKey?: string; readonly next: string }
  | (Presentation & { readonly type: 'end'; readonly ending: string });
/** Language-independent, JSON-serializable story graph. Change version when save semantics change. */
export interface NarrativeDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly start: string;
  readonly variables: NarrativeVariables;
  readonly nodes: Readonly<Record<string, NarrativeNode>>;
}
export interface NarrativeSnapshot {
  readonly schemaVersion: 1;
  readonly storyId: string;
  readonly storyVersion: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly variables: NarrativeVariables;
  readonly choices: readonly { readonly nodeId: string; readonly optionId: string }[];
  readonly actionSequence: number;
  readonly pendingAction: { readonly sequence: number } | null;
}
export interface NarrativeActionRequest {
  /** Ephemeral acknowledgement identity. Replaced after restore, even for the same durable token. */
  readonly id: number;
  /** Durable host idempotency key: stable when a waiting action is restored. */
  readonly token: string;
  readonly name: string;
  readonly payload: NarrativeVariables;
}
export interface NarrativeView {
  readonly revision: number;
  readonly nodeId: string;
  readonly node: NarrativeNode;
  readonly variables: NarrativeVariables;
  readonly choices: readonly (NarrativeOption & { readonly enabled: boolean })[];
  readonly action: NarrativeActionRequest | null;
  readonly ending: string | null;
}
export type NarrativeEvent =
  | { readonly type: 'change'; readonly view: NarrativeView }
  | { readonly type: 'action'; readonly request: NarrativeActionRequest }
  | { readonly type: 'end'; readonly ending: string; readonly runId: string }
  | { readonly type: 'dispose' };
