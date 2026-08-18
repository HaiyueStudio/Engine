import {
  CharacterPassRenderer,
  type CharacterPass,
  type CharacterPassFrame,
} from './CharacterPassRenderer';
import { DualBackendRenderer, type DualBackendFrame, type ShowcaseUniformState } from './DualBackendRenderer';
import { InspectorPanel } from './InspectorPanel';
import { PbrMaterialRenderer, type PbrMaterialFrame, type PbrMaterialState } from './PbrMaterialRenderer';
import { SHADER_LANGUAGE_SHOWCASE } from './generated/showcase.generated';

const state: MutableShowcaseState = {
  time: 0.72,
  noiseScale: 24,
  noiseStrength: 0.105,
  gradientBias: 0.02,
  scanStrength: 0.11,
  vignetteStrength: 1.45,
  tintA: [0.18, 0.98, 0.9, 1],
  tintB: [1, 0.16, 0.66, 1],
  pbrMetallic: 0.72,
  pbrRoughness: 0.26,
  pbrNoiseScale: 7.5,
  pbrNoiseStrength: 0.075,
};

interface MutableShowcaseState {
  time: number;
  noiseScale: number;
  noiseStrength: number;
  gradientBias: number;
  scanStrength: number;
  vignetteStrength: number;
  tintA: [number, number, number, number];
  tintB: [number, number, number, number];
  pbrMetallic: number;
  pbrRoughness: number;
  pbrNoiseScale: number;
  pbrNoiseStrength: number;
}

async function main(): Promise<void> {
  const regression = new URLSearchParams(location.search).get('regression') === '1';
  new InspectorPanel(query<HTMLElement>('#inspector'));
  populateStaticIdentity();
  bindControls();
  query<HTMLElement>('#load-state').textContent = 'creating generated pipelines + loading 19-joint glTF…';
  const [dualRenderer, pbrRenderer, characterRenderer] = await Promise.all([
    DualBackendRenderer.create(
      query<HTMLCanvasElement>('#webgpu-canvas'),
      query<HTMLCanvasElement>('#webgl-canvas'),
      query<HTMLCanvasElement>('#difference-canvas'),
    ),
    PbrMaterialRenderer.create(query<HTMLCanvasElement>('#pbr-canvas')),
    CharacterPassRenderer.create(characterCanvases()),
  ]);
  query<HTMLElement>('#load-state').textContent = 'all artifacts loaded · runtime compiler absent';
  setBackendStatus('webgpu', dualRenderer.evidence.webgpuCompilationErrorCount === 0 && dualRenderer.evidence.webgpuValidationErrorCount === 0);
  setBackendStatus('webgl', dualRenderer.evidence.webglCompileErrorCount === 0 && dualRenderer.evidence.webglLinkErrorCount === 0);
  query<HTMLElement>('#pbr-status').textContent = pbrRenderer.compilationErrorCount === 0 ? 'generated graph · validation 0' : 'failed';
  query<HTMLElement>('#pbr-status').dataset.passed = String(pbrRenderer.compilationErrorCount === 0);
  query<HTMLElement>('#character-status').textContent = `${characterRenderer.evidence.jointCount} joints · 5 shared passes`;
  query<HTMLElement>('#character-status').dataset.passed = 'true';

  let queued = false;
  let rendering = false;
  let shuttingDown = false;
  let renderTask: Promise<void> | null = null;
  let pendingDeltaSeconds = 0;
  let lastDual: DualBackendFrame | null = null;
  let lastPbr: PbrMaterialFrame | null = null;
  let lastCharacter: CharacterPassFrame | null = null;
  const requestRender = (deltaSeconds = 0): void => {
    if (shuttingDown) return;
    pendingDeltaSeconds = Math.min(0.1, pendingDeltaSeconds + deltaSeconds);
    queued = true;
    if (rendering) return;
    rendering = true;
    renderTask = (async () => {
      try {
        while (queued && !shuttingDown) {
          queued = false;
          const delta = pendingDeltaSeconds;
          pendingDeltaSeconds = 0;
          [lastDual, lastPbr, lastCharacter] = await Promise.all([
            dualRenderer.render(snapshotState()),
            pbrRenderer.render(snapshotPbrState()),
            characterRenderer.render(delta, state.time),
          ]);
          if (shuttingDown) break;
          publishEvidence(lastDual, lastPbr, lastCharacter, dualRenderer, pbrRenderer, characterRenderer);
        }
      } catch (error) {
        if (!shuttingDown) fail(error);
      } finally {
        rendering = false;
        renderTask = null;
        if (queued && !shuttingDown) requestRender();
      }
    })();
  };
  document.addEventListener('showcase-parameters-changed', () => requestRender());

  // Two deterministic frames make history-based motion measurable before the
  // regression fixture is allowed to report success.
  await characterRenderer.render(0, state.time, true);
  lastDual = await dualRenderer.render(snapshotState());
  lastPbr = await pbrRenderer.render(snapshotPbrState());
  lastCharacter = await characterRenderer.render(regression ? 0.1 : 1 / 30, state.time + 0.35);
  publishEvidence(lastDual, lastPbr, lastCharacter, dualRenderer, pbrRenderer, characterRenderer);

  let animate = !regression;
  const animationToggle = query<HTMLInputElement>('#animate');
  animationToggle.checked = animate;
  animationToggle.addEventListener('change', () => {
    animate = animationToggle.checked;
    query<HTMLElement>('#animate-value').textContent = animate ? 'running' : 'paused';
  });
  let previous = performance.now();
  let animationFrameId = 0;
  const tick = (now: number): void => {
    if (shuttingDown) return;
    const delta = Math.min(0.05, Math.max(0, (now - previous) * 0.001));
    previous = now;
    if (animate) {
      state.time = (state.time + delta * 0.85) % (Math.PI * 2);
      syncTimeControl();
      requestRender(delta);
    }
    animationFrameId = requestAnimationFrame(tick);
  };
  animationFrameId = requestAnimationFrame(tick);
  let resourcesDisposed = false;
  const disposeRenderers = (): void => {
    if (resourcesDisposed) return;
    resourcesDisposed = true;
    dualRenderer.dispose();
    pbrRenderer.dispose();
    characterRenderer.dispose();
  };
  window.addEventListener('pagehide', () => {
    shuttingDown = true;
    queued = false;
    pendingDeltaSeconds = 0;
    cancelAnimationFrame(animationFrameId);

    // A readback buffer cannot be destroyed while mapAsync() is pending. Let
    // the current composite frame settle, suppressing teardown-only failures,
    // and release all three renderer devices exactly once afterwards.
    const pending = renderTask;
    if (pending) void pending.finally(disposeRenderers).catch(() => {});
    else disposeRenderers();
  }, { once: true });
}

function bindControls(): void {
  bindRange('time', value => { state.time = value; }, value => value.toFixed(2));
  bindRange('noise-scale', value => { state.noiseScale = value; }, value => value.toFixed(1));
  bindRange('noise-strength', value => { state.noiseStrength = value; }, value => value.toFixed(3));
  bindRange('gradient-bias', value => { state.gradientBias = value; }, value => value.toFixed(2));
  bindRange('scan-strength', value => { state.scanStrength = value; }, value => value.toFixed(2));
  bindRange('vignette-strength', value => { state.vignetteStrength = value; }, value => value.toFixed(2));
  bindRange('pbr-metallic', value => { state.pbrMetallic = value; }, value => value.toFixed(2));
  bindRange('pbr-roughness', value => { state.pbrRoughness = value; }, value => value.toFixed(2));
  bindRange('pbr-noise-scale', value => { state.pbrNoiseScale = value; }, value => value.toFixed(1));
  bindRange('pbr-noise-strength', value => { state.pbrNoiseStrength = value; }, value => value.toFixed(3));
  bindColor('tint-a', color => { state.tintA = [...color, 1]; });
  bindColor('tint-b', color => { state.tintB = [...color, 1]; });
}

function bindRange(id: string, apply: (value: number) => void, format: (value: number) => string): void {
  const input = query<HTMLInputElement>(`#${id}`);
  const output = query<HTMLOutputElement>(`#${id}-value`);
  const initial = Number(input.value);
  apply(initial);
  output.value = format(initial);
  input.addEventListener('input', () => {
    const value = Number(input.value);
    apply(value);
    output.value = format(value);
    document.dispatchEvent(new Event('showcase-parameters-changed'));
  });
}

function bindColor(id: string, apply: (value: readonly [number, number, number]) => void): void {
  const input = query<HTMLInputElement>(`#${id}`);
  input.addEventListener('input', () => {
    apply(parseHexColor(input.value));
    document.dispatchEvent(new Event('showcase-parameters-changed'));
  });
  apply(parseHexColor(input.value));
}

function populateStaticIdentity(): void {
  query<HTMLElement>('#canonical-hash').textContent = SHADER_LANGUAGE_SHOWCASE.canonicalHash.slice(0, 16);
  query<HTMLElement>('#wgsl-hash').textContent = SHADER_LANGUAGE_SHOWCASE.wgsl.compositionHash.slice(0, 12);
  query<HTMLElement>('#glsl-hash').textContent = SHADER_LANGUAGE_SHOWCASE.glsl.backendHash.slice(0, 12);
  query<HTMLElement>('#node-count').textContent = String(SHADER_LANGUAGE_SHOWCASE.metrics.nodeCount);
  query<HTMLElement>('#resource-count').textContent = String(SHADER_LANGUAGE_SHOWCASE.metrics.resourceCount);
  query<HTMLElement>('#pipeline-count').textContent = String(2 + 1 + SHADER_LANGUAGE_SHOWCASE.metrics.characterPassCount);
  query<HTMLElement>('#runtime-compiler').textContent = SHADER_LANGUAGE_SHOWCASE.runtimeCompilerIncluded ? 'included' : 'not bundled';
  query<HTMLElement>('#pbr-graph-hash').textContent = SHADER_LANGUAGE_SHOWCASE.pbr.canonicalHash.slice(0, 12);
  query<HTMLElement>('#pbr-variants').textContent = `${SHADER_LANGUAGE_SHOWCASE.metrics.pbrReachableSpecializationVariants} reachable / ${SHADER_LANGUAGE_SHOWCASE.metrics.pbrMaximumSpecializationVariants} budget`;
  query<HTMLElement>('#deformation-hash').textContent = SHADER_LANGUAGE_SHOWCASE.character.deformationModuleHash.slice(0, 12);
}

function publishEvidence(
  dual: DualBackendFrame,
  pbr: PbrMaterialFrame,
  character: CharacterPassFrame,
  dualRenderer: DualBackendRenderer,
  pbrRenderer: PbrMaterialRenderer,
  characterRenderer: CharacterPassRenderer,
): void {
  query<HTMLElement>('#max-delta').textContent = String(dual.difference.maxChannelDelta);
  query<HTMLElement>('#mean-delta').textContent = dual.difference.meanAbsoluteDelta.toFixed(4);
  query<HTMLElement>('#changed-ratio').textContent = `${(dual.difference.changedPixelRatio * 100).toFixed(2)}%`;
  query<HTMLElement>('#uniform-writes').textContent = String(dual.uniformWriteCount + pbr.uniformWriteCount + character.totalUploadCallCount);
  query<HTMLElement>('#pipeline-rebuilds').textContent = String(dual.pipelineRebuildCount + pbr.pipelineRebuildCount + character.pipelineRebuildCount);
  query<HTMLElement>('#pbr-visible').textContent = pbr.visiblePixelCount.toLocaleString();
  query<HTMLElement>('#character-mismatch').textContent = String(character.silhouetteMismatchPixels);
  query<HTMLElement>('#character-uploads').textContent = `${character.frameUploadCallCount}/frame`;
  query<HTMLElement>('#character-velocity').textContent = String(character.passes['motion-vector'].maximumNeutralChannelDelta);
  for (const pass of characterPasses()) {
    const node = query<HTMLElement>(`[data-pass-metric="${pass}"]`);
    node.textContent = `${character.passes[pass].visiblePixelCount.toLocaleString()} px`;
  }

  const dualPassed = dual.difference.maxChannelDelta <= 2
    && Object.values(dualRenderer.evidence).every(value => value === 0);
  const pbrPassed = pbr.visiblePixelCount > 1_000
    && pbrRenderer.compilationErrorCount === 0
    && pbrRenderer.validationErrorCount === 0;
  const moduleHashes = Object.values(characterRenderer.evidence.passModuleHashes);
  const characterPassed = characterRenderer.evidence.compilationErrorCount === 0
    && characterRenderer.evidence.validationErrorCount === 0
    && characterRenderer.evidence.passCount === 5
    && characterRenderer.evidence.usesAnimation3DMixer
    && characterRenderer.evidence.usesAnimation3DPoseBuffer
    && new Set(moduleHashes).size === 1
    && character.silhouetteMismatchPixels === 0
    && character.frameUploadCallCount === 2
    && character.multiPassDuplicateUploads === 0
    && characterPasses().every(pass => character.passes[pass].visiblePixelCount > 0)
    && character.passes['motion-vector'].maximumNeutralChannelDelta > 1;
  const passed = dualPassed && pbrPassed && characterPassed;
  const badge = query<HTMLElement>('#parity-badge');
  badge.dataset.passed = String(dualPassed);
  badge.textContent = dualPassed ? 'Pixel parity passed' : 'Pixel parity failed';
  const consistency = query<HTMLElement>('#character-consistency');
  consistency.dataset.passed = String(characterPassed);
  consistency.textContent = characterPassed ? '5 Pass consistency passed' : '5 Pass consistency failed';
  document.body.dataset.renderStatus = passed ? 'ready' : 'failed';
  const result = query<HTMLElement>('#result');
  result.textContent = JSON.stringify({
    schemaVersion: 2,
    suite: 'shader-language-lab-example',
    status: passed ? 'passed' : 'failed',
    runtimeCompilerIncluded: SHADER_LANGUAGE_SHOWCASE.runtimeCompilerIncluded,
    productRendererContract: SHADER_LANGUAGE_SHOWCASE.productRendererContract,
    canonicalHash: SHADER_LANGUAGE_SHOWCASE.canonicalHash,
    wgslCompositionHash: SHADER_LANGUAGE_SHOWCASE.wgsl.compositionHash,
    glslBackendHash: SHADER_LANGUAGE_SHOWCASE.glsl.backendHash,
    ...dualRenderer.evidence,
    maxChannelDelta: dual.difference.maxChannelDelta,
    meanAbsoluteDelta: dual.difference.meanAbsoluteDelta,
    changedPixelRatio: dual.difference.changedPixelRatio,
    pipelineCount: 2 + 1 + characterRenderer.evidence.passCount,
    pipelineRebuildCount: dual.pipelineRebuildCount + pbr.pipelineRebuildCount + character.pipelineRebuildCount,
    uniformWriteCount: dual.uniformWriteCount + pbr.uniformWriteCount + character.totalUploadCallCount,
    pbr: {
      canonicalHash: SHADER_LANGUAGE_SHOWCASE.pbr.canonicalHash,
      compositionHash: SHADER_LANGUAGE_SHOWCASE.pbr.compositionHash,
      graphNodeCount: SHADER_LANGUAGE_SHOWCASE.metrics.pbrGraphNodeCount,
      reachableSpecializationVariants: SHADER_LANGUAGE_SHOWCASE.metrics.pbrReachableSpecializationVariants,
      maximumSpecializationVariants: SHADER_LANGUAGE_SHOWCASE.metrics.pbrMaximumSpecializationVariants,
      reachablePilotFamilyVariants: SHADER_LANGUAGE_SHOWCASE.metrics.pbrReachablePilotFamilyVariants,
      maximumPilotFamilyVariants: SHADER_LANGUAGE_SHOWCASE.metrics.pbrMaximumPilotFamilyVariants,
      compilationErrorCount: pbrRenderer.compilationErrorCount,
      validationErrorCount: pbrRenderer.validationErrorCount,
      visiblePixelCount: pbr.visiblePixelCount,
      averageRgba8: pbr.averageRgba8,
      pipelineRebuildCount: pbr.pipelineRebuildCount,
    },
    character: {
      ...characterRenderer.evidence,
      passes: character.passes,
      silhouetteMismatchPixels: character.silhouetteMismatchPixels,
      frameUploadCallCount: character.frameUploadCallCount,
      multiPassDuplicateUploads: character.multiPassDuplicateUploads,
      totalDrawCount: character.totalDrawCount,
      totalSubmitCount: character.totalSubmitCount,
      pipelineRebuildCount: character.pipelineRebuildCount,
      mixerTime: character.mixerTime,
      morphWeights: character.morphWeights,
    },
  });
  result.dataset.status = passed ? 'passed' : 'failed';
}

function setBackendStatus(backend: 'webgpu' | 'webgl', passed: boolean): void {
  const node = query<HTMLElement>(`#${backend}-status`);
  node.dataset.passed = String(passed);
  node.textContent = passed ? 'compiled · validation 0' : 'failed';
}

function syncTimeControl(): void {
  const input = query<HTMLInputElement>('#time');
  input.value = state.time.toFixed(2);
  query<HTMLOutputElement>('#time-value').value = state.time.toFixed(2);
}

function snapshotState(): ShowcaseUniformState {
  return Object.freeze({
    ...state,
    tintA: Object.freeze([...state.tintA]) as readonly [number, number, number, number],
    tintB: Object.freeze([...state.tintB]) as readonly [number, number, number, number],
  });
}

function snapshotPbrState(): PbrMaterialState {
  return Object.freeze({
    time: state.time,
    metallic: state.pbrMetallic,
    roughness: state.pbrRoughness,
    noiseScale: state.pbrNoiseScale,
    noiseStrength: state.pbrNoiseStrength,
  });
}

function characterCanvases(): Readonly<Record<CharacterPass, HTMLCanvasElement>> {
  return Object.freeze(Object.fromEntries(characterPasses().map(pass => [
    pass,
    query<HTMLCanvasElement>(`[data-character-pass="${pass}"]`),
  ]))) as Readonly<Record<CharacterPass, HTMLCanvasElement>>;
}

function characterPasses(): readonly CharacterPass[] {
  return SHADER_LANGUAGE_SHOWCASE.character.passOrder;
}

function parseHexColor(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`Invalid color ${value}.`);
  const numeric = Number.parseInt(match[1]!, 16);
  return [(numeric >> 16 & 255) / 255, (numeric >> 8 & 255) / 255, (numeric & 255) / 255];
}

function fail(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  document.body.dataset.renderStatus = 'failed';
  const result = query<HTMLElement>('#result');
  result.textContent = JSON.stringify({ schemaVersion: 2, suite: 'shader-language-lab-example', status: 'failed', error: message });
  result.dataset.status = 'failed';
  query<HTMLElement>('#parity-badge').textContent = 'Initialization failed';
  query<HTMLElement>('#load-state').textContent = message.split('\n')[0] ?? 'failed';
  console.error(error);
}

function query<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Shader Language Lab is missing ${selector}.`);
  return value;
}

void main().catch(fail);
