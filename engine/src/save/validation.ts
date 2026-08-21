import { GameSaveError, GameSaveErrorCode } from './GameSaveError';
import {
  GAME_SAVE_FORMAT,
  GAME_SAVE_FORMAT_VERSION,
  type GameSaveEnvelope,
  type GameSaveIntegrity,
  type GameSaveValidationIssue,
  type GameSaveValidationOptions,
  type GameSaveValidationResult,
} from './contracts';

const SAVE_KINDS = new Set(['manual', 'autosave', 'checkpoint']);
const THUMBNAIL_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function validateGameSaveEnvelope(value: unknown, options: GameSaveValidationOptions = {}): GameSaveValidationResult {
  const issues: GameSaveValidationIssue[] = [];
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'Save data must be an object.');
    return { valid: false, issues };
  }

  expectEqual(issues, value, 'format', GAME_SAVE_FORMAT);
  expectEqual(issues, value, 'formatVersion', GAME_SAVE_FORMAT_VERSION, 'unsupported-version');
  expectText(issues, value, 'saveId');
  expectText(issues, value, 'gameId');
  expectText(issues, value, 'name');
  if (!SAVE_KINDS.has(String(value.kind))) issue(issues, 'invalid-value', '$.kind', 'Save kind is invalid.');
  expectDate(issues, value, 'createdAt');
  expectDate(issues, value, 'updatedAt');
  expectPositiveInteger(issues, value, 'revision', 1);
  expectPositiveInteger(issues, value, 'dataVersion', 0);

  if (!Object.hasOwn(value, 'data')) issue(issues, 'missing', '$.data', 'Game-specific save data is required.');
  else if (!isJsonValue(value.data)) issue(issues, 'invalid-value', '$.data', 'Game-specific save data must be JSON serializable.');

  if (value.metadata !== undefined && (!isRecord(value.metadata) || !isJsonValue(value.metadata))) {
    issue(issues, 'invalid-value', '$.metadata', 'Save metadata must be a JSON object.');
  }
  validateThumbnail(value.thumbnail, issues);
  validateIntegrity(value.integrity, issues);

  if (options.expectedGameId !== undefined && value.gameId !== options.expectedGameId) {
    issue(issues, 'game-mismatch', '$.gameId', `Expected game id "${options.expectedGameId}".`);
  }
  if (options.expectedDataVersion !== undefined && value.dataVersion !== options.expectedDataVersion) {
    issue(issues, 'unsupported-version', '$.dataVersion', `Expected game data version ${options.expectedDataVersion}.`);
  }
  if (options.validateData !== undefined && Object.hasOwn(value, 'data')) {
    const result = options.validateData(value.data);
    if (typeof result === 'boolean') {
      if (!result) issue(issues, 'data-invalid', '$.data', 'Game-specific save data is incomplete or invalid.');
    } else if (!result.valid) {
      for (const dataIssue of result.issues) {
        issues.push({ ...dataIssue, path: dataIssue.path.startsWith('$') ? dataIssue.path : `$.data.${dataIssue.path}` });
      }
    }
  }

  if (options.verifyIntegrity !== false && isIntegrity(value.integrity)) {
    const expected = computeGameSaveIntegrity(value as unknown as GameSaveEnvelope).checksum;
    if (value.integrity.checksum !== expected) {
      issue(issues, 'integrity-mismatch', '$.integrity.checksum', 'Save checksum does not match its contents.');
    }
  }
  return { valid: issues.length === 0, issues };
}

export function computeGameSaveIntegrity(save: Omit<GameSaveEnvelope, 'integrity'> | GameSaveEnvelope): GameSaveIntegrity {
  const record = { ...(save as GameSaveEnvelope) } as Partial<GameSaveEnvelope>;
  delete record.integrity;
  const text = canonicalJson(record);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return { algorithm: 'fnv1a32', checksum: hash.toString(16).padStart(8, '0') };
}

export function assertValidGameSaveEnvelope<TData>(
  value: unknown,
  options: GameSaveValidationOptions & { operation?: 'validate' | 'read' | 'write' | 'import' } = {},
): GameSaveEnvelope<TData> {
  const result = validateGameSaveEnvelope(value, options);
  if (!result.valid) {
    throw new GameSaveError(GameSaveErrorCode.InvalidEnvelope, 'The game save is incomplete or invalid.', {
      operation: options.operation ?? 'validate',
      ...(options.expectedGameId === undefined ? {} : { gameId: options.expectedGameId }),
      issues: result.issues,
    });
  }
  return value as GameSaveEnvelope<TData>;
}

function validateThumbnail(value: unknown, issues: GameSaveValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$.thumbnail', 'Thumbnail must be an object.');
    return;
  }
  if (!THUMBNAIL_MIME_TYPES.has(String(value.mimeType))) issue(issues, 'invalid-value', '$.thumbnail.mimeType', 'Thumbnail MIME type is unsupported.');
  if (typeof value.dataUrl !== 'string' || !value.dataUrl.startsWith(`data:${String(value.mimeType)};base64,`)) {
    issue(issues, 'invalid-value', '$.thumbnail.dataUrl', 'Thumbnail must be a matching base64 data URL.');
  }
  expectPositiveInteger(issues, value, 'width', 1, '$.thumbnail');
  expectPositiveInteger(issues, value, 'height', 1, '$.thumbnail');
}

function validateIntegrity(value: unknown, issues: GameSaveValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, 'missing', '$.integrity', 'Save integrity data is required.');
    return;
  }
  if (value.algorithm !== 'fnv1a32') issue(issues, 'invalid-value', '$.integrity.algorithm', 'Save integrity algorithm is unsupported.');
  if (typeof value.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(value.checksum)) {
    issue(issues, 'invalid-value', '$.integrity.checksum', 'Save checksum is invalid.');
  }
}

function isIntegrity(value: unknown): value is GameSaveIntegrity {
  return isRecord(value) && value.algorithm === 'fnv1a32' && typeof value.checksum === 'string';
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectEqual(issues: GameSaveValidationIssue[], record: Record<string, unknown>, key: string, expected: unknown, code: GameSaveValidationIssue['code'] = 'invalid-value'): void {
  if (record[key] !== expected) issue(issues, code, `$.${key}`, `Expected ${JSON.stringify(expected)}.`);
}

function expectText(issues: GameSaveValidationIssue[], record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== 'string' || record[key].trim().length === 0) issue(issues, 'invalid-value', `$.${key}`, `${key} must be a non-empty string.`);
}

function expectDate(issues: GameSaveValidationIssue[], record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== 'string' || !Number.isFinite(Date.parse(record[key]))) issue(issues, 'invalid-value', `$.${key}`, `${key} must be an ISO date string.`);
}

function expectPositiveInteger(issues: GameSaveValidationIssue[], record: Record<string, unknown>, key: string, minimum: number, parent = '$'): void {
  if (!Number.isInteger(record[key]) || Number(record[key]) < minimum) issue(issues, 'invalid-value', `${parent}.${key}`, `${key} must be an integer of at least ${minimum}.`);
}

function issue(issues: GameSaveValidationIssue[], code: GameSaveValidationIssue['code'], path: string, message: string): void {
  issues.push({ code, path, message });
}
