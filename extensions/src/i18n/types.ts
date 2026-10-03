/** Portable JSON v1. Keys are flat semantic IDs; asset paths belong to the game. */
export interface LocalePack {
  readonly schemaVersion: 1;
  readonly locale: string;
  readonly messages: Readonly<Record<string, string | Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>>>;
  readonly assets?: Readonly<Record<string, string>>;
}
export type I18nParams = Readonly<Record<string, string | number>>;
export type LocalePackLoader = (locale: string, signal: AbortSignal) => Promise<unknown>;
export interface I18nDiagnostic {
  readonly code: 'missing-message' | 'missing-asset' | 'missing-param' | 'missing-count';
  readonly locale: string;
  readonly key: string;
}
export interface I18nOptions {
  locale: string;
  fallbackLocale: string;
  /** Explicit ordered fallback chains. No implicit region/script truncation. */
  fallbacks?: Readonly<Record<string, readonly string[]>>;
  /** Opt-in development diagnostics, deduplicated until dispose. */
  onDiagnostic?: (diagnostic: I18nDiagnostic) => void;
}
export interface LocalePackIssue {
  readonly locale: string;
  readonly section: 'messages' | 'assets';
  readonly key: string;
  readonly kind: 'missing-key' | 'extra-key' | 'message-kind' | 'parameters';
}
export interface I18nEvent {
  readonly type: 'change' | 'dispose';
  readonly locale: string;
}
