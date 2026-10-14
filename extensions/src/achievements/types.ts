/** Structural port: inject Native or another platform; this package imports no SDK. */
export interface AchievementPort {
  readonly contractVersion: 1;
  reportProgress(id: string, absoluteValue: number): Promise<AchievementReceipt>;
  unlock(id: string): Promise<AchievementReceipt>;
}
export interface AchievementReceipt {
  id: string;
  sessionGeneration: number;
  state: 'local-only' | 'queued' | 'provider-accepted' | 'reconciled' | 'failed';
  code?: string;
}
export type AchievementRule = { kind: 'fact'; event: string } | { kind: 'counter' | 'best'; event: string; field: string };
export interface AchievementDefinition {
  id: string; target: number; titleKey: string; descriptionKey: string; iconKey?: string; hidden?: boolean; rule: AchievementRule;
}
export interface AchievementFact {
  /** Durable game event identity; retries reuse it. Only the configured recent window is retained. */
  id: string;
  type: string;
  values?: Readonly<Record<string, number>>;
}
export interface AchievementProgress {
  id: string; value: number; pending: boolean; sync: AchievementReceipt['state'];
}
export interface AchievementRuleSnapshot {
  schemaVersion: 1;
  definitionVersion: string;
  /** Locks rule/target semantics; changes require an explicit migration. */
  signature: string;
  records: AchievementProgress[];
  recentEventIds: string[];
}
export interface AchievementRuleStorage {
  read(key: string): Promise<unknown | null>;
  /** Atomic replacement; one runtime writer per game/profile namespace. */
  write(key: string, snapshot: AchievementRuleSnapshot): Promise<void>;
}
export interface AchievementRuntimeOptions {
  definitions: readonly AchievementDefinition[];
  definitionVersion: string;
  /** Include game/environment/provider/app/player or explicit guest identity. */
  profile: string;
  storage: AchievementRuleStorage;
  port: AchievementPort;
  dedupeWindow?: number;
  maxQueuedOperations?: number;
  reportTimeoutMs?: number;
  migrate?: (saved: unknown, empty: AchievementRuleSnapshot) => AchievementRuleSnapshot;
}
export interface AchievementRuntimeEvent {
  type: 'change' | 'unlocked' | 'sync' | 'error' | 'dispose';
  id?: string;
  error?: unknown;
}
