import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng } from './png.mjs';

// Compare every RGBA channel, independently of PNG compression and native GPU
// rounding. Exact hashes remain evidence, not a cross-driver rendering contract.
export const PORTABLE_PIXEL_BUDGET = Object.freeze({ meanAbsoluteError: 2, changedChannelThreshold: 8, changedChannelRatio: 0.02 });

export function createPortablePixelRecord(png) {
  const { width, height, data } = decodePng(png);
  return { hash: createHash('sha256').update(png).digest('hex'), bytes: png.length,
    visual: { width, height, encoding: 'deflate-rgba8', rgba: deflateSync(data).toString('base64') } };
}

export function comparePortablePixelRecords(current, baseline) {
  const a = current?.visual, b = baseline?.visual;
  if (!a || !b || a.encoding !== 'deflate-rgba8' || b.encoding !== a.encoding
    || !Number.isSafeInteger(a.width) || !Number.isSafeInteger(a.height)
    || a.width <= 0 || a.height <= 0 || a.width !== b.width || a.height !== b.height) {
    throw new Error('Missing or incompatible reviewed RGBA pixel baseline.');
  }
  const expectedBytes = a.width * a.height * 4;
  const left = inflateSync(Buffer.from(a.rgba, 'base64'), { maxOutputLength: expectedBytes });
  const right = inflateSync(Buffer.from(b.rgba, 'base64'), { maxOutputLength: expectedBytes });
  if (left.length !== expectedBytes || right.length !== expectedBytes) throw new Error('Invalid RGBA reference length.');
  let absolute = 0, changed = 0;
  for (let i = 0; i < left.length; i++) {
    const delta = Math.abs(left[i] - right[i]);
    absolute += delta;
    if (delta > PORTABLE_PIXEL_BUDGET.changedChannelThreshold) changed++;
  }
  const meanAbsoluteError = absolute / left.length, changedChannelRatio = changed / left.length;
  return { status: meanAbsoluteError <= PORTABLE_PIXEL_BUDGET.meanAbsoluteError
      && changedChannelRatio <= PORTABLE_PIXEL_BUDGET.changedChannelRatio ? 'passed' : 'failed',
    exactHashMatch: current.hash === baseline.hash, meanAbsoluteError, changedChannelRatio, budget: PORTABLE_PIXEL_BUDGET };
}
