import type { I18n } from '../i18n/I18n';
import type { I18nParams } from '../i18n/types';

export type ShareText = string | { readonly key: string; readonly params?: I18nParams };
/** Encoded bytes; structurally compatible with the Native share image contract. */
export interface ShareImage {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly filename: string;
  readonly width: number;
  readonly height: number;
}
export interface ShareCaptureSource {
  readonly width: number;
  readonly height: number;
  toBlob?(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
  toDataURL?(type?: string, quality?: number): string;
}
/** A fresh, exclusively owned Canvas2D surface. Native hosts inject this factory. */
export interface ShareCardSurface extends ShareCaptureSource {
  width: number;
  height: number;
  getContext(type: '2d'): Pick<CanvasRenderingContext2D,
    'fillStyle' | 'font' | 'textBaseline' | 'fillRect' | 'fillText' | 'measureText' | 'drawImage'> | null;
}
export interface ShareImageOptions {
  readonly mimeType?: 'image/png' | 'image/jpeg';
  readonly quality?: number;
  readonly filename?: string;
  readonly signal?: AbortSignal;
}
export interface ShareCard {
  readonly width?: number;
  readonly height?: number;
  readonly title: ShareText;
  readonly subtitle?: ShareText;
  readonly badge?: ShareText;
  readonly footer?: ShareText;
  readonly stats?: readonly { readonly label: ShareText; readonly value: ShareText }[];
  /** Borrowed decoded image; the caller keeps it alive until rendering finishes. */
  readonly image?: { readonly source: CanvasImageSource; readonly width: number; readonly height: number; readonly fit?: 'cover' | 'contain' };
  readonly fontFamily?: string;
  readonly colors?: Partial<Readonly<Record<'background' | 'panel' | 'text' | 'muted' | 'accent', string>>>;
}
export interface ShareCardOptions extends ShareImageOptions {
  readonly i18n?: Pick<I18n, 'text' | 'locale'>;
  readonly createCanvas?: (width: number, height: number) => ShareCardSurface;
}
/** The same seed only reproduces a puzzle with the same game's rules/generator version. */
export interface ChallengeData {
  readonly gameId: string;
  readonly rulesVersion: string;
  readonly mode: string;
  readonly seed: string;
}
export interface ChallengeLinkPolicy {
  readonly gameId: string;
  readonly rulesVersion: string;
  readonly allowedOrigins: readonly string[];
}
export interface ShareContentRequest {
  readonly title: ShareText;
  readonly text: ShareText;
  readonly card: ShareCard;
  readonly challenge?: { readonly baseUrl: string; readonly data: ChallengeData };
}
/** Plain data only: no Object URLs, GPU handles, platform SDK or implicit upload. */
export interface PreparedShareContent {
  readonly title: string;
  readonly text: string;
  readonly url?: string;
  readonly image: ShareImage;
}
