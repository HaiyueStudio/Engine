import {ProductionTextError, textFail} from './snapshot.js';

// Versioned private host protocol; no public package entry or JSON/source capability.
// A symbol data descriptor also works across independently bundled host adapters.
const protocol = Symbol.for('org.haiyue.private.native-glyph-bitmap@1');
export interface NativeGlyphBitmapLease {readonly value: HTMLCanvasElement; release(): void;}
export interface NativeGlyphBitmapState {readonly cacheEntries: number; readonly cacheBytes: number; readonly activeBitmaps: number; readonly activeWorkBytes: number; readonly retired: boolean; readonly released: boolean;}
interface NativeGlyphBitmapIdentity {readonly owner: object; readonly key: string;}
interface Provider {readonly identity?: NativeGlyphBitmapIdentity; acquire(signal: AbortSignal): NativeGlyphBitmapLease; inspect(): NativeGlyphBitmapState;}

/** Immutable raster recipe. Pixel storage is leased only while an image host snapshots it. */
export function createNativeGlyphBitmap(width: number, height: number, acquire: Provider['acquire'], inspect: Provider['inspect'], identity?: NativeGlyphBitmapIdentity): object {
  const value = {width, height};
  Object.defineProperty(value, protocol, {value: Object.freeze({acquire, inspect, ...(identity === undefined ? {} : {identity})}), enumerable: false});
  return Object.freeze(value);
}
function provider(value: unknown): Provider | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, protocol);
  if (!descriptor) return undefined;
  const candidate = descriptor.value as Provider | undefined;
  if (!candidate || typeof candidate.acquire !== 'function' || typeof candidate.inspect !== 'function')
    textFail('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts.bitmap', 'invalid private native glyph raster provider');
  return candidate;
}
/** Stable semantic identity survives bounded recipe-cache eviction; a new font owner has a new epoch. */
export function nativeGlyphBitmapIdentity(value: unknown): NativeGlyphBitmapIdentity | undefined {const identity=provider(value)?.identity;if(identity!==undefined&&(!identity||!identity.owner||typeof identity.owner!=='object'||typeof identity.key!=='string'||!identity.key.length))textFail('E_HYA_RUNTIME_HOST_PORT','$.host.fonts.bitmap','invalid native glyph identity');return identity;}

export function inspectNativeGlyphBitmap(value: unknown): NativeGlyphBitmapState | undefined {return provider(value)?.inspect();}

/** External image hosts always receive the real Canvas, including cancellation and late-result paths. */
export async function snapshotNativeGlyphBitmap<T extends Readonly<{value: unknown; release(): void}>>(value: unknown, signal: AbortSignal, snapshot: (value: unknown, signal: AbortSignal) => Promise<T>): Promise<T> {
  const selected = provider(value);
  if (!selected) return snapshot(value, signal);
  const lease = selected.acquire(signal);
  let failed = false, failure: unknown, image: T | undefined;
  try {
    image = await snapshot(lease.value, signal);
    if (image && image.value === lease.value) {
      const error = new ProductionTextError('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts.bitmap', 'image snapshot must not borrow the leased mutable canvas');
      try {image.release();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Invalid glyph snapshot and image cleanup failed.');}
      throw error;
    }
    return image;
  }
  catch (error) {failed = true; failure = error; throw error;}
  finally {
    try {lease.release();}
    catch (error) {
      const errors = failed ? [failure, error] : [error];
      // A successful image cannot be handed to the texture owner when raster cleanup rejects the result.
      if (!failed && image) try {image.release();} catch (cleanup) {errors.push(cleanup);}
      if (errors.length > 1) throw new AggregateError(errors, 'Glyph snapshot and resource cleanup failed.');
      throw error;
    }
  }
}
