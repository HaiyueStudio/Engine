import {
  CharacterPassRenderer,
  type CharacterMaterialColor,
  type CharacterMaterialState,
  type CharacterPass,
  type CharacterPassFrame,
} from '../shader-language-lab/CharacterPassRenderer';
import { SHADER_LANGUAGE_SHOWCASE } from '../shader-language-lab/generated/showcase.generated';

const state: MutableCharacterMaterialState = {
  forwardColor: [0.16, 0.78, 1, 1],
  outlineColor: [1, 0.3, 0.7, 1],
};

interface MutableCharacterMaterialState {
  forwardColor: [number, number, number, number];
  outlineColor: [number, number, number, number];
}

async function main(): Promise<void> {
  const regression = new URLSearchParams(location.search).get('regression') === '1';
  populateArtifactIdentity();
  bindMaterialControls();
  setStatus('loading real glTF + generated pass family', 'loading');

  const renderer = await CharacterPassRenderer.create(characterCanvases());
  setText('asset', `${formatBytes(renderer.evidence.assetHttpBytes)} · ${renderer.evidence.jointCount} joints`);
  setText('geometry', `${renderer.evidence.vertexCount.toLocaleString()} vertices · ${renderer.evidence.indexCount.toLocaleString()} indices`);
  setText('runtime', `${renderer.evidence.usesAnimation3DMixer ? 'Mixer' : '—'} + ${renderer.evidence.usesAnimation3DPoseBuffer ? 'PoseBuffer' : '—'}`);

  const referenceMaterial: CharacterMaterialState = Object.freeze({
    forwardColor: Object.freeze([0.98, 0.38, 0.1, 1]) as CharacterMaterialColor,
    outlineColor: Object.freeze([0.08, 0.86, 1, 1]) as CharacterMaterialColor,
  });
  const reference = await renderer.render(0, 0.72, true, referenceMaterial);
  const materialProof = await renderer.render(0, 0.72, true, snapshotMaterial());
  const materialPixelDelta = maximumColorDelta(
    reference.passes.forward.averageRgba8,
    materialProof.passes.forward.averageRgba8,
  );
  let time = 1.07;
  let latest = await renderer.render(0.1, time, false, snapshotMaterial());
  publishEvidence(renderer, latest, materialPixelDelta);

  let animate = !regression;
  let rendering = false;
  let queued = false;
  let pendingDelta = 0;
  const requestRender = (delta = 0): void => {
    pendingDelta = Math.min(0.1, pendingDelta + delta);
    queued = true;
    if (rendering) return;
    rendering = true;
    void (async () => {
      try {
        while (queued) {
          queued = false;
          const frameDelta = pendingDelta;
          pendingDelta = 0;
          latest = await renderer.render(frameDelta, time, false, snapshotMaterial());
          publishEvidence(renderer, latest, materialPixelDelta);
        }
      } catch (error) {
        fail(error);
      } finally {
        rendering = false;
        if (queued) requestRender();
      }
    })();
  };

  const toggle = query<HTMLButtonElement>('#animation-toggle');
  toggle.textContent = animate ? 'Pause animation' : 'Play animation';
  toggle.addEventListener('click', () => {
    animate = !animate;
    toggle.textContent = animate ? 'Pause animation' : 'Play animation';
  });
  document.addEventListener('character-material-changed', () => requestRender());

  if (!regression) {
    let previous = performance.now();
    const tick = (now: number): void => {
      const delta = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      if (animate) {
        time += delta;
        requestRender(delta);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  window.addEventListener('pagehide', () => renderer.dispose(), { once: true });
}

function publishEvidence(renderer: CharacterPassRenderer, frame: CharacterPassFrame, materialPixelDelta: number): void {
  for (const pass of characterPasses()) {
    setText(`metric-${pass}`, `${frame.passes[pass].visiblePixelCount.toLocaleString()} px`);
  }
  setText('silhouette', String(frame.silhouetteMismatchPixels));
  setText('uploads', `${frame.frameUploadCallCount}/frame`);
  setText('velocity', String(frame.passes['motion-vector'].maximumNeutralChannelDelta));
  setText('material-delta', String(materialPixelDelta));
  setText('pipeline-rebuilds', String(frame.pipelineRebuildCount));

  const hashes = Object.values(renderer.evidence.passModuleHashes);
  const passed = renderer.evidence.compilationErrorCount === 0
    && renderer.evidence.validationErrorCount === 0
    && renderer.evidence.passCount === 5
    && renderer.evidence.usesAnimation3DMixer
    && renderer.evidence.usesAnimation3DPoseBuffer
    && new Set(hashes).size === 1
    && hashes.every(hash => hash === renderer.evidence.deformationModuleHash)
    && characterPasses().every(pass => frame.passes[pass].visiblePixelCount > 0)
    && frame.silhouetteMismatchPixels === 0
    && frame.frameUploadCallCount === 2
    && frame.multiPassDuplicateUploads === 0
    && frame.passes['motion-vector'].maximumNeutralChannelDelta > 1
    && frame.pipelineRebuildCount === 0
    && materialPixelDelta > 8;
  setStatus(passed ? 'five-pass material contract passed' : 'evidence failed', passed ? 'passed' : 'failed');
  document.body.dataset.renderStatus = passed ? 'ready' : 'failed';

  const result = query<HTMLElement>('#result');
  result.textContent = JSON.stringify({
    schemaVersion: 1,
    suite: 'shader-language-character-material-example',
    status: passed ? 'passed' : 'failed',
    runtimeCompilerIncluded: SHADER_LANGUAGE_SHOWCASE.runtimeCompilerIncluded,
    productRendererContract: SHADER_LANGUAGE_SHOWCASE.productRendererContract,
    deformationOrder: ['morph', 'skinning', 'displacement'],
    historySemantics: SHADER_LANGUAGE_SHOWCASE.character.passes['motion-vector'].reflection.historySemantics,
    material: {
      forwardColor: state.forwardColor,
      outlineColor: state.outlineColor,
      pixelDeltaFromReference: materialPixelDelta,
      pipelineRebuildCount: frame.pipelineRebuildCount,
    },
    ...renderer.evidence,
    passes: frame.passes,
    silhouetteMismatchPixels: frame.silhouetteMismatchPixels,
    frameUploadCallCount: frame.frameUploadCallCount,
    multiPassDuplicateUploads: frame.multiPassDuplicateUploads,
    totalUploadCallCount: frame.totalUploadCallCount,
    totalDrawCount: frame.totalDrawCount,
    totalSubmitCount: frame.totalSubmitCount,
    pipelineRebuildCount: frame.pipelineRebuildCount,
    mixerTime: frame.mixerTime,
    morphWeights: frame.morphWeights,
  });
  result.dataset.status = passed ? 'passed' : 'failed';
}

function bindMaterialControls(): void {
  bindColor('forward-color', color => { state.forwardColor = [...color, 1]; });
  bindColor('outline-color', color => { state.outlineColor = [...color, 1]; });
}

function bindColor(id: string, apply: (value: readonly [number, number, number]) => void): void {
  const input = query<HTMLInputElement>(`#${id}`);
  apply(parseHexColor(input.value));
  input.addEventListener('input', () => {
    apply(parseHexColor(input.value));
    document.dispatchEvent(new Event('character-material-changed'));
  });
}

function populateArtifactIdentity(): void {
  setText('module-hash', SHADER_LANGUAGE_SHOWCASE.character.deformationModuleHash.slice(0, 16));
  setText('pass-count', String(SHADER_LANGUAGE_SHOWCASE.character.passOrder.length));
  setText('compiler-boundary', SHADER_LANGUAGE_SHOWCASE.runtimeCompilerIncluded ? 'runtime compiler included' : 'build-time artifact only');
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

function snapshotMaterial(): CharacterMaterialState {
  return Object.freeze({
    forwardColor: Object.freeze([...state.forwardColor]) as CharacterMaterialColor,
    outlineColor: Object.freeze([...state.outlineColor]) as CharacterMaterialColor,
  });
}

function maximumColorDelta(left: readonly number[], right: readonly number[]): number {
  return Math.max(...left.slice(0, 3).map((value, index) => Math.abs(value - (right[index] ?? 0))));
}

function parseHexColor(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`Invalid material color ${value}.`);
  const numeric = Number.parseInt(match[1]!, 16);
  return [(numeric >> 16 & 255) / 255, (numeric >> 8 & 255) / 255, (numeric & 255) / 255];
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function setStatus(message: string, status: 'loading' | 'passed' | 'failed'): void {
  const node = query<HTMLElement>('#status');
  node.textContent = message;
  node.dataset.status = status;
}

function setText(id: string, value: string): void {
  query<HTMLElement>(`#${id}`).textContent = value;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  document.body.dataset.renderStatus = 'failed';
  const result = query<HTMLElement>('#result');
  result.textContent = JSON.stringify({
    schemaVersion: 1,
    suite: 'shader-language-character-material-example',
    status: 'failed',
    error: message,
  });
  result.dataset.status = 'failed';
  setStatus(message.split('\n')[0] ?? 'initialization failed', 'failed');
  console.error(error);
}

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shader Language Character Material is missing ${selector}.`);
  return node;
}

void main().catch(fail);
