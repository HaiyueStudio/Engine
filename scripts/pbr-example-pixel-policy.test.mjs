import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { pbrPixelBaselinePath, comparePbrPixelBaseline, PBR_PIXEL_MODES } from './pbr-example-pixel-policy.mjs';

const rgba = Buffer.alloc(960 * 640 * 4, 100);
for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
const record = bytes => ({ hash: 'diagnostic', visual: { width: 960, height: 640, encoding: 'deflate-rgba8', rgba: deflateSync(bytes).toString('base64') } });
const image = record(rgba);
const fixture = () => ({ schemaVersion: 3, fixture: 'haiyue-pbr-showcase-clearcoat-chrome-960x640', width: 960, height: 640,
  modes: Object.fromEntries(PBR_PIXEL_MODES.map(mode => [mode, image])) });
const baseline = () => ({ ...fixture(), referencePlatform: 'win32' });

test('selects an explicit Windows reference and retains the old reference elsewhere', () => {
  assert.match(pbrPixelBaselinePath('win32'), /\.win32\.json$/);
  for (const platform of ['darwin','linux']) assert.equal(pbrPixelBaselinePath(platform), 'review/baselines/render-pixels-stage9-pbr-example.json');
  assert.throws(() => pbrPixelBaselinePath('unknown'), /Unsupported/);
  assert.throws(() => comparePbrPixelBaseline(fixture(), fixture(), 'win32'), /reviewed Windows/);
  assert.throws(() => comparePbrPixelBaseline(fixture(), baseline(), 'darwin'), /another platform/);
});

test('checks every channel in all six complete 960x640 images with the original budgets', () => {
  const result = comparePbrPixelBaseline(fixture(), baseline(), 'win32');
  assert.equal(result.status, 'passed');
  assert.equal(Object.keys(result.modes).length, 6);
  assert.deepEqual(result.modes.off.budget, {meanAbsoluteError:2,changedChannelThreshold:8,changedChannelRatio:0.02});
  const close = Buffer.from(rgba);
  for (let i = 0; i < close.length; i++) if (i % 4 !== 3) close[i]++;
  const rounded = fixture(); rounded.modes.off = record(close);
  assert.equal(comparePbrPixelBaseline(rounded, baseline(), 'win32').status, 'passed');
  for (const origin of [[300,200], [600,100]]) {
    const changed = Buffer.from(rgba), actual = fixture();
    for (let y = origin[1]; y < origin[1] + 150; y++) for (let x = origin[0]; x < origin[0] + 200; x++) {
      const offset = (y * 960 + x) * 4; changed[offset] = changed[offset+1] = changed[offset+2] = 0;
    }
    actual.modes.sheen = record(changed);
    const result = comparePbrPixelBaseline(actual, baseline(), 'win32');
    assert.equal(result.status, 'failed'); assert.equal(result.modes.sheen.status, 'failed');
  }
});

test('rejects missing or extra modes, malformed RGBA, and viewport drift', () => {
  const missing=fixture(); delete missing.modes.on;
  assert.throws(() => comparePbrPixelBaseline(missing,baseline(),'win32'), /all six/);
  const extra=fixture(); extra.modes.extra=image;
  assert.throws(() => comparePbrPixelBaseline(extra,baseline(),'win32'), /all six/);
  const size=fixture(); size.width=959;
  assert.throws(() => comparePbrPixelBaseline(size,baseline(),'win32'), /identity/);
  const clipped=fixture(); clipped.modes.off={...image,visual:{...image.visual,width:959}};
  assert.throws(() => comparePbrPixelBaseline(clipped,baseline(),'win32'), /dimensions/);
  const broken=fixture(); broken.modes.off={...image,visual:{...image.visual,rgba:deflateSync(Buffer.from([1,2])).toString('base64')}};
  assert.throws(() => comparePbrPixelBaseline(broken,baseline(),'win32'), /length/);
});
