export const HYA_SEMANTICS_EXTENSION_ID = 'org.haiyue.semantics@1' as const;
export const HYA_SEMANTICS_FORMAT = 'haiyue-semantics' as const;
export const HYA_SEMANTICS_VERSION = 1 as const;

export type SemanticRole = 'none' | 'group' | 'text' | 'button' | 'link' | 'image' | 'heading' | 'checkbox' | 'radio' | 'switch' | 'slider' | 'progress' | 'textbox' | 'list' | 'list-item' | 'menu' | 'menu-item' | 'dialog';
export type SemanticActionKind = 'tap' | 'increase' | 'decrease' | 'focus';
export type SemanticValue<T> = Readonly<{ kind: 'literal'; value: T } | { kind: 'binding'; binding: string }>;
export interface SemanticState {
  readonly hidden?: SemanticValue<boolean>; readonly disabled?: SemanticValue<boolean>; readonly focused?: SemanticValue<boolean>;
  readonly expanded?: SemanticValue<boolean>; readonly selected?: SemanticValue<boolean>; readonly checked?: SemanticValue<boolean>;
  readonly mixed?: SemanticValue<boolean>; readonly toggled?: SemanticValue<boolean>; readonly required?: SemanticValue<boolean>;
  readonly readOnly?: SemanticValue<boolean>; readonly modal?: SemanticValue<boolean>; readonly obscured?: SemanticValue<boolean>; readonly multiline?: SemanticValue<boolean>;
}
export interface SemanticCapabilities { readonly expandable?: boolean; readonly selectable?: boolean; readonly checkable?: boolean; readonly toggleable?: boolean; readonly requirable?: boolean; readonly enablable?: boolean; readonly focusable?: boolean }
export interface SemanticNodeDefinition {
  readonly id: string; readonly target: string; readonly parent?: string; readonly role: SemanticRole;
  readonly label?: SemanticValue<string>; readonly value?: SemanticValue<string | number>; readonly hint?: SemanticValue<string>;
  readonly headingLevel?: number; readonly traits?: readonly ('button' | 'link' | 'image' | 'header' | 'adjustable' | 'selected' | 'disabled')[];
  readonly state?: SemanticState; readonly capabilities?: SemanticCapabilities; readonly actions?: readonly SemanticActionKind[]; readonly live?: 'off' | 'polite' | 'assertive';
  readonly readingOrder: number; readonly navigationOrder: number;
}
export type ReducedMotionPolicy =
  | Readonly<{ mode: 'ignore' }>
  | Readonly<{ mode: 'respect'; decorative: 'pause' | 'stop' | 'continue'; essential: 'retain' | 'reduce'; durationScale: number; disableParallax: boolean }>;
export interface HyaSemanticsDocument {
  readonly format: typeof HYA_SEMANTICS_FORMAT; readonly version: typeof HYA_SEMANTICS_VERSION; readonly extension: typeof HYA_SEMANTICS_EXTENSION_ID;
  readonly nodes: readonly SemanticNodeDefinition[]; readonly reducedMotion: ReducedMotionPolicy;
}
export interface SemanticsParseOptions { readonly maxNodes?: number; readonly maxDepth?: number; readonly maxStringBytes?: number }
