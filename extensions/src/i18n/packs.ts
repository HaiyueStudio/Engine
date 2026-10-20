import type { LocalePack, LocalePackIssue } from './types';

export function canonicalLocale(locale: string): string {
  const result = Intl.getCanonicalLocales(locale)[0];
  if (!result) throw new TypeError('A non-empty BCP 47 locale is required.');
  return result;
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
  return value as Record<string, unknown>;
}
export function parameters(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([\w.]+)\}/g)].map(match => match[1]!))].sort();
}
/** Validate and defensively copy data received from JSON or application code. */
export function validateLocalePack(value: unknown): LocalePack {
  const pack = record(value, 'LocalePack');
  if (pack.schemaVersion !== 1 || typeof pack.locale !== 'string') throw new TypeError('Expected LocalePack schemaVersion 1 and locale.');
  const messages: Record<string, LocalePack['messages'][string]> = Object.create(null);
  for (const [key, entry] of Object.entries(record(pack.messages, 'messages'))) {
    if (typeof entry === 'string') messages[key] = entry;
    else {
      const forms = record(entry, `messages.${key}`);
      if (typeof forms.other !== 'string') throw new TypeError(`${key} requires an other plural form.`);
      for (const [form, text] of Object.entries(forms)) {
        if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(form) || typeof text !== 'string') throw new TypeError(`Invalid plural form: ${key}.${form}`);
      }
      messages[key] = Object.freeze({ ...forms }) as Exclude<LocalePack['messages'][string], string>;
    }
  }
  const assets: Record<string, string> = Object.create(null);
  for (const [key, path] of Object.entries(record(pack.assets ?? {}, 'assets'))) {
    if (typeof path !== 'string' || !path.trim()) throw new TypeError(`Invalid asset path: ${key}`);
    assets[key] = path;
  }
  return Object.freeze({ schemaVersion: 1, locale: canonicalLocale(pack.locale), messages: Object.freeze(messages), assets: Object.freeze(assets) });
}
/** Offline completeness check; plural categories may differ between languages. */
export function checkLocalePacks(reference: LocalePack, translations: readonly LocalePack[]): LocalePackIssue[] {
  const base = validateLocalePack(reference);
  const issues: LocalePackIssue[] = [];
  for (const raw of translations) {
    const pack = validateLocalePack(raw);
    for (const section of ['messages', 'assets'] as const) {
      const left = base[section] ?? {}, right = pack[section] ?? {};
      for (const key of Object.keys(left)) {
        if (!Object.hasOwn(right, key)) issues.push({ locale: pack.locale, section, key, kind: 'missing-key' });
        else if (section === 'messages') {
          const a = base.messages[key]!, b = pack.messages[key]!;
          if (typeof a !== typeof b) issues.push({ locale: pack.locale, section, key, kind: 'message-kind' });
          const params = (v: typeof a) => [...new Set((typeof v === 'string' ? [v] : Object.values(v)).flatMap(parameters))].sort().join(',');
          if (params(a) !== params(b)) issues.push({ locale: pack.locale, section, key, kind: 'parameters' });
        }
      }
      for (const key of Object.keys(right)) if (!Object.hasOwn(left, key)) issues.push({ locale: pack.locale, section, key, kind: 'extra-key' });
    }
  }
  return issues;
}

/** Collect literal message glyphs for GuiSystemOptions.font.chars. Add dynamic/player text separately. */
export function collectLocaleCharacters(packs: readonly LocalePack[], extra = ''): string {
  const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
  const messages = packs.flatMap(pack => Object.values(validateLocalePack(pack).messages)
    .flatMap(message => typeof message === 'string' ? [message] : Object.values(message)));
  return [...new Set([...ascii, ...extra, ...messages.join('')])].join('');
}
