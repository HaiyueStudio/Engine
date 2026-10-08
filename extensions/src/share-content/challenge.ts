import type { ChallengeData, ChallengeLinkPolicy } from './types';
const parameter = 'hyChallenge';
function validate(value: unknown): ChallengeData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid challenge data');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['gameId', 'rulesVersion', 'mode', 'seed'].includes(key))) throw new TypeError('Unknown challenge field');
  for (const key of ['gameId', 'rulesVersion', 'mode', 'seed'] as const) {
    if (typeof record[key] !== 'string' || !record[key].length || record[key].length > (key === 'seed' ? 256 : 64)
      || /[\x00-\x1f\x7f]/.test(record[key])) throw new TypeError(`Invalid challenge ${key}`);
  }
  return Object.freeze({ gameId: record.gameId, rulesVersion: record.rulesVersion, mode: record.mode, seed: record.seed }) as ChallengeData;
}
function url(value: string): URL {
  if (typeof value !== 'string' || value.length > 8192) throw new TypeError('Invalid challenge URL length');
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError('Challenge links require an absolute HTTP(S) URL without credentials');
  return parsed;
}
export function createChallengeLink(baseUrl: string, challenge: ChallengeData): string {
  const data = validate(challenge), target = url(baseUrl);
  if (target.searchParams.has(parameter)) throw new TypeError('Base URL already contains a challenge');
  target.searchParams.set(parameter, JSON.stringify({ v: 1, ...data }));
  const result = target.href;
  if (result.length > 8192) throw new RangeError('Challenge URL is too long');
  return result;
}
/** Decodes data only; never starts a game or navigates. The host validates its mode/seed semantics. */
export function parseChallengeLink(link: string, policy: ChallengeLinkPolicy): ChallengeData | null {
  const target = url(link);
  if (!policy.allowedOrigins.some(origin => url(origin).origin === target.origin)) throw new TypeError('Challenge origin is not allowed');
  const values = target.searchParams.getAll(parameter);
  if (!values.length) return null;
  if (values.length !== 1 || values[0]!.length > 2048) throw new TypeError('Invalid or duplicate challenge parameter');
  const raw: unknown = JSON.parse(values[0]!);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { v?: unknown }).v !== 1) throw new TypeError('Unsupported challenge schema');
  const { v: _v, ...fields } = raw as Record<string, unknown>;
  const data = validate(fields);
  if (data.gameId !== policy.gameId || data.rulesVersion !== policy.rulesVersion) throw new TypeError('Challenge game or rules version mismatch');
  return data;
}
