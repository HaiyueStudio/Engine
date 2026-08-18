import * as dat from 'dat.gui';
import { AmbientLight } from '@haiyue/engine/lighting';
import { Camera3D, CartesianTransform3D, DirectionalLight, Entity, Mesh3D, OrbitControl, SphericalTransform3D, HaiyueEngine } from '@haiyue/engine';
import { MeshHelper, Transform3D } from '@haiyue/engine/components';
import { applyGltfAnimationClip, GltfModelComponent, GltfModelSystem } from '@haiyue/extensions/gltf';
import { createInlineGltfAssetWorkerClient } from '@haiyue/extensions/experimental/gltf-worker';
import { requiredNumberAt } from '../arrayAccess';

type Vec3Tuple = [number, number, number];

interface LocalModelUrl {
  url: string;
  revoke(): void;
}

interface Bounds3D {
  min: Vec3Tuple;
  max: Vec3Tuple;
}

interface FitInfo {
  sourceSize: number;
  autoScale: number;
  userScale: number;
  center: Vec3Tuple;
  size: Vec3Tuple;
}

interface RuntimeModelStats {
  bounds: Bounds3D | null;
  vertexCount: number;
  triangleCount: number;
  meshCount: number;
  entityCount: number;
  textureCount: number;
}

interface SceneTreeNodeStats {
  meshCount: number;
  entityCount: number;
}

function dataUri(mime: string, bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
}

function align4(target: number[]): void {
  while (target.length % 4) target.push(0);
}

function appendFloat32(target: number[], values: number[]): number {
  align4(target);
  const offset = target.length;
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  for (let i = 0; i < view.byteLength; i++) target.push(view.getUint8(i));
  return offset;
}

function appendUint16(target: number[], values: number[]): number {
  align4(target);
  const offset = target.length;
  const view = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  for (let i = 0; i < view.byteLength; i++) target.push(view.getUint8(i));
  align4(target);
  return offset;
}

function createSampleGltfUrl(): string {
  const bufferBytesArray: number[] = [];

  const cubePositions = [
    -1, -1, -1,  1, -1, -1,  1,  1, -1, -1,  1, -1,
    -1, -1,  1,  1, -1,  1,  1,  1,  1, -1,  1,  1,
  ];
  const cubeIndices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ];
  const roofPositions = [
    -1.18, 1.04, -1.18, 1.18, 1.04, -1.18, 1.18, 1.04, 1.18, -1.18, 1.04, 1.18,
     0, 2.15, 0,
  ];
  const roofIndices = [
    0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0,
  ];

  const cubePosOffset = appendFloat32(bufferBytesArray, cubePositions);
  const cubeIndexOffset = appendUint16(bufferBytesArray, cubeIndices);
  const roofPosOffset = appendFloat32(bufferBytesArray, roofPositions);
  const roofIndexOffset = appendUint16(bufferBytesArray, roofIndices);
  const bufferBytes = new Uint8Array(bufferBytesArray);

  const gltf = {
    asset: { version: '2.0', generator: 'GameEngine glTF viewer sample' },
    buffers: [{ uri: dataUri('application/octet-stream', bufferBytes), byteLength: bufferBytes.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: cubePosOffset, byteLength: cubePositions.length * 4 },
      { buffer: 0, byteOffset: cubeIndexOffset, byteLength: cubeIndices.length * 2 },
      { buffer: 0, byteOffset: roofPosOffset, byteLength: roofPositions.length * 4 },
      { buffer: 0, byteOffset: roofIndexOffset, byteLength: roofIndices.length * 2 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: cubePositions.length / 3, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: cubeIndices.length, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: roofPositions.length / 3, type: 'VEC3', min: [-1.18, 1.04, -1.18], max: [1.18, 2.15, 1.18] },
      { bufferView: 3, componentType: 5123, count: roofIndices.length, type: 'SCALAR' },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.25, 0.55, 1.0, 1] } },
      { pbrMetallicRoughness: { baseColorFactor: [1.0, 0.45, 0.18, 1] } },
    ],
    meshes: [{
      primitives: [
        { attributes: { POSITION: 0 }, indices: 1, material: 0 },
        { attributes: { POSITION: 2 }, indices: 3, material: 1 },
      ],
    }],
    nodes: [{ name: 'Sample House', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };

  const bytes = new TextEncoder().encode(JSON.stringify(gltf));
  return dataUri('model/gltf+json', bytes);
}

function setCanvasSize(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}

function identityMatrix(): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function multiplyMatrix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        requiredNumberAt(a, row, 'left model matrix') * requiredNumberAt(b, col * 4, 'right model matrix')
        + requiredNumberAt(a, 4 + row, 'left model matrix') * requiredNumberAt(b, col * 4 + 1, 'right model matrix')
        + requiredNumberAt(a, 8 + row, 'left model matrix') * requiredNumberAt(b, col * 4 + 2, 'right model matrix')
        + requiredNumberAt(a, 12 + row, 'left model matrix') * requiredNumberAt(b, col * 4 + 3, 'right model matrix');
    }
  }
  return out;
}

function transformPoint(matrix: Float32Array, x: number, y: number, z: number): Vec3Tuple {
  return [
    requiredNumberAt(matrix, 0, 'model matrix') * x + requiredNumberAt(matrix, 4, 'model matrix') * y + requiredNumberAt(matrix, 8, 'model matrix') * z + requiredNumberAt(matrix, 12, 'model matrix'),
    requiredNumberAt(matrix, 1, 'model matrix') * x + requiredNumberAt(matrix, 5, 'model matrix') * y + requiredNumberAt(matrix, 9, 'model matrix') * z + requiredNumberAt(matrix, 13, 'model matrix'),
    requiredNumberAt(matrix, 2, 'model matrix') * x + requiredNumberAt(matrix, 6, 'model matrix') * y + requiredNumberAt(matrix, 10, 'model matrix') * z + requiredNumberAt(matrix, 14, 'model matrix'),
  ];
}

function expandBounds(bounds: Bounds3D, point: Vec3Tuple): void {
  bounds.min[0] = Math.min(bounds.min[0], point[0]);
  bounds.min[1] = Math.min(bounds.min[1], point[1]);
  bounds.min[2] = Math.min(bounds.min[2], point[2]);
  bounds.max[0] = Math.max(bounds.max[0], point[0]);
  bounds.max[1] = Math.max(bounds.max[1], point[1]);
  bounds.max[2] = Math.max(bounds.max[2], point[2]);
}

function computeEntityBounds(entity: Entity, parentMatrix = identityMatrix(), bounds?: Bounds3D): Bounds3D | null {
  const transform = entity.getComponent(Transform3D);
  const worldMatrix = transform ? multiplyMatrix(parentMatrix, transform.localMatrix) : parentMatrix;
  const result = bounds ?? {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };

  const mesh = entity.getComponent(Mesh3D);
  const positions = mesh?.geometry.positions;
  if (positions) {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      expandBounds(result, transformPoint(worldMatrix, requiredNumberAt(positions, i, 'model positions'), requiredNumberAt(positions, i + 1, 'model positions'), requiredNumberAt(positions, i + 2, 'model positions')));
    }
  }

  for (const child of entity.children) computeEntityBounds(child, worldMatrix, result);

  return Number.isFinite(result.min[0]) ? result : null;
}

function collectRuntimeStats(entity: Entity, parentMatrix = identityMatrix(), stats?: RuntimeModelStats): RuntimeModelStats {
  const result = stats ?? {
    bounds: null,
    vertexCount: 0,
    triangleCount: 0,
    meshCount: 0,
    entityCount: 0,
    textureCount: 0,
  };
  const textures = (result as RuntimeModelStats & { _textures?: Set<unknown> })._textures ?? new Set<unknown>();
  (result as RuntimeModelStats & { _textures?: Set<unknown> })._textures = textures;
  result.entityCount += 1;

  const transform = entity.getComponent(Transform3D);
  const worldMatrix = transform ? multiplyMatrix(parentMatrix, transform.localMatrix) : parentMatrix;
  const mesh = entity.getComponent(Mesh3D);
  if (mesh) {
    result.meshCount += 1;
    result.vertexCount += mesh.geometry.vertexCount;
    result.triangleCount += mesh.geometry.indices
      ? Math.floor(mesh.geometry.indices.length / 3)
      : Math.floor(mesh.geometry.positions.length / 9);
    const texture = (mesh.material as { texture?: unknown }).texture;
    if (texture) textures.add(texture);

    const positions = mesh.geometry.positions;
    const bounds = result.bounds ?? {
      min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] as Vec3Tuple,
      max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY] as Vec3Tuple,
    };
    for (let i = 0; i + 2 < positions.length; i += 3) {
      expandBounds(bounds, transformPoint(worldMatrix, requiredNumberAt(positions, i, 'model positions'), requiredNumberAt(positions, i + 1, 'model positions'), requiredNumberAt(positions, i + 2, 'model positions')));
    }
    result.bounds = bounds;
  }

  for (const child of entity.children) collectRuntimeStats(child, worldMatrix, result);
  result.textureCount = textures.size;
  return result;
}

function collectSceneTreeNodeStats(entity: Entity, stats: SceneTreeNodeStats = { meshCount: 0, entityCount: 0 }): SceneTreeNodeStats {
  stats.entityCount += 1;
  if (entity.getComponent(Mesh3D)) stats.meshCount += 1;
  for (const child of entity.children) collectSceneTreeNodeStats(child, stats);
  return stats;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function applyModelFit(info: FitInfo, modelTransform: CartesianTransform3D): number {
  const scale = info.autoScale * info.userScale;
  modelTransform.setScale(scale, scale, scale);
  modelTransform.setPosition(-info.center[0] * scale, -info.center[1] * scale, -info.center[2] * scale);
  return scale;
}

function updateCameraForFit(info: FitInfo, camera: Camera3D, cameraTransform: SphericalTransform3D): void {
  const scale = info.autoScale;
  const fittedRadius = Math.hypot(info.size[0] * scale, info.size[1] * scale, info.size[2] * scale) * 0.5;
  const distance = Math.max(3, fittedRadius / Math.sin(camera.fov * 0.5) * 1.25);
  cameraTransform.set(distance, Math.PI * 0.24, Math.PI * 0.34);
  cameraTransform.setTarget(0, 0, 0);
  camera.near = Math.max(0.01, distance / 1000);
  camera.far = Math.max(100, distance * 100);
  camera.setDirty();
}

function fitModelToView(
  root: Entity,
  modelTransform: CartesianTransform3D,
  camera: Camera3D,
  cameraTransform: SphericalTransform3D,
  userScale = 1,
): FitInfo | null {
  const bounds = computeEntityBounds(root);
  if (!bounds) return null;

  const center: Vec3Tuple = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const size: Vec3Tuple = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const sourceSize = Math.max(size[0], size[1], size[2], 0.0001);
  const info: FitInfo = {
    sourceSize,
    autoScale: 4.2 / sourceSize,
    userScale,
    center,
    size,
  };
  applyModelFit(info, modelTransform);
  updateCameraForFit(info, camera, cameraTransform);

  return info;
}

function normalizeLocalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function filePath(file: File): string {
  return normalizeLocalPath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index + 1) : '';
}

function resolveRelativePath(baseDir: string, uri: string): string {
  const parts = `${baseDir}${decodeURIComponent(uri)}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function isDataOrAbsoluteUri(uri: string): boolean {
  return /^(data:|blob:|https?:\/\/)/i.test(uri);
}

async function createLocalModelUrl(files: FileList | File[]): Promise<LocalModelUrl> {
  const list = Array.from(files);
  if (list.length === 0) throw new Error('No files selected.');
  const filesByPath = new Map<string, File>();
  for (const file of list) filesByPath.set(filePath(file), file);

  const entry = list.find(file => /\.glb$/i.test(file.name))
    ?? list.find(file => /\.gltf$/i.test(file.name));
  if (!entry) throw new Error('Select a .gltf/.glb file or a folder that contains one.');

  const dataUrls = new Map<File, string>();
  const makeUrl = async (file: File): Promise<string> => {
    const cached = dataUrls.get(file);
    if (cached) return cached;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const url = dataUri(file.type || 'application/octet-stream', bytes);
    dataUrls.set(file, url);
    return url;
  };

  if (/\.glb$/i.test(entry.name)) {
    const url = await makeUrl(entry);
    return { url, revoke: () => undefined };
  }

  const entryPath = filePath(entry);
  const baseDir = dirname(entryPath);
  const gltf = JSON.parse(await entry.text());
  const rewriteUri = async (uri: unknown): Promise<unknown> => {
    if (typeof uri !== 'string' || isDataOrAbsoluteUri(uri)) return uri;
    const match = filesByPath.get(resolveRelativePath(baseDir, uri))
      ?? filesByPath.get(normalizeLocalPath(uri))
      ?? list.find(file => file.name === uri.split('/').pop());
    return match ? await makeUrl(match) : uri;
  };

  for (const buffer of gltf.buffers ?? []) buffer.uri = await rewriteUri(buffer.uri);
  for (const image of gltf.images ?? []) image.uri = await rewriteUri(image.uri);

  const url = dataUri('model/gltf+json', new TextEncoder().encode(JSON.stringify(gltf)));
  return { url, revoke: () => undefined };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const input = document.getElementById('src-input') as HTMLInputElement;
  const loadButton = document.getElementById('load-button') as HTMLButtonElement;
  const fileButton = document.getElementById('file-button') as HTMLButtonElement;
  const folderButton = document.getElementById('folder-button') as HTMLButtonElement;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const folderInput = document.getElementById('folder-input') as HTMLInputElement;
  const sampleButton = document.getElementById('sample-button') as HTMLButtonElement;
  const status = document.getElementById('status') as HTMLElement;
  const statsPanel = document.getElementById('stats-panel') as HTMLElement;
  const sceneTree = document.getElementById('scene-tree') as HTMLElement;
  const sampleUrl = createSampleGltfUrl();
  let localModel: LocalModelUrl | null = null;

  setCanvasSize(canvas);
  window.addEventListener('resize', () => {
    setCanvasSize(canvas);
    engine.resizeToDisplaySize();
  });

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.055, g: 0.07, b: 0.1, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const cameraTransform = new SphericalTransform3D({
    radius: 7,
    theta: Math.PI * 0.24,
    phi: Math.PI * 0.34,
    target: [0, 0.6, 0],
  });
  const camera3D = new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.05, far: 200 });
  const camera = new Entity('Camera');
  camera.addComponent(camera3D);
  camera.addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'glTF Viewer',
    camera,
    render3D: { loadOp: 'clear', priority: 1 },
    render2D: false,
    gui: false,
    pipelineLabel: 'GltfViewer.render',
  });
  const { world } = scene;

  new OrbitControl(canvas, cameraTransform, { minRadius: 1.5, maxRadius: 80, panSpeed: 1.1 });

  const ambient = new Entity('Ambient Light');
  ambient.addComponent(new AmbientLight({ color: [1, 1, 1], intensity: 0.35 }));
  world.addEntity(ambient);

  const sun = new Entity('Directional Light');
  sun.addComponent(new DirectionalLight({ color: [1, 0.96, 0.88], intensity: 1.8, direction: [-0.4, -1, -0.3] }));
  world.addEntity(sun);

  const modelComponent = new GltfModelComponent({ src: sampleUrl, autoLoad: true, clearPrevious: true });
  const modelTransform = new CartesianTransform3D({ position: [0, 0, 0], scale: [1, 1, 1] });
  const model = new Entity('glTF Model');
  model.addComponent(modelTransform);
  model.addComponent(modelComponent);
  world.addEntity(model);

  const gltfAssetWorker = createInlineGltfAssetWorkerClient(
    new URL('../../extensions/dist/gltf-worker-runtime.js', import.meta.url).href,
  );
  window.addEventListener('beforeunload', () => gltfAssetWorker.dispose(), { once: true });
  scene.addSystem(new GltfModelSystem({
    priority: 0,
    assetWorker: gltfAssetWorker,
    dracoDecoderConfig: {
      scriptUrl: new URL('./draco_decoder_gltf_nodejs.js', window.location.href).href,
    },
  }), false);

  let fittedSourceKey = '';
  let fitInfo: FitInfo | null = null;
  let runtimeStats: RuntimeModelStats | null = null;
  let animationTime = 0;
  let lastAnimationName = 'None';
  let selectedTreeEntity: Entity | null = null;
  let selectionText = '';
  const helperEntities = new Set<Entity>();
  const viewerParams = {
    userScale: 1,
    gpuMorph: true,
    animation: 'None',
    playing: false,
  };
  const gui = new dat.GUI({ width: 300 });
  gui.domElement.style.marginTop = '12px';
  const transformFolder = gui.addFolder('Transform');
  const userScaleController = transformFolder
    .add(viewerParams, 'userScale', 0.01, 100, 0.01)
    .name('User Scale')
    .onChange((value: number) => {
      viewerParams.userScale = value;
      if (!fitInfo) return;
      fitInfo.userScale = value;
      applyModelFit(fitInfo, modelTransform);
      updateStatsPanel();
    });
  transformFolder.open();

  function selectedClip() {
    return modelComponent.runtimeAnimationClips.find(item => item.name === viewerParams.animation) ?? null;
  }

  function setMorphUseGpu(entity: Entity, useGpu: boolean): void {
    const mesh = entity.getComponent(Mesh3D);
    if (mesh?.geometry.hasMorphTargets) mesh.geometry.setMorphUseGpu(useGpu);
    for (const child of entity.children) setMorphUseGpu(child, useGpu);
  }

  function clearSelectionHelper(): void {
    for (const entity of helperEntities) entity.removeComponent(MeshHelper);
    helperEntities.clear();
  }

  function addWireframeHelpers(entity: Entity): number {
    let count = 0;
    if (entity.getComponent(Mesh3D)) {
      entity.addComponent(new MeshHelper({ mode: 'wireframe', color: [0.05, 0.95, 1, 1] }));
      helperEntities.add(entity);
      count += 1;
    }
    for (const child of entity.children) count += addWireframeHelpers(child);
    return count;
  }

  function entityTreeLabel(entity: Entity): string {
    return entity.name || `Entity ${entity.id}`;
  }

  function renderSceneTree(root: Entity | null): void {
    sceneTree.innerHTML = '<h2>Scene Hierarchy</h2>';
    if (!root) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = 'No model loaded.';
      sceneTree.appendChild(empty);
      return;
    }

    const content = document.createElement('div');
    const appendEntity = (parent: HTMLElement, entity: Entity, depth: number): void => {
      const stats = collectSceneTreeNodeStats(entity);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `tree-row${entity === selectedTreeEntity ? ' selected' : ''}`;
      row.setAttribute('aria-pressed', entity === selectedTreeEntity ? 'true' : 'false');
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const directMesh = entity.getComponent(Mesh3D);
      const badges: string[] = [];
      if (directMesh) badges.push('<span class="tree-badge">mesh</span>');
      if (stats.meshCount > (directMesh ? 1 : 0)) badges.push(`<span class="tree-badge">${stats.meshCount} meshes</span>`);
      if (entity.children.length > 0) badges.push(`<span class="tree-badge">${entity.children.length} children</span>`);
      row.innerHTML = `
        <span class="tree-name" title="${escapeHtml(entityTreeLabel(entity))}">${escapeHtml(entityTreeLabel(entity))}</span>
        <span class="tree-badges">${badges.join('')}</span>
      `;
      row.addEventListener('click', () => {
        if (selectedTreeEntity === entity) {
          clearSelectionHelper();
          selectedTreeEntity = null;
          selectionText = '';
          renderSceneTree(root);
          return;
        }
        clearSelectionHelper();
        selectedTreeEntity = entity;
        const helperCount = addWireframeHelpers(entity);
        selectionText = ` | selected: ${entityTreeLabel(entity)} | wire meshes: ${helperCount}`;
        renderSceneTree(root);
      });
      parent.appendChild(row);
      for (const child of entity.children) appendEntity(parent, child, depth + 1);
    };

    appendEntity(content, root, 0);
    sceneTree.appendChild(content);
  }

  const animationFolder = gui.addFolder('Animation');
  let animationController: dat.GUIController | null = null;
  let playingController: dat.GUIController | null = null;
  function refreshAnimationGui(): void {
    if (animationController) animationFolder.remove(animationController);
    if (playingController) animationFolder.remove(playingController);
    const names = modelComponent.runtimeAnimations.length
      ? modelComponent.runtimeAnimations.map(animation => animation.name)
      : ['None'];
    if (!names.includes(viewerParams.animation)) viewerParams.animation = names[0] ?? 'None';
    animationController = animationFolder.add(viewerParams, 'animation', names).name('Clip').onChange(() => {
      animationTime = 0;
      lastAnimationName = viewerParams.animation;
    });
    playingController = animationFolder.add(viewerParams, 'playing').name('Play');
  }
  refreshAnimationGui();
  const morphFolder = gui.addFolder('Morph');
  morphFolder.add(viewerParams, 'gpuMorph').name('GPU Morph').onChange((value: boolean) => {
    if (!modelComponent.runtimeRoot) return;
    setMorphUseGpu(modelComponent.runtimeRoot, value);
    const clip = selectedClip();
    if (clip) applyGltfAnimationClip(clip, animationTime);
  });
  morphFolder.open();

  function updateStatsPanel(): void {
    const stats = runtimeStats;
    const asset = modelComponent.runtimeAssetStats;
    const bounds = stats?.bounds;
    const size = bounds
      ? [
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2],
        ]
      : [0, 0, 0];
    const animations = modelComponent.runtimeAnimations.length
      ? modelComponent.runtimeAnimations
          .map(animation => `${animation.name} (${animation.duration.toFixed(2)}s, ${animation.channelCount} channels)`)
          .join('<br />')
      : 'None';
    statsPanel.innerHTML = `
      <details open>
        <summary>Model Stats</summary>
        <dl>
          <dt>Source Size</dt><dd>${fitInfo ? fitInfo.sourceSize.toPrecision(4) : '-'}</dd>
          <dt>Bounds Size</dt><dd>${size.map(value => value.toPrecision(4)).join(' x ')}</dd>
          <dt>Auto Scale</dt><dd>${fitInfo ? fitInfo.autoScale.toPrecision(4) : '-'}</dd>
          <dt>User Scale</dt><dd>${viewerParams.userScale.toPrecision(4)}</dd>
          <dt>Final Scale</dt><dd>${fitInfo ? (fitInfo.autoScale * fitInfo.userScale).toPrecision(4) : '-'}</dd>
          <dt>Entities</dt><dd>${stats?.entityCount ?? 0}</dd>
          <dt>Meshes</dt><dd>${stats?.meshCount ?? 0} / asset ${asset?.meshCount ?? 0}</dd>
          <dt>Vertices</dt><dd>${stats?.vertexCount ?? 0}</dd>
          <dt>Triangles</dt><dd>${stats?.triangleCount ?? 0}</dd>
          <dt>Materials</dt><dd>${asset?.materialCount ?? 0}</dd>
          <dt>Textures</dt><dd>${stats?.textureCount ?? 0} / asset ${asset?.textureCount ?? 0}</dd>
          <dt>Images</dt><dd>${asset?.imageCount ?? 0}</dd>
          <dt>Animations</dt><dd>${animations}</dd>
        </dl>
      </details>
    `;
  }

  function load(src: string): void {
    if (!src.trim()) return;
    clearSelectionHelper();
    selectedTreeEntity = null;
    selectionText = '';
    if (modelComponent.runtimeRoot) {
      model.removeChild(modelComponent.runtimeRoot);
      modelComponent.runtimeRoot = null;
    }
    modelComponent.src = src.trim();
    modelComponent.runtimeSourceKey = '';
    modelComponent.loadingSourceKey = '';
    modelComponent.status = 'idle';
    modelComponent.error = null;
    modelComponent.runtimeAnimations = [];
    modelComponent.runtimeAnimationClips = [];
    modelComponent.runtimeAssetStats = null;
    fittedSourceKey = '';
    fitInfo = null;
    runtimeStats = null;
    viewerParams.userScale = 1;
    viewerParams.gpuMorph = true;
    viewerParams.animation = 'None';
    viewerParams.playing = false;
    animationTime = 0;
    lastAnimationName = 'None';
    userScaleController.updateDisplay();
    refreshAnimationGui();
    updateStatsPanel();
    renderSceneTree(null);
    modelTransform.setPosition(0, 0, 0);
    modelTransform.setScale(1, 1, 1);
  }

  async function loadLocal(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    try {
      const next = await createLocalModelUrl(files);
      localModel?.revoke();
      localModel = next;
      input.value = '';
      load(next.url);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      console.error(error);
    }
  }

  input.value = '';
  loadButton.addEventListener('click', () => {
    localModel?.revoke();
    localModel = null;
    load(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      localModel?.revoke();
      localModel = null;
      load(input.value);
    }
  });
  fileButton.addEventListener('click', () => fileInput.click());
  folderButton.addEventListener('click', () => folderInput.click());
  fileInput.addEventListener('change', () => {
    void loadLocal(fileInput.files);
    fileInput.value = '';
  });
  folderInput.addEventListener('change', () => {
    void loadLocal(folderInput.files);
    folderInput.value = '';
  });
  sampleButton.addEventListener('click', () => {
    localModel?.revoke();
    localModel = null;
    input.value = '';
    load(sampleUrl);
  });

  engine.on('update', ({ detail: { time, delta } }) => {
    if (viewerParams.playing && viewerParams.animation !== 'None') {
      const clip = selectedClip();
      if (clip) {
        if (lastAnimationName !== viewerParams.animation) {
          animationTime = 0;
          lastAnimationName = viewerParams.animation;
        }
        animationTime += delta / 1000;
        applyGltfAnimationClip(clip, animationTime);
      }
    }
    if (
      modelComponent.status === 'loaded'
      && modelComponent.runtimeRoot
      && modelComponent.runtimeSourceKey
      && fittedSourceKey !== modelComponent.runtimeSourceKey
    ) {
      fitInfo = fitModelToView(modelComponent.runtimeRoot, modelTransform, camera3D, cameraTransform, viewerParams.userScale);
      setMorphUseGpu(modelComponent.runtimeRoot, viewerParams.gpuMorph);
      runtimeStats = collectRuntimeStats(modelComponent.runtimeRoot);
      fittedSourceKey = modelComponent.runtimeSourceKey;
      refreshAnimationGui();
      updateStatsPanel();
      renderSceneTree(modelComponent.runtimeRoot);
    }
    const fitText = fitInfo
      ? ` | source size: ${fitInfo.sourceSize.toPrecision(4)} | auto scale: ${fitInfo.autoScale.toPrecision(4)} | user scale: ${fitInfo.userScale.toPrecision(4)}`
      : '';
    status.textContent = modelComponent.status === 'error'
      ? `error: ${modelComponent.error}`
      : `status: ${modelComponent.status} | children: ${model.children.length}${fitText}${selectionText}`;
  });

  engine.switchScene(scene);
  engine.run();
}

main().catch((error) => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = error instanceof Error ? error.message : String(error);
});
