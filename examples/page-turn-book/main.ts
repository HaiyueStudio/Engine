import {
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  HaiyueEngine,
  Mesh3D,
  OrbitControl,
  PbrMaterial,
  SphericalTransform3D,
  createPlane3D,
  type Scene,
} from '@haiyue/engine';
import { InteractionSystem } from '@haiyue/engine/systems';
import { PdfBookDocument } from './PdfBookDocument';
import {
  PageTurnBook,
  PageTurnBookSystem,
  type PageTurnBookState,
} from './PageTurnBook';

interface BookUi {
  status: HTMLElement;
  pageLabel: HTMLElement;
  documentLabel: HTMLElement;
  cacheLabel: HTMLElement;
  progress: HTMLProgressElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  openPdf: HTMLButtonElement;
  fileInput: HTMLInputElement;
}

interface BookSession {
  scene: Scene;
  book: PageTurnBook;
}

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const ui: BookUi = {
    status: query('#status'),
    pageLabel: query('#page-label'),
    documentLabel: query('#document-label'),
    cacheLabel: query('#cache-label'),
    progress: query('#turn-progress'),
    previous: query('#previous'),
    next: query('#next'),
    openPdf: query('#open-pdf'),
    fileInput: query('#pdf-file'),
  };
  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 4,
    clearColor: { r: 0.045, g: 0.052, b: 0.062, a: 1 },
  });
  await engine.init();

  let activeSession: BookSession | null = null;
  let engineStarted = false;
  let loadGeneration = 0;
  let renderedFrames = 0;

  const openDocument = async (source: string | Blob, fileName: string): Promise<void> => {
    const generation = ++loadGeneration;
    setLoadingUi(ui, fileName);
    let provider: PdfBookDocument | null = null;
    try {
      provider = await PdfBookDocument.open(source, {
        onLoadProgress: (loaded, total) => {
          if (generation !== loadGeneration) return;
          ui.status.textContent = total
            ? `Loading ${fileName}… ${Math.round(loaded / total * 100)}%`
            : `Loading ${fileName}… ${formatBytes(loaded)}`;
        },
        onCacheChange: pages => {
          if (generation !== loadGeneration) return;
          document.body.dataset.pdfResidentPages = pages.map(page => page + 1).join(',');
        },
      });
      if (generation !== loadGeneration) {
        await provider.destroy();
        return;
      }

      const session = await createBookSession(engine, canvas, provider, fileName, ui);
      if (generation !== loadGeneration) {
        session.scene.destroy();
        return;
      }
      const previousSession = activeSession;
      activeSession = session;
      renderedFrames = 0;
      document.body.dataset.renderStatus = 'loading';
      document.body.dataset.pdfFile = fileName;
      document.body.dataset.pdfPageCount = String(provider.pageCount);
      engine.switchScene(session.scene);
      previousSession?.scene.destroy();
      if (!engineStarted) {
        engine.run();
        engineStarted = true;
      }
    } catch (error) {
      if (provider) await provider.destroy().catch(() => {});
      if (generation !== loadGeneration) return;
      showError(ui, error);
    } finally {
      if (generation === loadGeneration) {
        ui.openPdf.disabled = false;
        ui.fileInput.disabled = false;
      }
    }
  };

  ui.previous.addEventListener('click', () => activeSession?.book.flipBackward());
  ui.next.addEventListener('click', () => activeSession?.book.flipForward());
  ui.openPdf.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    ui.fileInput.value = '';
    if (file) void openDocument(file, file.name);
  });
  window.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
    if (event.key === 'ArrowLeft') activeSession?.book.flipBackward();
    else if (event.key === 'ArrowRight' || event.key === ' ') activeSession?.book.flipForward();
  });

  engine.on('after-update', () => {
    if (!activeSession || ++renderedFrames !== 4) return;
    document.body.dataset.renderStatus = 'passed';
    document.body.dataset.pageSegments = '48x12';
    document.body.dataset.pageContentKinds = 'pdfjs';
    document.body.dataset.pageInteraction = 'click,drag';
    document.body.dataset.cameraInteraction = 'orbit,pan,zoom';
    document.body.dataset.pdfLazyWindow = '6';
  });

  await openDocument('./ai.pdf', 'ai.pdf');
}

async function createBookSession(
  engine: HaiyueEngine,
  canvas: HTMLCanvasElement,
  provider: PdfBookDocument,
  fileName: string,
  ui: BookUi,
): Promise<BookSession> {
  const scene = engine.createScene({
    name: `PDF book: ${fileName}`,
    camera: {
      camera3D: {
        type: 'perspective',
        fov: Math.PI / 4.5,
        near: 0.1,
        far: 60,
      },
      orbit: {
        radius: 14.8,
        theta: -Math.PI * 0.08,
        phi: Math.PI * 0.28,
        target: [0, 0.55, 0],
      },
    },
    render3D: { renderProfile: 'batched' },
    render2D: false,
    gui: false,
  });
  addLighting(scene);
  addTable(scene);

  const cameraTransform = scene.cameraEntity.getComponent(SphericalTransform3D);
  if (!cameraTransform) throw new Error('PDF book example requires a spherical camera.');
  const orbitControl = new OrbitControl(canvas, cameraTransform, {
    enableRotate: true,
    enablePan: true,
    enableZoom: true,
    minRadius: 10,
    maxRadius: 23,
    minPhi: Math.PI * 0.08,
    maxPhi: Math.PI * 0.47,
    rotateSpeed: 0.72,
    panSpeed: 0.58,
    zoomSpeed: 0.72,
  });
  let pageHovered = false;
  let pageInteractionActive = false;
  const syncOrbitInteraction = (): void => {
    orbitControl.enableRotate = !pageHovered && !pageInteractionActive;
  };

  const book = new PageTurnBook(scene, canvas, provider, {
    onStateChange: state => updateControls(state, fileName, ui),
    onPageHoverChange: hovered => {
      pageHovered = hovered;
      syncOrbitInteraction();
    },
    onPageInteractionChange: active => {
      pageInteractionActive = active;
      syncOrbitInteraction();
    },
    onPageLoadError: error => showError(ui, error),
  });
  scene.addSystem(new PageTurnBookSystem(book), false);
  scene.addSystem(new InteractionSystem(engine, scene.cameraEntity), false);
  scene.addSystem(orbitControl, false);
  try {
    await book.ready;
  } catch (error) {
    scene.destroy();
    throw error;
  }
  return { scene, book };
}

function addLighting(scene: Scene): void {
  const key = new Entity('Warm paper key light');
  key.addComponent(new DirectionalLight({
    color: [1, 0.86, 0.68],
    intensity: 2.15,
    direction: [-0.48, -1, -0.34],
    // Proxy page-stack boxes should not receive a cover shadow halfway down
    // their side. Keep the PBR key light, but omit the shadow map in this demo.
    castShadow: false,
  }));
  scene.add(key);

  const fill = new Entity('Soft environment fill');
  fill.addComponent(new EnvironmentLight({
    intensity: 0.34,
    diffuseColor: [0.42, 0.48, 0.56],
    specularColor: [0.7, 0.74, 0.8],
  }));
  scene.add(fill);
}

function addTable(scene: Scene): void {
  const table = new Entity('Book table');
  table.addComponent(new CartesianTransform3D({ position: [0, -0.23, 0] }));
  table.addComponent(new Mesh3D(
    createPlane3D({ width: 22, height: 17, normal: 'y' }),
    new PbrMaterial({
      baseColor: [0.12, 0.095, 0.072, 1],
      metallic: 0.04,
      roughness: 0.77,
    }),
  ));
  scene.add(table);
}

function updateControls(state: PageTurnBookState, fileName: string, ui: BookUi): void {
  ui.documentLabel.textContent = fileName;
  ui.cacheLabel.textContent = `${state.residentPageCount} / 6 textures`;
  if (state.visiblePages.length === 0) {
    ui.pageLabel.textContent = 'Back cover';
  } else if (state.visiblePages.length === 1) {
    ui.pageLabel.textContent = `Page ${state.visiblePages[0]} / ${state.pageCount}`;
  } else {
    ui.pageLabel.textContent = `Pages ${state.visiblePages[0]}–${state.visiblePages[1]} / ${state.pageCount}`;
  }
  ui.status.textContent = state.mode === 'loading'
    ? 'Rendering nearby PDF pages…'
    : state.mode === 'dragging'
      ? 'Dragging the segmented sheet'
      : state.mode === 'animating'
        ? 'Paper settling…'
        : 'Click a page, or drag it across the spine';
  ui.progress.value = state.progress;
  ui.previous.disabled = !state.canGoBack;
  ui.next.disabled = !state.canGoForward;
}

function setLoadingUi(ui: BookUi, fileName: string): void {
  ui.status.textContent = `Loading ${fileName}…`;
  ui.documentLabel.textContent = fileName;
  ui.pageLabel.textContent = 'Reading PDF';
  ui.cacheLabel.textContent = '0 / 6 textures';
  ui.progress.value = 0;
  ui.previous.disabled = true;
  ui.next.disabled = true;
  ui.openPdf.disabled = true;
  ui.fileInput.disabled = true;
}

function showError(ui: BookUi, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  ui.status.textContent = message;
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = message;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing PDF book example element: ${selector}`);
  return element;
}

main().catch(error => {
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  const status = document.querySelector<HTMLElement>('#status');
  if (status) status.textContent = document.body.dataset.renderError;
});
