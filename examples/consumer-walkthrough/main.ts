import {
  BasicMaterial,
  CartesianTransform3D,
  Entity,
  HaiyueEngine,
  Mesh3D,
  createBox3D,
} from '@haiyue/engine';
import type { AssetHandle } from '@haiyue/engine/assets';

async function main(): Promise<void> {
  const canvas = requiredElement<HTMLCanvasElement>('#canvas');
  const status = requiredElement<HTMLOutputElement>('#status');
  const result = requiredElement<HTMLOutputElement>('#result');
  const disposeButton = requiredElement<HTMLButtonElement>('#dispose');
  const regression = new URLSearchParams(location.search).get('regression') === '1';
  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'batched',
    clearColor: { r: 0.025, g: 0.055, b: 0.1, a: 1 },
  });

  let textureHandle: AssetHandle<GPUTexture> | null = null;
  let disposed = false;
  let renderedFrames = 0;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    engine.stop();
    textureHandle?.release();
    textureHandle = null;
    engine.destroy();
    status.textContent = '已释放 texture handle、场景和 WebGPU owner';
  };

  try {
    await engine.init();
    const assetManager = engine.assetManager;
    if (!assetManager) throw new Error('Engine initialized without an AssetManager.');
    textureHandle = await assetManager.loadTexture(
      new URL('../../animation-spec/samples/assets/sprite1.png', import.meta.url).href,
      { label: 'consumer-walkthrough-checker', mipmaps: 'generate' },
    );

    const transform = new CartesianTransform3D();
    const cube = new Entity('Loaded and animated cube');
    cube.addComponent(transform);
    cube.addComponent(new Mesh3D(
      createBox3D(),
      new BasicMaterial({ texture: textureHandle.value }),
    ));

    const scene = engine.createScene({ name: 'Consumer walkthrough', render3D: true });
    scene.add(cube);
    engine.switchScene(scene);
    engine.on('update', ({ detail: { time } }) => {
      transform.setRotation(time * 0.00035, time * 0.00065, 0);
    });
    engine.on('after-update', () => {
      renderedFrames += 1;
      if (renderedFrames === 1) {
        status.textContent = '已安装、初始化、加载纹理并开始动画';
      }
      if (regression && renderedFrames === 8) {
        dispose();
        result.dataset.status = 'passed';
        result.textContent = JSON.stringify({
          status: 'passed',
          installed: true,
          rendered: true,
          assetLoaded: true,
          animated: true,
          disposed,
          renderedFrames,
        });
      }
    });
    engine.run();

    disposeButton.addEventListener('click', dispose, { once: true });
    window.addEventListener('beforeunload', dispose, { once: true });
  } catch (error) {
    dispose();
    throw error;
  }
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

void main().catch(error => {
  const result = document.querySelector<HTMLOutputElement>('#result');
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const compatibility = HaiyueEngine.webGpuCompatibility.classifyError(error);
  if (compatibility) {
    HaiyueEngine.webGpuCompatibility.renderPage(document.body, compatibility, {
      productName: 'Haiyue Consumer Walkthrough',
    });
  } else {
    console.error(error);
  }
});
