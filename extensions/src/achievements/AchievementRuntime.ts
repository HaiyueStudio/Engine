import type { AchievementDefinition, AchievementFact, AchievementRuleSnapshot, AchievementRuntimeEvent, AchievementRuntimeOptions } from './types';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const token = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 256;
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Event-driven local rules. Persist facts before attempting idempotent absolute platform reports. */
export class AchievementRuntime {
  readonly definitions: readonly Readonly<AchievementDefinition>[];
  private readonly key: string;
  private readonly window: number;
  private readonly queueLimit: number;
  private readonly reportTimeout: number;
  private readonly lifetime = new AbortController();
  private readonly signature: string;
  private data: AchievementRuleSnapshot | undefined;
  private dead = false;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private initialization: Promise<void> | undefined;
  private readonly listeners = new Set<(event: AchievementRuntimeEvent) => void>();
  constructor(private readonly options: AchievementRuntimeOptions) {
    if (options.port.contractVersion !== 1 || !token(options.profile) || !token(options.definitionVersion)) throw new Error('Invalid achievement profile/version/port');
    this.window = options.dedupeWindow ?? 256; this.queueLimit = options.maxQueuedOperations ?? 256;
    this.reportTimeout = options.reportTimeoutMs ?? 10000;
    if (!Number.isFinite(this.reportTimeout) || this.reportTimeout < 1) throw new Error('Invalid achievement report timeout');
    if (!integer(this.window) || this.window < 1 || this.window > 10000 || !integer(this.queueLimit) || this.queueLimit < 1 || this.queueLimit > 10000) throw new Error('Invalid achievement queue limits');
    if (options.definitions.length < 1 || options.definitions.length > 1000) throw new Error('Invalid achievement count');
    const ids = new Set<string>();
    this.definitions = Object.freeze(options.definitions.map(raw => {
      const d = clone(raw);
      if (!token(d.id) || ids.has(d.id) || !token(d.titleKey) || !token(d.descriptionKey) || !integer(d.target) || d.target < 1 || !d.rule || !token(d.rule.event) ||
        !['fact', 'counter', 'best'].includes(d.rule.kind) || (d.rule.kind === 'fact' ? d.target !== 1 : !token(d.rule.field)) ||
        (d.iconKey !== undefined && !token(d.iconKey)) || (d.hidden !== undefined && typeof d.hidden !== 'boolean')) throw new Error('Invalid achievement definition');
      ids.add(d.id); Object.freeze(d.rule); return Object.freeze(d);
    }));
    this.signature = JSON.stringify(this.definitions.map(d => [d.id, d.target, d.rule]));
    this.key = JSON.stringify(['achievement-rules-v1', options.profile]);
  }
  get disposed(): boolean { return this.dead; }
  subscribe(listener: (event: AchievementRuntimeEvent) => void): () => void { this.alive(); this.listeners.add(listener); return () => this.listeners.delete(listener); }
  initialize(): Promise<void> {
    this.alive();
    return this.initialization ??= this.serial(async () => {
      const raw = await this.options.storage.read(this.key); this.alive();
      if (raw === null) this.data = this.empty();
      else {
        let data: AchievementRuleSnapshot;
        try { data = this.validate(raw); }
        catch (error) { if (!this.options.migrate) throw error; data = this.validate(this.options.migrate(clone(raw), this.empty())); await this.options.storage.write(this.key, clone(data)); this.alive(); }
        this.data = data;
      }
      this.emit({ type: 'change' });
    });
  }
  snapshot(): AchievementRuleSnapshot { this.ready(); return clone(this.data!); }
  /** Returns false for a retained duplicate. Does not call a platform on every event/frame. */
  record(fact: AchievementFact): Promise<boolean> {
    this.ready(); const event = clone(fact);
    if (!token(event.id) || !token(event.type)) return Promise.reject(new Error('Invalid achievement fact'));
    return this.serial(async () => {
      this.ready(); const next = this.snapshot();
      if (next.recentEventIds.includes(event.id)) return false;
      const unlocked: string[] = [];
      for (const d of this.definitions) {
        if (d.rule.event !== event.type) continue;
        const row = next.records.find(r => r.id === d.id)!;
        const value = d.rule.kind === 'fact' ? 1 : event.values?.[d.rule.field];
        if (!integer(value)) throw new Error(`Missing nonnegative safe integer: ${d.id}`);
        const previous = row.value;
        // Saturate before adding, avoiding unsafe integer overflow.
        row.value = d.rule.kind === 'counter' ? previous + Math.min(value, d.target - previous) : Math.max(previous, Math.min(value, d.target));
        if (row.value !== previous) { row.pending = true; row.sync = 'queued'; if (row.value === d.target) unlocked.push(d.id); }
      }
      next.recentEventIds.push(event.id); next.recentEventIds = next.recentEventIds.slice(-this.window);
      await this.persist(next); this.emit({ type: 'change' });
      for (const id of unlocked) this.emit({ type: 'unlocked', id });
      return true;
    });
  }
  /** Restore counters/best progress from authoritative game stats. Never decreases or replays rewards. */
  checkpoint(values: Readonly<Record<string, number>>): Promise<void> {
    this.ready(); const copy = { ...values };
    return this.serial(async () => {
      const next = this.snapshot();
      for (const [id, value] of Object.entries(copy)) {
        const row = next.records.find(r => r.id === id), d = this.definitions.find(d => d.id === id);
        if (!row || !d || !integer(value) || value > d.target) throw new Error('Invalid achievement checkpoint');
        if (value > row.value) { row.value = value; row.pending = true; row.sync = 'queued'; }
      }
      await this.persist(next); this.emit({ type: 'change' });
    });
  }
  /** Durable Native receipt transfers retry ownership. Errors leave the local intent pending. */
  sync(): Promise<void> {
    this.ready(); return this.serial(async () => {
      for (const row of this.snapshot().records) {
        if (!row.pending) continue;
        this.alive();
        try {
          const receipt = await this.boundedReport(row.id, row.value); this.alive();
          if (receipt.id !== row.id || !['local-only', 'queued', 'provider-accepted', 'reconciled', 'failed'].includes(receipt.state)) throw new Error('Invalid achievement receipt');
          const next = this.snapshot(), changed = next.records.find(r => r.id === row.id)!;
          changed.pending = receipt.state === 'failed'; changed.sync = receipt.state;
          await this.persist(next); this.emit({ type: 'sync', id: row.id });
        } catch (error) { this.alive(); this.emit({ type: 'error', id: row.id, error }); throw error; }
      }
    });
  }
  dispose(): void { if (this.dead) return; this.dead = true; this.lifetime.abort(); this.emit({ type: 'dispose' }); this.listeners.clear(); }
  private boundedReport(id: string, value: number) {
    return new Promise<import('./types').AchievementReceipt>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, receipt?: import('./types').AchievementReceipt) => { if (done) return; done = true; clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(receipt!); };
      const abort = () => finish(new Error('Achievements disposed'));
      const timer = setTimeout(() => finish(new Error('Achievement report timed out')), this.reportTimeout);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { this.alive(); return this.options.port.reportProgress(id, value); }).then(receipt => finish(null, receipt), error => finish(error));
    });
  }
  private empty(): AchievementRuleSnapshot { return { schemaVersion: 1, definitionVersion: this.options.definitionVersion, signature: this.signature, records: this.definitions.map(d => ({ id: d.id, value: 0, pending: false, sync: 'local-only' })), recentEventIds: [] }; }
  private validate(raw: unknown): AchievementRuleSnapshot {
    const s = raw as AchievementRuleSnapshot;
    if (!s || s.schemaVersion !== 1 || s.definitionVersion !== this.options.definitionVersion || s.signature !== this.signature || !Array.isArray(s.records) || s.records.length !== this.definitions.length || !Array.isArray(s.recentEventIds) || s.recentEventIds.length > this.window || s.recentEventIds.some(id => !token(id)) || new Set(s.recentEventIds).size !== s.recentEventIds.length) throw new Error('Invalid achievement save; explicit migration required');
    const ids = new Set<string>();
    for (const r of s.records) {
      const d = this.definitions.find(d => d.id === r.id);
      if (!d || ids.has(r.id) || !integer(r.value) || r.value > d.target || typeof r.pending !== 'boolean' || !['local-only', 'queued', 'provider-accepted', 'reconciled', 'failed'].includes(r.sync)) throw new Error('Invalid achievement record');
      ids.add(r.id);
    }
    return clone(s);
  }
  private async persist(next: AchievementRuleSnapshot) { this.alive(); await this.options.storage.write(this.key, clone(next)); this.alive(); this.data = next; }
  private alive() { if (this.dead) throw new Error('Achievements disposed'); }
  private ready() { this.alive(); if (!this.data) throw new Error('Await achievement initialize()'); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.alive(); if (this.queued >= this.queueLimit) return Promise.reject(new Error('Achievement queue full'));
    this.queued++; const task = this.tail.then(() => { this.alive(); return fn(); }).finally(() => { this.queued--; }); this.tail = task.catch(() => {}); return task;
  }
  private emit(event: AchievementRuntimeEvent) { for (const listener of [...this.listeners]) { if (this.dead && event.type !== 'dispose') break; try { listener(event); } catch { /* Observers cannot roll back a persisted fact. */ } } }
}
