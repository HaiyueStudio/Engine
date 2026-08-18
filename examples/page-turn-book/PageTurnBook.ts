import {
  CartesianTransform3D,
  Entity,
  Geometry3D,
  Mesh3D,
  PbrMaterial,
  System,
  createBox3D,
  type Scene,
  type World,
} from '@haiyue/engine';
import { Interactive, type InteractiveEvent } from '@haiyue/engine/components';

const PAGE_WIDTH = 4.65;
const PAGE_HEIGHT = 6.35;
const PAGE_WIDTH_SEGMENTS = 48;
const PAGE_HEIGHT_SEGMENTS = 12;
const PAGE_GAP = 0.007;
const PAPER_HALF_THICKNESS = 0.006;
const COVER_THICKNESS = 0.09;
const COVER_OVERHANG = 0.16;
const MIN_PAPER_STACK_THICKNESS = 0.12;
const MAX_PAPER_STACK_THICKNESS = 0.92;
const PAPER_STACK_THICKNESS_PER_LEAF = 0.007;
const SPINE_WIDTH = 0.07;
const PAPER_BLOCK_HIDE_THRESHOLD = PAPER_STACK_THICKNESS_PER_LEAF * 0.5;
const TURN_DURATION_RESPONSE = 13;

interface PageSurface {
  geometry: Geometry3D;
  entity: Entity;
  material: PbrMaterial;
  side: 1 | -1;
}

interface BookStructure {
  scene: Scene;
  leftPaperBlock: Entity;
  leftPaperTransform: CartesianTransform3D;
  rightPaperBlock: Entity;
  rightPaperTransform: CartesianTransform3D;
  spineTransform: CartesianTransform3D;
  paperStackThickness: number;
}

export interface PageTextureProvider {
  readonly pageCount: number;
  readonly placeholder: HTMLCanvasElement;
  readonly residentPageCount: number;
  retainPages(pageIndices: ReadonlySet<number>): void;
  getPageTexture(pageIndex: number): Promise<HTMLCanvasElement>;
  destroy(): Promise<void> | void;
}

interface DragState {
  pointerId: number;
  leafIndex: number;
  direction: 'forward' | 'backward';
  startX: number;
  lastX: number;
}

interface TurnAnimation {
  leafIndex: number;
  target: 0 | 1;
}

export interface PageTurnBookOptions {
  onStateChange?(state: PageTurnBookState): void;
  onPageHoverChange?(hovered: boolean): void;
  onPageInteractionChange?(active: boolean): void;
  onPageLoadError?(error: unknown): void;
}

export interface PageTurnBookState {
  currentLeaf: number;
  leafCount: number;
  pageCount: number;
  visiblePages: readonly number[];
  residentPageCount: number;
  progress: number;
  mode: 'idle' | 'loading' | 'dragging' | 'animating';
  canGoBack: boolean;
  canGoForward: boolean;
}

class BookLeaf {
  readonly front: PageSurface;
  readonly back: PageSurface;
  readonly columnX: Float32Array;
  readonly columnY: Float32Array;
  readonly columnAngle: Float32Array;
  progress = Number.NaN;

  private readonly rigid: boolean;
  private readonly halfThickness: number;
  private rightY = 0;
  private leftY = 0;
  private readonly coverTransform: CartesianTransform3D | null;
  private readonly coverEntity: Entity | null;

  constructor(
    scene: Scene,
    readonly index: number,
    placeholder: HTMLCanvasElement,
    rigid = false,
  ) {
    this.rigid = rigid;
    this.halfThickness = rigid ? COVER_THICKNESS / 2 : PAPER_HALF_THICKNESS;
    const widthSegments = rigid ? 1 : PAGE_WIDTH_SEGMENTS;
    const heightSegments = rigid ? 1 : PAGE_HEIGHT_SEGMENTS;
    this.columnX = new Float32Array(widthSegments + 1);
    this.columnY = new Float32Array(widthSegments + 1);
    this.columnAngle = new Float32Array(widthSegments + 1);
    this.front = createPageSurface(
      scene,
      `${rigid ? 'Front cover' : `Leaf ${index}`} front`,
      placeholder,
      1,
      widthSegments,
      heightSegments,
    );
    this.back = createPageSurface(
      scene,
      `${rigid ? 'Front cover' : `Leaf ${index}`} back`,
      placeholder,
      -1,
      widthSegments,
      heightSegments,
    );

    if (rigid) {
      this.coverTransform = new CartesianTransform3D();
      const cover = new Entity('Rigid front cover thickness');
      cover.addComponent(this.coverTransform);
      cover.addComponent(new Mesh3D(
        createBox3D({
          width: PAGE_WIDTH + COVER_OVERHANG * 2,
          height: COVER_THICKNESS,
          depth: PAGE_HEIGHT + COVER_OVERHANG * 2,
        }),
        createCoverMaterial(),
      ));
      scene.add(cover);
      this.coverEntity = cover;
    } else {
      this.coverTransform = null;
      this.coverEntity = null;
    }
  }

  setFrontTexture(texture: HTMLCanvasElement): void {
    this.front.material.baseColorTexture = texture;
  }

  setBackTexture(texture: HTMLCanvasElement): void {
    this.back.material.baseColorTexture = texture;
  }

  setEnabled(enabled: boolean): void {
    this.front.entity.disabled = !enabled;
    this.back.entity.disabled = !enabled;
    // The page texture is lazy, but the physical cover must remain in the scene.
    if (this.coverEntity) this.coverEntity.disabled = false;
  }

  setStackLevels(leftPaperTop: number, rightPaperTop: number): void {
    const nextLeftY = this.rigid
      ? Math.max(COVER_THICKNESS / 2, leftPaperTop - COVER_THICKNESS / 2)
      : leftPaperTop;
    const nextRightY = this.rigid
      ? rightPaperTop + COVER_THICKNESS / 2
      : rightPaperTop;
    if (this.leftY === nextLeftY && this.rightY === nextRightY) return;
    this.leftY = nextLeftY;
    this.rightY = nextRightY;
    const progress = this.progress;
    this.progress = Number.NaN;
    if (Number.isFinite(progress)) this.setProgress(progress);
  }

  bindInteraction(
    handler: (leafIndex: number, event: InteractiveEvent) => void,
    onHoverChange?: (hovered: boolean) => void,
  ): void {
    const entities = [this.front.entity, this.back.entity];
    if (this.coverEntity) entities.push(this.coverEntity);
    for (const entity of entities) {
      entity.addComponent(new Interactive({
        onPointerEnter: () => {
          document.body.style.cursor = 'grab';
          onHoverChange?.(true);
        },
        onPointerLeave: () => {
          document.body.style.cursor = '';
          onHoverChange?.(false);
        },
        onPointerDown: event => handler(this.index, event),
      }));
    }
  }

  setProgress(value: number): void {
    const progress = clamp01(value);
    if (this.progress === progress) return;
    this.progress = progress;
    const widthSegments = this.columnX.length - 1;
    const du = PAGE_WIDTH / widthSegments;
    const turnAngle = Math.PI * progress;
    const curl = this.rigid ? 0 : Math.sin(Math.PI * progress) * 1.08;
    this.columnX[0] = 0;
    this.columnY[0] = 0;
    this.columnAngle[0] = turnAngle + curl * 0.5;
    for (let column = 1; column <= widthSegments; column++) {
      const midpoint = (column - 0.5) / widthSegments;
      const angle = turnAngle + curl * (0.5 - midpoint);
      this.columnX[column] = this.columnX[column - 1]! + Math.cos(angle) * du;
      this.columnY[column] = this.columnY[column - 1]! + Math.sin(angle) * du;
      this.columnAngle[column] = turnAngle + curl * (0.5 - column / widthSegments);
    }

    const stackMix = smoothstep(progress);
    const baseY = this.rightY + (this.leftY - this.rightY) * stackMix;
    updateSurfaceGeometry(
      this.front,
      this.columnX,
      this.columnY,
      this.columnAngle,
      progress,
      baseY,
      this.halfThickness + 0.0015,
    );
    updateSurfaceGeometry(
      this.back,
      this.columnX,
      this.columnY,
      this.columnAngle,
      progress,
      baseY,
      this.halfThickness + 0.0015,
    );

    if (this.coverTransform) {
      const centerAngle = turnAngle;
      this.coverTransform
        .setPosition(
          Math.cos(centerAngle) * PAGE_WIDTH / 2,
          baseY + Math.sin(centerAngle) * PAGE_WIDTH / 2,
          0,
        )
        .setRotation(0, 0, centerAngle);
    }
  }
}

export class PageTurnBook {
  readonly leaves: BookLeaf[] = [];
  readonly ready: Promise<void>;
  currentLeaf = 0;

  private drag: DragState | null = null;
  private animation: TurnAnimation | null = null;
  private disposed = false;
  private loading = true;
  private pageWindowGeneration = 0;
  private readonly structure: BookStructure;

  constructor(
    scene: Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly pageTextures: PageTextureProvider,
    private readonly options: PageTurnBookOptions = {},
  ) {
    if (!Number.isInteger(pageTextures.pageCount) || pageTextures.pageCount < 1) {
      throw new RangeError('PageTurnBook requires at least one PDF page.');
    }
    const totalLeaves = Math.ceil(pageTextures.pageCount / 2);
    this.structure = addStaticBookParts(scene, totalLeaves);
    for (let index = 0; index < totalLeaves; index++) {
      const leaf = new BookLeaf(
        scene,
        index,
        pageTextures.placeholder,
        index === 0,
      );
      leaf.bindInteraction(
        (leafIndex, event) => this.beginDrag(leafIndex, event),
        hovered => this.options.onPageHoverChange?.(hovered),
      );
      leaf.setProgress(index < this.currentLeaf ? 1 : 0);
      this.leaves.push(leaf);
    }
    this.updateBookThickness();
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.emitState();
    this.ready = this.syncPageWindow();
  }

  get leafCount(): number {
    return this.leaves.length;
  }

  flipForward(): void {
    if (this.loading || this.animation || this.drag || this.currentLeaf >= this.leaves.length) return;
    this.animation = { leafIndex: this.currentLeaf, target: 1 };
    this.emitState();
  }

  flipBackward(): void {
    if (this.loading || this.animation || this.drag || this.currentLeaf <= 0) return;
    this.animation = { leafIndex: this.currentLeaf - 1, target: 0 };
    this.emitState();
  }

  update(delta: number): void {
    const animation = this.animation;
    if (!animation) return;
    const leaf = this.leaves[animation.leafIndex];
    if (!leaf) return;
    const response = 1 - Math.exp(-Math.max(0, delta) / 1000 * TURN_DURATION_RESPONSE);
    const next = leaf.progress + (animation.target - leaf.progress) * response;
    if (Math.abs(animation.target - next) > 0.001) {
      leaf.setProgress(next);
      this.updateBookThickness();
      this.emitState();
      return;
    }
    leaf.setProgress(animation.target);
    this.currentLeaf = animation.target === 1
      ? animation.leafIndex + 1
      : animation.leafIndex;
    this.animation = null;
    this.updateBookThickness();
    void this.syncPageWindow().catch(error => this.options.onPageLoadError?.(error));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pageWindowGeneration++;
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    document.body.style.cursor = '';
    this.options.onPageHoverChange?.(false);
    this.options.onPageInteractionChange?.(false);
    for (const leaf of this.leaves) {
      leaf.setFrontTexture(this.pageTextures.placeholder);
      leaf.setBackTexture(this.pageTextures.placeholder);
    }
    void this.pageTextures.destroy();
  }

  private beginDrag(leafIndex: number, event: InteractiveEvent): void {
    if (this.loading || this.animation || this.drag) return;
    const nativeEvent = event.nativeEvent;
    if (!(nativeEvent instanceof PointerEvent) || nativeEvent.button !== 0) return;
    let direction: DragState['direction'];
    if (leafIndex === this.currentLeaf) direction = 'forward';
    else if (leafIndex === this.currentLeaf - 1) direction = 'backward';
    else return;
    this.drag = {
      pointerId: nativeEvent.pointerId,
      leafIndex,
      direction,
      startX: nativeEvent.clientX,
      lastX: nativeEvent.clientX,
    };
    this.canvas.setPointerCapture(nativeEvent.pointerId);
    document.body.style.cursor = 'grabbing';
    this.options.onPageInteractionChange?.(true);
    nativeEvent.preventDefault();
    this.emitState();
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.lastX = event.clientX;
    const span = Math.max(180, this.canvas.getBoundingClientRect().width * 0.42);
    const delta = event.clientX - drag.startX;
    const progress = drag.direction === 'forward'
      ? -delta / span
      : 1 - delta / span;
    this.leaves[drag.leafIndex]?.setProgress(clamp01(progress));
    this.updateBookThickness();
    event.preventDefault();
    this.emitState();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const leaf = this.leaves[drag.leafIndex];
    if (!leaf) return;
    const travel = Math.abs(drag.lastX - drag.startX);
    const target: 0 | 1 = travel < 7
      ? drag.direction === 'forward' ? 1 : 0
      : leaf.progress >= 0.5 ? 1 : 0;
    this.drag = null;
    this.options.onPageInteractionChange?.(false);
    this.animation = { leafIndex: drag.leafIndex, target };
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    document.body.style.cursor = '';
    this.emitState();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const leaf = this.leaves[drag.leafIndex];
    this.drag = null;
    this.options.onPageInteractionChange?.(false);
    if (leaf) {
      this.animation = {
        leafIndex: drag.leafIndex,
        target: leaf.progress >= 0.5 ? 1 : 0,
      };
    }
    document.body.style.cursor = '';
    this.emitState();
  };

  private updateBookThickness(): void {
    const movingLeafIndex = this.drag?.leafIndex ?? this.animation?.leafIndex;
    const turnedLeafPosition = movingLeafIndex === undefined
      ? this.currentLeaf
      : movingLeafIndex + (this.leaves[movingLeafIndex]?.progress ?? 0);
    const paperLeafCount = Math.max(1, this.leaves.length - 1);
    const paperProgress = clamp01((turnedLeafPosition - 1) / paperLeafCount);
    const remainingRatio = 1 - paperProgress;
    const rightPaperHeight = this.structure.paperStackThickness * remainingRatio;
    const turnedPaperHeight = this.structure.paperStackThickness * paperProgress;
    // Keep the first opened spread level instead of dropping it to the table.
    // This is only the display level; it must not create unturned paper on the left.
    const leftPageHeight = this.structure.paperStackThickness
      * Math.max(remainingRatio, paperProgress);
    setPaperBlockHeight(
      this.structure.scene,
      this.structure.rightPaperBlock,
      this.structure.rightPaperTransform,
      PAGE_WIDTH / 2,
      rightPaperHeight,
    );
    setPaperBlockHeight(
      this.structure.scene,
      this.structure.leftPaperBlock,
      this.structure.leftPaperTransform,
      -PAGE_WIDTH / 2,
      turnedPaperHeight,
    );
    const spinePaperHeight = Math.max(leftPageHeight, rightPaperHeight);
    this.structure.spineTransform
      .setPosition(0, spinePaperHeight / 2, 0)
      .setScale(1, spinePaperHeight, 1);
    const firstActiveLeaf = Math.floor(turnedLeafPosition) - 2;
    const lastActiveLeaf = Math.ceil(turnedLeafPosition) + 2;
    for (const leaf of this.leaves) {
      if (leaf.index !== 0
        && (leaf.index < firstActiveLeaf || leaf.index > lastActiveLeaf)) continue;
      const distance = leaf.index - turnedLeafPosition;
      const leftLayerOffset = distance < 0
        ? Math.max(-PAGE_GAP * 2, distance * PAGE_GAP)
        : 0;
      const rightLayerOffset = distance > 0
        ? Math.max(-PAGE_GAP * 2, -distance * PAGE_GAP)
        : 0;
      leaf.setStackLevels(
        leftPageHeight + leftLayerOffset,
        rightPaperHeight + rightLayerOffset,
      );
    }
  }

  private async syncPageWindow(): Promise<void> {
    const generation = ++this.pageWindowGeneration;
    const retainedPages = collectRetainedPages(
      this.currentLeaf,
      this.pageTextures.pageCount,
    );
    this.loading = true;

    for (const leaf of this.leaves) {
      const frontPage = leaf.index * 2;
      const backPage = frontPage + 1;
      if (!retainedPages.has(frontPage)) leaf.setFrontTexture(this.pageTextures.placeholder);
      if (!retainedPages.has(backPage)) leaf.setBackTexture(this.pageTextures.placeholder);
      leaf.setEnabled(
        leaf.index >= this.currentLeaf - 2
        && leaf.index <= this.currentLeaf + 1,
      );
    }
    this.pageTextures.retainPages(retainedPages);
    this.emitState();

    let textures: Array<{ pageIndex: number; texture: HTMLCanvasElement }>;
    try {
      textures = await Promise.all([...retainedPages].map(async pageIndex => ({
        pageIndex,
        texture: await this.pageTextures.getPageTexture(pageIndex),
      })));
    } catch (error) {
      if (!this.disposed && generation === this.pageWindowGeneration) {
        this.loading = false;
        this.emitState();
      }
      throw error;
    }
    if (this.disposed || generation !== this.pageWindowGeneration) return;
    for (const { pageIndex, texture } of textures) {
      const leaf = this.leaves[Math.floor(pageIndex / 2)];
      if (!leaf) continue;
      if (pageIndex % 2 === 0) leaf.setFrontTexture(texture);
      else leaf.setBackTexture(texture);
    }
    this.loading = false;
    this.emitState();
  }

  private emitState(): void {
    const activeLeafIndex = this.drag?.leafIndex
      ?? this.animation?.leafIndex
      ?? Math.min(this.currentLeaf, this.leaves.length - 1);
    const progress = this.leaves[activeLeafIndex]?.progress ?? 1;
    this.options.onStateChange?.({
      currentLeaf: this.currentLeaf,
      leafCount: this.leaves.length,
      pageCount: this.pageTextures.pageCount,
      visiblePages: collectVisiblePages(this.currentLeaf, this.pageTextures.pageCount),
      residentPageCount: this.pageTextures.residentPageCount,
      progress,
      mode: this.loading
        ? 'loading'
        : this.drag
          ? 'dragging'
          : this.animation
            ? 'animating'
            : 'idle',
      canGoBack: !this.loading && !this.drag && !this.animation && this.currentLeaf > 0,
      canGoForward:
        !this.loading
        && !this.drag
        && !this.animation
        && this.currentLeaf < this.leaves.length,
    });
  }
}

export function collectRetainedPages(
  currentLeaf: number,
  pageCount: number,
): ReadonlySet<number> {
  const pages = new Set<number>();
  for (const pageIndex of [
    currentLeaf * 2 - 3,
    currentLeaf * 2 - 2,
    currentLeaf * 2 - 1,
    currentLeaf * 2,
    currentLeaf * 2 + 1,
    currentLeaf * 2 + 2,
  ]) {
    if (pageIndex >= 0 && pageIndex < pageCount) pages.add(pageIndex);
  }
  return pages;
}

function collectVisiblePages(currentLeaf: number, pageCount: number): readonly number[] {
  const pages: number[] = [];
  const leftPage = currentLeaf * 2 - 1;
  const rightPage = currentLeaf * 2;
  if (leftPage >= 0 && leftPage < pageCount) pages.push(leftPage + 1);
  if (rightPage >= 0 && rightPage < pageCount) pages.push(rightPage + 1);
  return pages;
}

export class PageTurnBookSystem extends System {
  constructor(private readonly book: PageTurnBook) {
    super(() => false);
    this.name = 'PageTurnBookSystem';
    this.priority = -1;
  }

  override update(_world: World, _time: number, delta: number): this {
    this.book.update(delta);
    return this;
  }

  override destroy(): this {
    this.book.dispose();
    return super.destroy();
  }
}

function createPageSurface(
  scene: Scene,
  name: string,
  texture: HTMLCanvasElement,
  side: 1 | -1,
  widthSegments: number,
  heightSegments: number,
): PageSurface {
  const vertexCount = (widthSegments + 1) * (heightSegments + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let row = 0; row <= heightSegments; row++) {
    const v = row / heightSegments;
    for (let column = 0; column <= widthSegments; column++) {
      const u = column / widthSegments;
      const vertex = row * (widthSegments + 1) + column;
      uvs[vertex * 2] = side === 1 ? u : 1 - u;
      uvs[vertex * 2 + 1] = v;
    }
  }
  const indices = createSurfaceIndices(widthSegments, heightSegments, side);
  const geometry = new Geometry3D({
    positions,
    normals,
    textureCoordinates: [{ set: 0, data: uvs }],
    indices,
    cullMode: 'back',
    boundsMode: 'manual',
    localBounds: { center: [0, PAGE_WIDTH * 0.35, 0], radius: 8.5 },
  });
  const material = new PbrMaterial({
    baseColor: [1, 1, 1, 1],
    baseColorTexture: texture,
    metallic: 0,
    roughness: side === 1 ? 0.86 : 0.9,
    specularFactor: 0.38,
    doubleSided: false,
    samplers: {
      baseColor: {
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
      },
    },
  });
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D());
  entity.addComponent(new Mesh3D(geometry, material));
  scene.add(entity);
  return { geometry, entity, material, side };
}

function updateSurfaceGeometry(
  surface: PageSurface,
  columnX: Float32Array,
  columnY: Float32Array,
  columnAngle: Float32Array,
  progress: number,
  baseY: number,
  halfThickness: number,
): void {
  const widthSegments = columnX.length - 1;
  const heightSegments = surface.geometry.positions.length / 3 / (widthSegments + 1) - 1;
  const positions = surface.geometry.positions;
  const rippleStrength = Math.sin(Math.PI * progress) * 0.038;
  for (let row = 0; row <= heightSegments; row++) {
    const rowRatio = row / heightSegments;
    const z = (rowRatio - 0.5) * PAGE_HEIGHT;
    const edge = Math.abs(rowRatio - 0.5) * 2;
    for (let column = 0; column <= widthSegments; column++) {
      const columnRatio = column / widthSegments;
      const angle = columnAngle[column] ?? 0;
      const normalX = -Math.sin(angle) * surface.side;
      const normalY = Math.cos(angle) * surface.side;
      const ripple = rippleStrength
        * Math.sin(Math.PI * columnRatio)
        * edge * edge;
      const offset = (row * (widthSegments + 1) + column) * 3;
      positions[offset] = (columnX[column] ?? 0) + normalX * halfThickness;
      positions[offset + 1] = baseY + (columnY[column] ?? 0)
        + normalY * halfThickness + ripple;
      positions[offset + 2] = z;
    }
  }
  updateNormals(positions, surface.geometry.normals!, surface.geometry.indices!);
  surface.geometry.markDirty();
}

function createSurfaceIndices(
  widthSegments: number,
  heightSegments: number,
  side: 1 | -1,
): Uint16Array {
  const values = new Uint16Array(widthSegments * heightSegments * 6);
  let cursor = 0;
  for (let row = 0; row < heightSegments; row++) {
    for (let column = 0; column < widthSegments; column++) {
      const a = row * (widthSegments + 1) + column;
      const b = a + 1;
      const c = a + widthSegments + 1;
      const d = c + 1;
      if (side === 1) {
        values[cursor++] = a; values[cursor++] = c; values[cursor++] = b;
        values[cursor++] = b; values[cursor++] = c; values[cursor++] = d;
      } else {
        values[cursor++] = a; values[cursor++] = b; values[cursor++] = c;
        values[cursor++] = b; values[cursor++] = d; values[cursor++] = c;
      }
    }
  }
  return values;
}

function updateNormals(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint16Array | Uint32Array,
): void {
  normals.fill(0);
  for (let index = 0; index < indices.length; index += 3) {
    const a = (indices[index] ?? 0) * 3;
    const b = (indices[index + 1] ?? 0) * 3;
    const c = (indices[index + 2] ?? 0) * 3;
    const abx = (positions[b] ?? 0) - (positions[a] ?? 0);
    const aby = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0);
    const abz = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0);
    const acx = (positions[c] ?? 0) - (positions[a] ?? 0);
    const acy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0);
    const acz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const offset of [a, b, c]) {
      normals[offset] = (normals[offset] ?? 0) + nx;
      normals[offset + 1] = (normals[offset + 1] ?? 0) + ny;
      normals[offset + 2] = (normals[offset + 2] ?? 0) + nz;
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const x = normals[index] ?? 0;
    const y = normals[index + 1] ?? 0;
    const z = normals[index + 2] ?? 0;
    const inverseLength = 1 / Math.max(0.000001, Math.hypot(x, y, z));
    normals[index] = x * inverseLength;
    normals[index + 1] = y * inverseLength;
    normals[index + 2] = z * inverseLength;
  }
}

function addStaticBookParts(scene: Scene, totalLeaves: number): BookStructure {
  const paperLeafCount = Math.max(1, totalLeaves - 1);
  const paperStackThickness = Math.min(
    MAX_PAPER_STACK_THICKNESS,
    Math.max(MIN_PAPER_STACK_THICKNESS, paperLeafCount * PAPER_STACK_THICKNESS_PER_LEAF),
  );
  const backCover = new Entity('Rigid back cover');
  backCover.addComponent(new CartesianTransform3D({
    position: [PAGE_WIDTH / 2, -COVER_THICKNESS / 2, 0],
  }));
  backCover.addComponent(new Mesh3D(
    createBox3D({
      width: PAGE_WIDTH + COVER_OVERHANG * 2,
      height: COVER_THICKNESS,
      depth: PAGE_HEIGHT + COVER_OVERHANG * 2,
    }),
    createCoverMaterial(),
  ));
  scene.add(backCover);

  const paperBlockGeometry = createBox3D({
    width: PAGE_WIDTH - 0.045,
    height: 1,
    depth: PAGE_HEIGHT - 0.045,
  });
  const leftPaperTransform = new CartesianTransform3D();
  const leftPaperBlock = new Entity('Turned page stack volume');
  leftPaperBlock.addComponent(leftPaperTransform);
  leftPaperBlock.addComponent(new Mesh3D(paperBlockGeometry, createPaperEdgeMaterial()));

  const rightPaperTransform = new CartesianTransform3D();
  const rightPaperBlock = new Entity('Unturned page stack volume');
  rightPaperBlock.addComponent(rightPaperTransform);
  rightPaperBlock.addComponent(new Mesh3D(paperBlockGeometry, createPaperEdgeMaterial()));
  scene.add(rightPaperBlock);

  const spineTransform = new CartesianTransform3D();
  const spine = new Entity('Book spine');
  spine.addComponent(spineTransform);
  spine.addComponent(new Mesh3D(
    createBox3D({
      width: SPINE_WIDTH,
      height: 1,
      depth: PAGE_HEIGHT + COVER_OVERHANG * 2,
    }),
    createCoverMaterial(),
  ));
  scene.add(spine);

  return {
    scene,
    leftPaperBlock,
    leftPaperTransform,
    rightPaperBlock,
    rightPaperTransform,
    spineTransform,
    paperStackThickness,
  };
}

function setPaperBlockHeight(
  scene: Scene,
  entity: Entity,
  transform: CartesianTransform3D,
  centerX: number,
  height: number,
): void {
  const hidden = height <= PAPER_BLOCK_HIDE_THRESHOLD;
  if (hidden) {
    transform
      .setPosition(centerX, -10, 0)
      .setScale(0.0001, 0.0001, 0.0001);
    // Removing the proxy also retires its renderer object slot. Keeping a
    // disabled or paper-thin box in the scene can leave the previous full-size
    // geometry visible below the left cover after the first turn.
    if (entity.world === scene.world) scene.remove(entity);
    return;
  }

  transform
    .setPosition(centerX, height / 2, 0)
    .setScale(1, height, 1);
  if (!entity.world) scene.add(entity);
}

function createPaperEdgeMaterial(): PbrMaterial {
  return new PbrMaterial({
    baseColor: [1, 1, 1, 1],
    baseColorTexture: createPaperEdgeTexture(),
    metallic: 0,
    roughness: 0.94,
    specularFactor: 0.2,
    samplers: {
      baseColor: {
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
      },
    },
  });
}

let sharedPaperEdgeTexture: HTMLCanvasElement | null = null;

function createPaperEdgeTexture(): HTMLCanvasElement {
  if (sharedPaperEdgeTexture) return sharedPaperEdgeTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.fillStyle = '#d8caa8';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 3; y < canvas.height; y += 5) {
    const variation = (y / 5) % 4;
    context.fillStyle = variation === 0
      ? 'rgba(103, 91, 68, 0.34)'
      : variation === 1
        ? 'rgba(132, 117, 87, 0.25)'
        : 'rgba(92, 80, 61, 0.18)';
    context.fillRect(0, y, canvas.width, 1);
    if (variation === 0) {
      context.fillStyle = 'rgba(255, 249, 225, 0.24)';
      context.fillRect(0, y + 1, canvas.width, 1);
    }
  }
  sharedPaperEdgeTexture = canvas;
  return canvas;
}

function createCoverMaterial(): PbrMaterial {
  return new PbrMaterial({
    baseColor: [0.27, 0.025, 0.055, 1],
    metallic: 0.02,
    roughness: 0.58,
    clearcoatFactor: 0.12,
    clearcoatRoughnessFactor: 0.72,
  });
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}
