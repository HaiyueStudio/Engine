import { captureShareImage, renderShareCard, prepareShareContent, createChallengeLink, parseChallengeLink, type ShareCard, type ShareCardSurface } from '@haiyue/extensions/share-content';
import { I18n } from '@haiyue/extensions/i18n';
const i18n = new I18n({ locale: 'en', fallbackLocale: 'en' });
const card: ShareCard = { title: { key: 'result.title' }, stats: [{ label: 'Score', value: '100' }] };
declare const canvas: HTMLCanvasElement;
const factory = (_width: number, _height: number): ShareCardSurface => canvas;
void captureShareImage(canvas, { mimeType: 'image/png' });
void renderShareCard(card, { i18n, createCanvas: factory });
const challenge = { gameId: 'sudoku', rulesVersion: 'v3', seed: '123', mode: 'expert' };
const link = createChallengeLink('https://example.com/play', challenge);
parseChallengeLink(link, { gameId: 'sudoku', rulesVersion: 'v3', allowedOrigins: ['https://example.com'] });
void prepareShareContent({ title: 'Result', text: 'Best score', card }).then(result => {
  // Structural integration contract without a Native workspace dependency.
  const platformInput: { title?: string; text?: string; url?: string; image?: { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg'; filename?: string } } = result;
  void platformInput;
});
// @ts-expect-error source pixels are not encoded share bytes
void captureShareImage(new Uint8Array(10));
// @ts-expect-error GIF is outside the platform sharing contract
void renderShareCard(card, { mimeType: 'image/gif' });
