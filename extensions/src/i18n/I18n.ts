import { canonicalLocale, validateLocalePack } from './packs';
import type { I18nDiagnostic, I18nEvent, I18nOptions, I18nParams, LocalePack, LocalePackLoader } from './types';

/** Platform-neutral locale runtime. No DOM, global singleton or frame polling. */
export class I18n {
  private current: string;
  private readonly fallback: string;
  private readonly fallbacks = new Map<string, readonly string[]>();
  private readonly sources = new Map<string, LocalePack | LocalePackLoader>();
  private readonly packs = new Map<string, LocalePack>();
  private readonly listeners = new Set<(event: I18nEvent) => void>();
  private readonly warnings = new Set<string>();
  private readonly loads = new Set<AbortController>();
  private readonly diagnostic: I18nOptions['onDiagnostic'];
  private transition: AbortController | undefined;
  private dead = false;

  constructor(options: I18nOptions) {
    this.current = canonicalLocale(options.locale);
    this.fallback = canonicalLocale(options.fallbackLocale);
    this.diagnostic = options.onDiagnostic;
    for (const [locale, chain] of Object.entries(options.fallbacks ?? {})) this.fallbacks.set(canonicalLocale(locale), chain.map(canonicalLocale));
  }
  get locale(): string { return this.current; }
  get disposed(): boolean { return this.dead; }

  register(pack: LocalePack): void {
    this.assertAlive();
    const copy = validateLocalePack(pack);
    this.sources.set(copy.locale, copy);
    this.packs.set(copy.locale, copy);
    if (this.chain(this.current).includes(copy.locale)) this.notify('change');
  }
  registerLoader(locale: string, loader: LocalePackLoader): void {
    this.assertAlive();
    locale = canonicalLocale(locale);
    if (this.sources.has(locale)) throw new Error(`Locale already registered: ${locale}. Use register() to replace its data.`);
    this.sources.set(locale, loader);
  }
  /** Load the locale and configured fallbacks without changing the current language. */
  async preload(locale: string, signal?: AbortSignal): Promise<void> {
    this.assertAlive();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.loads.add(controller);
    try {
      for (const candidate of this.chain(canonicalLocale(locale))) {
        controller.signal.throwIfAborted();
        if (this.packs.has(candidate)) continue;
        const source = this.sources.get(candidate);
        if (typeof source !== 'function') continue;
        const pack = validateLocalePack(await source(candidate, controller.signal));
        controller.signal.throwIfAborted();
        if (pack.locale !== candidate) throw new TypeError(`Loaded locale ${pack.locale}, expected ${candidate}.`);
        // A synchronous registration made while loading always wins.
        if (this.sources.get(candidate) === source) this.packs.set(candidate, pack);
      }
      controller.signal.throwIfAborted();
    } finally {
      signal?.removeEventListener('abort', abort);
      this.loads.delete(controller);
    }
  }
  /** Latest request wins. Superseded/aborted switches resolve false; load errors reject. */
  async setLocale(locale: string, signal?: AbortSignal): Promise<boolean> {
    this.assertAlive();
    locale = canonicalLocale(locale);
    this.transition?.abort();
    const controller = this.transition = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      await this.preload(locale, controller.signal);
      if (controller.signal.aborted || this.dead) return false;
      if (!this.chain(locale).some(candidate => this.packs.has(candidate))) throw new Error(`No language pack available for ${locale}.`);
      this.current = locale;
      this.notify('change');
      return true;
    } catch (error) {
      if (controller.signal.aborted || this.dead) return false;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.transition === controller) this.transition = undefined;
    }
  }
  text(key: string, params: I18nParams = {}): string {
    for (const locale of this.chain(this.current)) {
      const message = this.packs.get(locale)?.messages[key];
      if (message === undefined) continue;
      let template: string;
      if (typeof message === 'string') template = message;
      else {
        const count = params.count;
        if (typeof count !== 'number' || !Number.isFinite(count)) {
          this.warn('missing-count', key);
          template = message.other;
        } else template = message[new Intl.PluralRules(locale).select(count)] ?? message.other;
      }
      return template.replace(/\{([\w.]+)\}/g, (token, name: string) => {
        if (Object.hasOwn(params, name)) return String(params[name]);
        this.warn('missing-param', `${key}:${name}`);
        return token;
      });
    }
    this.warn('missing-message', key);
    return key;
  }
  asset(key: string): string | undefined {
    for (const locale of this.chain(this.current)) {
      const path = this.packs.get(locale)?.assets?.[key];
      if (path !== undefined) return path;
    }
    this.warn('missing-asset', key);
    return undefined;
  }
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string { return new Intl.NumberFormat(this.current, options).format(value); }
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string { return new Intl.DateTimeFormat(this.current, options).format(value); }

  subscribe(listener: (event: I18nEvent) => void): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.transition?.abort();
    for (const controller of this.loads) controller.abort();
    try { this.notify('dispose'); }
    finally { this.listeners.clear(); this.packs.clear(); this.sources.clear(); this.warnings.clear(); }
  }
  private chain(locale: string): string[] {
    const result: string[] = [];
    const visit = (value: string) => {
      if (result.includes(value)) return;
      result.push(value);
      for (const fallback of this.fallbacks.get(value) ?? []) visit(fallback);
    };
    visit(locale); visit(this.fallback);
    return result;
  }
  private notify(type: I18nEvent['type']): void {
    const errors: unknown[] = [];
    for (const listener of [...this.listeners]) {
      try { listener({ type, locale: this.current }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'I18n subscribers failed.');
  }
  private warn(code: I18nDiagnostic['code'], key: string): void {
    if (!this.diagnostic) return;
    const identity = `${this.current}:${code}:${key}`;
    if (this.warnings.has(identity)) return;
    this.warnings.add(identity);
    this.diagnostic({ code, locale: this.current, key });
  }
  private assertAlive(): void { if (this.dead) throw new Error('I18n is disposed.'); }
}
