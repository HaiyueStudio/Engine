import type { ShareCaptureSource, ShareImage, ShareImageOptions } from './types';

export function checkSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 4096 || height > 4096 || width * height > 8_388_608) throw new RangeError('Share image dimensions exceed the 4096-axis / 8-Mpixel limit');
}
function decode(data: string, mime: string): Uint8Array {
  const prefix = `data:${mime};base64,`;
  if (!data.startsWith(prefix)) throw new Error(`Canvas did not encode ${mime}`);
  const value = data.slice(prefix.length);
  if (value.length > 14_000_000 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encoded share image');
  // No atob/Buffer dependency: NativeScript hosts need neither global.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new Uint8Array(value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
  let out = 0;
  for (let i = 0; i < value.length; i += 4) {
    const bits = (alphabet.indexOf(value[i]!) << 18) | (alphabet.indexOf(value[i + 1]!) << 12)
      | (Math.max(0, alphabet.indexOf(value[i + 2]!)) << 6) | Math.max(0, alphabet.indexOf(value[i + 3]!));
    if (out < bytes.length) bytes[out++] = (bits >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (bits >> 8) & 255;
    if (out < bytes.length) bytes[out++] = bits & 255;
  }
  return bytes;
}
export function imageSettings(options: ShareImageOptions): { mime: 'image/png' | 'image/jpeg'; filename: string; quality: number } {
  const mime = options.mimeType ?? 'image/png', quality = options.quality ?? 0.9;
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw new TypeError('Only PNG and JPEG are supported');
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new RangeError('Image quality must be between 0 and 1');
  const filename = options.filename ?? (mime === 'image/png' ? 'result.png' : 'result.jpg');
  if (filename.length > 120 || /[\x00-\x1f\x7f/\\:]/.test(filename) || !(mime === 'image/png' ? /\.png$/i : /\.jpe?g$/i).test(filename)) throw new TypeError('Invalid share image filename');
  return { mime, filename, quality };
}
/** Invokes the encoder synchronously, before the first await. Capture a submitted frame before presentation clears it. */
export async function captureShareImage(source: ShareCaptureSource, options: ShareImageOptions = {}): Promise<ShareImage> {
  const { mime, filename, quality } = imageSettings(options);
  const width = source.width, height = source.height;
  checkSize(width, height);
  options.signal?.throwIfAborted();
  // Native exposes toDataURL; its synchronous readback must happen before presentSurface.
  const encoding = typeof source.toBlob === 'function'
    ? new Promise<Uint8Array>((resolve, reject) => {
      source.toBlob!(blob => {
        if (!blob || blob.type !== mime || blob.size > 10 * 1024 * 1024) { reject(new Error('Canvas encoder returned an invalid, unsupported or oversized image')); return; }
        void blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject);
      }, mime, quality);
    })
    : typeof source.toDataURL === 'function' ? Promise.resolve(decode(source.toDataURL(mime, quality), mime))
      : Promise.reject(new Error('Capture source has no image encoder'));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(options.signal?.reason ?? new Error('Share capture aborted'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  try {
    const bytes = await Promise.race([encoding, aborted]);
    options.signal?.throwIfAborted();
    const png = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!bytes.length || bytes.length > 10 * 1024 * 1024 || (mime === 'image/png'
      ? !png.every((byte, i) => bytes[i] === byte) : !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255))) throw new Error('Invalid encoded share image bytes');
    return Object.freeze({ bytes, mimeType: mime, filename, width, height });
  } finally { if (onAbort) options.signal?.removeEventListener('abort', onAbort); }
}
