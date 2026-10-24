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
import { OwnerSafeAudioMixer, type AudioMixerPlayRequest } from '@haiyue/engine/experimental/audio';
import { BrowserMultiplayerInput, type MultiplayerInputSnapshot } from '@haiyue/engine/experimental/simulation';
import { GuiToast, type GuiToastOptions, type GuiFontOptions } from '@haiyue/engine/gui';
import type { AnimationTextStyleRun } from '@haiyue/animation-spec';
import { InteractionRuntime, type RuntimeInteractionDocument } from '@haiyue/extensions/animation';
import { VirtualJoystickControls, type VirtualJoystickOptions } from '@haiyue/extensions/controls';

// Check that the admitted 0.2.0 declarations resolve from installed tarballs.
export type CapabilityContracts = [AudioMixerPlayRequest, MultiplayerInputSnapshot,
  GuiFontOptions, AnimationTextStyleRun, RuntimeInteractionDocument, VirtualJoystickOptions];
void OwnerSafeAudioMixer;
void BrowserMultiplayerInput;
void InteractionRuntime;
void VirtualJoystickControls;

const toastOptions: GuiToastOptions = { text: 'Saved', durationMs: 2200, animationMs: 180 };
const toast = new GuiToast(toastOptions);
toast.show({ text: 'Replaced', icon: null });
toast.hide();

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

import { createFrameGraphInspector, type FrameGraphInspector, type FrameGraphSnapshot } from '@haiyue/engine/experimental/renderer';
declare const renderSystem: Parameters<typeof createFrameGraphInspector>[0];
const inspector: FrameGraphInspector = createFrameGraphInspector(renderSystem);
inspector.requestCapture();
const frameGraphSnapshot: FrameGraphSnapshot | null = inspector.snapshot();
void frameGraphSnapshot;
inspector.dispose();

import { createHyaPlayer, type HyaPlayer, type HyaPlayerOptions } from '@haiyue/extensions/hya-player';
import { createHyaTextShaper, type HyaFontPort, type HyaTextShaper } from '@haiyue/extensions/hya-text';
import { createHyaLayout, type HyaLayout } from '@haiyue/extensions/hya-layout';
import { createHyaData, createHyaSemantics, type HyaData, type HyaSemantics } from '@haiyue/extensions/hya-data';
import { createHyaAudio, createBrowserHyaAudioHost, type HyaAudio, type HyaAudioHost } from '@haiyue/extensions/hya-audio';
import type { HyaCompositionDocument, ResponsiveLayoutDocument, HyaDataBindingDocument,
  HyaSemanticsDocument, HyaAudioEventDocument } from '@haiyue/animation-spec/hya-production';

// Compile actual factory calls across installed declarations, not only unused imports.
export async function consumeHya(parts: {
  composition: HyaCompositionDocument; layout: ResponsiveLayoutDocument;
  data: HyaDataBindingDocument; semantics: HyaSemanticsDocument; audio: HyaAudioEventDocument;
}, fonts: HyaFontPort, host: HyaAudioHost, options: HyaPlayerOptions): Promise<void> {
  const data: HyaData = createHyaData(parts.data);
  const text: HyaTextShaper = await createHyaTextShaper(parts.layout, fonts);
  const layout: HyaLayout = createHyaLayout(parts.layout, { text });
  const semantics: HyaSemantics = createHyaSemantics(parts.semantics, { bindings: data, action() {} });
  const audio: HyaAudio = await createHyaAudio(parts.audio, host);
  const player: HyaPlayer = await createHyaPlayer(parts.composition, options);
  player.dispose(); audio.dispose(); semantics.dispose(); layout.dispose(); text.dispose(); data.dispose();
}
export function consumeBrowserHyaAudio(context: AudioContext): Promise<HyaAudioHost> {
  return createBrowserHyaAudioHost(context);
}
