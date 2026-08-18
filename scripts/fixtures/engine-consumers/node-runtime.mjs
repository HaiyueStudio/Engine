import { World } from '@haiyue/engine';
import { Easing, TweenManager } from '@haiyue/engine/tween';
import {
  ANIMATION_FORMAT,
  decodeAnimationBinary,
  encodeAnimationBinary,
  parseAnimation,
} from '@haiyue/animation-spec';
import { convertLottieDocument } from '@haiyue/animation-spec/lottie';
import { getEngineDiagnosticsSnapshot } from '@haiyue/engine/diagnostics';
import { Animation3DMixer } from '@haiyue/extensions/animation3d';
import { createGltfPlugin } from '@haiyue/extensions/gltf';
import { createGltfAnimation3DRuntime } from '@haiyue/extensions/gltf-animation3d';

const target = { opacity: 0 };
const tweens = new TweenManager();
tweens.create(target, { duration: 100, easing: Easing.linear }).to({ opacity: 1 });
tweens.update(0, 50);
if (target.opacity !== 0.5) throw new Error(`Packed tween runtime returned ${target.opacity}.`);

const document = convertLottieDocument({
  v: '5.10.0',
  fr: 60,
  ip: 0,
  op: 60,
  w: 16,
  h: 16,
  nm: 'packed-consumer',
  layers: [],
});
const parsed = parseAnimation(document);
const decoded = decodeAnimationBinary(encodeAnimationBinary(document));
if (parsed.format !== ANIMATION_FORMAT || decoded.format !== ANIMATION_FORMAT) {
  throw new Error('Packed HYA codec round-trip lost the format marker.');
}

if (!(new World() instanceof World)) throw new Error('Packed engine root export is not constructible.');
if (getEngineDiagnosticsSnapshot({}).enabled) throw new Error('Unregistered packed diagnostics must be disabled.');
for (const value of [Animation3DMixer, createGltfPlugin, createGltfAnimation3DRuntime]) {
  if (typeof value !== 'function') throw new Error('Packed extensions entrypoint is missing a runtime export.');
}

process.stdout.write(JSON.stringify({
  status: 'passed',
  format: decoded.format,
  duration: document.duration,
  tweenOpacity: target.opacity,
}));
