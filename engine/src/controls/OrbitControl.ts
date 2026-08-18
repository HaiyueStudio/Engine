import type { SphericalTransform3D } from '../components/SphericalTransform3D';
import { System } from '../ecs/System';
import { requiredMat4Array, requiredVec3Array } from '../math/arrayAccess';

export interface OrbitControlOptions {
  /** Mouse sensitivity for rotation (default 1.0). */
  rotateSpeed?: number;
  /** Wheel sensitivity for zoom (default 1.0). */
  zoomSpeed?: number;
  /** Drag sensitivity for panning (default 1.0). */
  panSpeed?: number;
  /** Minimum orbit radius (default 0.1). */
  minRadius?: number;
  /** Maximum orbit radius (default Infinity). */
  maxRadius?: number;
  /** Minimum polar angle in radians (default 0.01). */
  minPhi?: number;
  /** Maximum polar angle in radians (default Math.PI - 0.01). */
  maxPhi?: number;
  /** Enable right/middle-drag panning (default true). */
  enablePan?: boolean;
  /** Enable scroll-wheel zooming (default true). */
  enableZoom?: boolean;
  /** Enable mouse-drag rotating (default true). */
  enableRotate?: boolean;
  /** Normalized canvas region that accepts input. Defaults to the full canvas. */
  inputRegion?: Readonly<{ x: number; y: number; width: number; height: number }>;
}

/**
 * OrbitControl
 *
 * Drives a SphericalTransform3D by listening to canvas pointer and wheel events.
 *
 * Bindings:
 *   Left drag      → orbit (theta / phi)
 *   Right/mid drag → pan (translate target point)
 *   Scroll wheel   → zoom (radius)
 *   Pinch (touch)  → zoom
 *
 * Usage:
 *   const sph = new SphericalTransform3D({ radius: 10, phi: Math.PI / 4 });
 *   cameraEntity.addComponent(sph);
 *   const orbit = new OrbitControl(engine.canvas, sph);
 *   // later: orbit.dispose();
 */
export class OrbitControl extends System {
  rotateSpeed: number;
  zoomSpeed: number;
  panSpeed: number;
  minRadius: number;
  maxRadius: number;
  minPhi: number;
  maxPhi: number;
  enablePan: boolean;
  enableZoom: boolean;
  enableRotate: boolean;
  readonly inputRegion: Readonly<{ x: number; y: number; width: number; height: number }>;

  private readonly _canvas: HTMLCanvasElement;
  private readonly _transform: SphericalTransform3D;

  /** Active pointers: id → last client position and gesture selected at pointerdown. */
  private _pointers = new Map<number, { x: number; y: number; mode: 'rotate' | 'pan' }>();
  private _lastPinchDist = 0;

  constructor(
    canvas: HTMLCanvasElement,
    transform: SphericalTransform3D,
    options: OrbitControlOptions = {},
  ) {
    super(() => false);
    this.name = 'OrbitControl';
    this._canvas    = canvas;
    this._transform = transform;

    this.rotateSpeed  = options.rotateSpeed  ?? 1.0;
    this.zoomSpeed    = options.zoomSpeed    ?? 1.0;
    this.panSpeed     = options.panSpeed     ?? 1.0;
    this.minRadius    = options.minRadius    ?? 0.1;
    this.maxRadius    = options.maxRadius    ?? Infinity;
    this.minPhi       = options.minPhi       ?? 0.01;
    this.maxPhi       = options.maxPhi       ?? Math.PI - 0.01;
    this.enablePan    = options.enablePan    ?? true;
    this.enableZoom   = options.enableZoom   ?? true;
    this.enableRotate = options.enableRotate ?? true;
    this.inputRegion  = normalizeInputRegion(options.inputRegion);

    this._bind();
  }

  dispose(): void {
    const c = this._canvas;
    c.removeEventListener('pointerdown',   this._onDown);
    c.removeEventListener('pointermove',   this._onMove);
    c.removeEventListener('pointerup',     this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('wheel',         this._onWheel as EventListener);
    c.removeEventListener('contextmenu',   this._onContextMenu);
  }

  override destroy(): this {
    this.dispose();
    return super.destroy();
  }

  // ── Event binding ──────────────────────────────────────────────────────────

  private _bind(): void {
    const c = this._canvas;
    c.addEventListener('pointerdown',   this._onDown);
    c.addEventListener('pointermove',   this._onMove);
    c.addEventListener('pointerup',     this._onUp);
    c.addEventListener('pointercancel', this._onUp);
    c.addEventListener('wheel',         this._onWheel as EventListener, { passive: false });
    c.addEventListener('contextmenu',   this._onContextMenu);
  }

  private _onContextMenu = (e: Event) => e.preventDefault();

  private _onDown = (e: PointerEvent) => {
    if (!this._acceptsInput(e.clientX, e.clientY)) return;
    const mode = getPointerGestureMode(e);
    if (!mode) return;
    e.preventDefault();
    this._canvas.setPointerCapture(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, mode });
  };

  private _onUp = (e: PointerEvent) => {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._lastPinchDist = 0;
  };

  private _onMove = (e: PointerEvent) => {
    const prev = this._pointers.get(e.pointerId);
    if (!prev) return;

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    // ── Two-pointer pinch-to-zoom ──────────────────────────────────────────
    if (this._pointers.size === 2) {
      const pointers = this._pointers.values();
      const aResult = pointers.next();
      const bResult = pointers.next();
      if (aResult.done || bResult.done) return;
      const a = aResult.value;
      const b = bResult.value;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this._lastPinchDist > 0) {
        this._zoom((this._lastPinchDist - dist) * 0.02);
      }
      this._lastPinchDist = dist;
      return;
    }
    this._lastPinchDist = 0;

    // ── Single pointer ─────────────────────────────────────────────────────
    if (prev.mode === 'rotate' && this.enableRotate) {
      this._rotate(dx, dy);
    } else if (prev.mode === 'pan' && this.enablePan) {
      this._pan(dx, dy);
    }
  };

  private _onWheel = (e: WheelEvent) => {
    if (!this.enableZoom || !this._acceptsInput(e.clientX, e.clientY)) return;
    e.preventDefault();
    // Normalise across wheel delta modes
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 30;   // line mode
    if (e.deltaMode === 2) delta *= 300;  // page mode
    this._zoom(delta * 0.001 * this.zoomSpeed);
  };

  // ── Actions ────────────────────────────────────────────────────────────────

  private _rotate(dx: number, dy: number): void {
    const rect = this._canvas.getBoundingClientRect();
    const width = rect.width * this.inputRegion.width;
    const height = rect.height * this.inputRegion.height;
    if (width <= 0 || height <= 0) return;
    const dTheta = -(dx / width)  * Math.PI * 2 * this.rotateSpeed;
    const dPhi   = -(dy / height) * Math.PI     * this.rotateSpeed;

    const newPhi = Math.max(
      this.minPhi,
      Math.min(this.maxPhi, this._transform.phi + dPhi),
    );
    // Batch update — single rebuild
    this._transform.set(this._transform.radius, this._transform.theta + dTheta, newPhi);
  }

  private _zoom(delta: number): void {
    const r = Math.max(
      this.minRadius,
      Math.min(this.maxRadius, this._transform.radius * (1 + delta)),
    );
    this._transform.radius = r;
  }

  /**
   * Pan: translate the orbit target in the camera's XY plane.
   *
   * When you drag right (+dx), the scene should follow → target moves
   * along -cameraRight so that world content tracks the cursor.
   *
   * Scale: one canvas-height of drag ≈ one orbit-radius of world movement.
   */
  private _pan(dx: number, dy: number): void {
    const r    = this._transform.radius;
    const rect = this._canvas.getBoundingClientRect();
    const height = rect.height * this.inputRegion.height;
    if (height <= 0) return;
    const scale = r / height * this.panSpeed;

    // Camera world matrix (SphericalTransform3D's localMatrix):
    //   column 0 (m[0..2])  = camera right
    //   column 1 (m[4..6])  = camera up
    const m = requiredMat4Array(this._transform.localMatrix, 'orbit camera local matrix');
    const rx = m[0], ry = m[1], rz = m[2];
    const ux = m[4], uy = m[5], uz = m[6];

    const t = requiredVec3Array(this._transform.target, 'orbit target');
    this._transform.setTarget(
      t[0] + (-rx * dx + ux * dy) * scale,
      t[1] + (-ry * dx + uy * dy) * scale,
      t[2] + (-rz * dx + uz * dy) * scale,
    );
  }

  private _acceptsInput(clientX: number, clientY: number): boolean {
    const rect = this._canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    const region = this.inputRegion;
    return x >= region.x
      && x <= region.x + region.width
      && y >= region.y
      && y <= region.y + region.height;
  }
}

function normalizeInputRegion(
  value: OrbitControlOptions['inputRegion'],
): Readonly<{ x: number; y: number; width: number; height: number }> {
  const region = value ?? { x: 0, y: 0, width: 1, height: 1 };
  if (
    !Number.isFinite(region.x)
    || !Number.isFinite(region.y)
    || !Number.isFinite(region.width)
    || !Number.isFinite(region.height)
    || region.x < 0
    || region.y < 0
    || region.width <= 0
    || region.height <= 0
    || region.x + region.width > 1
    || region.y + region.height > 1
  ) {
    throw new RangeError('OrbitControl inputRegion must be a positive normalized rectangle inside the canvas.');
  }
  return Object.freeze({ ...region });
}

function getPointerGestureMode(event: PointerEvent): 'rotate' | 'pan' | null {
  if (event.pointerType === 'touch' || event.button === 0) return 'rotate';
  if (event.button === 1 || event.button === 2) return 'pan';
  return null;
}
