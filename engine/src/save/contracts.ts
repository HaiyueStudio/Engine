export const GAME_SAVE_FORMAT = 'haiyue.game-save' as const;
export const GAME_SAVE_FORMAT_VERSION = 1 as const;

export type GameSaveKind = 'manual' | 'autosave' | 'checkpoint';

export interface GameSaveThumbnail {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataUrl: string;
  width: number;
  height: number;
}

export interface GameSaveIntegrity {
  algorithm: 'fnv1a32';
  checksum: string;
}

export interface GameSaveEnvelope<TData = unknown> {
  format: typeof GAME_SAVE_FORMAT;
  formatVersion: typeof GAME_SAVE_FORMAT_VERSION;
  saveId: string;
  gameId: string;
  name: string;
  kind: GameSaveKind;
  createdAt: string;
  updatedAt: string;
  revision: number;
  dataVersion: number;
  data: TData;
  thumbnail?: GameSaveThumbnail;
  metadata?: Readonly<Record<string, unknown>>;
  integrity: GameSaveIntegrity;
}

export interface GameSaveSummary {
  saveId: string;
  gameId: string;
  name: string;
  kind: GameSaveKind;
  createdAt: string;
  updatedAt: string;
  revision: number;
  dataVersion: number;
  thumbnail?: GameSaveThumbnail;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface GameSaveValidationIssue {
  code: 'missing' | 'invalid-type' | 'invalid-value' | 'unsupported-version' | 'game-mismatch' | 'data-invalid' | 'integrity-mismatch';
  path: string;
  message: string;
}

export interface GameSaveValidationResult {
  valid: boolean;
  issues: readonly GameSaveValidationIssue[];
}

export type GameSaveDataValidator = (data: unknown) => boolean | GameSaveValidationResult;

export interface GameSaveValidationOptions {
  expectedGameId?: string;
  expectedDataVersion?: number;
  validateData?: GameSaveDataValidator;
  verifyIntegrity?: boolean;
}

export interface GameSaveBackendCapabilities {
  multiple: boolean;
  delete: boolean;
  persistent: boolean;
}

export interface GameSaveBackend {
  readonly id: string;
  readonly capabilities: GameSaveBackendCapabilities;
  list(gameId: string): Promise<readonly GameSaveEnvelope[]>;
  read(gameId: string, saveId: string): Promise<GameSaveEnvelope | null>;
  write(save: GameSaveEnvelope): Promise<void>;
  delete(gameId: string, saveId: string): Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface GameSaveServiceOptions {
  gameId: string;
  dataVersion: number;
  backend: GameSaveBackend;
  validateData?: GameSaveDataValidator;
  maxSlots?: number;
  ownsBackend?: boolean;
  clock?: () => Date;
  createId?: () => string;
}

export interface WriteGameSaveOptions<TData> {
  data: TData;
  name: string;
  saveId?: string;
  kind?: GameSaveKind;
  thumbnail?: GameSaveThumbnail;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ImportGameSaveOptions {
  replace?: boolean;
}

export interface CaptureGameSaveThumbnailOptions {
  mimeType?: GameSaveThumbnail['mimeType'];
  quality?: number;
}

