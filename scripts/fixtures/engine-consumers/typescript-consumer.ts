import { World, type HaiyueEngineOptions } from '@haiyue/engine';
import { TweenManager, type TweenOptions } from '@haiyue/engine/tween';
import { createCSGWorkerSource } from '@haiyue/engine/geometry';
import {
  ANIMATION_FORMAT,
  type AnimationDocument,
  parseAnimation,
} from '@haiyue/animation-spec';
import { convertLottieDocument } from '@haiyue/animation-spec/lottie';
import {
  NATIVE_3D_ANIMATION_EXTENSION_ID,
  type Native3DAnimationPayload,
} from '@haiyue/animation-spec/native3d';
import { getEngineDiagnosticsSnapshot } from '@haiyue/engine/diagnostics';
import { Animation3DMixer } from '@haiyue/extensions/animation3d';
import { createGltfPlugin, type LoadGltfOptions } from '@haiyue/extensions/gltf';
import { createGltfAnimation3DRuntime } from '@haiyue/extensions/gltf-animation3d';

const options: HaiyueEngineOptions = { canvas: '#canvas' };
const tweenOptions: TweenOptions = { duration: 250 };
const world = new World();
const manager = new TweenManager();
declare const engine: Parameters<typeof getEngineDiagnosticsSnapshot>[0];
const diagnostics = getEngineDiagnosticsSnapshot(engine);
const gltfOptions: LoadGltfOptions = { scene: 0 };
manager.create({ value: 0 }, tweenOptions).to({ value: 1 });

const document: AnimationDocument = convertLottieDocument({
  v: '5.10.0', fr: 60, ip: 0, op: 60, w: 16, h: 16, layers: [],
});
parseAnimation(document);

declare const native3d: Native3DAnimationPayload;
void native3d;
void options;
void world;
void ANIMATION_FORMAT;
void NATIVE_3D_ANIMATION_EXTENSION_ID;
void createCSGWorkerSource;
void diagnostics;
void gltfOptions;
void Animation3DMixer;
void createGltfPlugin;
void createGltfAnimation3DRuntime;
