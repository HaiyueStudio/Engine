import type { CartesianTransform3D } from '../components/CartesianTransform3D';
import { System } from '../ecs/System';
import type { World } from '../ecs/World';

const MAX_FRAME_SECONDS = 0.1;
const SURFACE_EPSILON = 1e-5;

export interface FirstPersonControlsOptions {
  /** Horizontal walking speed in world units per second. Defaults to 4. */
  moveSpeed?: number;
  /** Multiplier while Shift is held. Defaults to 1.75. */
  sprintMultiplier?: number;
  /** Mouse-look radians per CSS pixel. Defaults to 0.002. */
  lookSensitivity?: number;
  /** Maximum absolute pitch in radians. Defaults to PI / 2 - 0.01. */
  maxPitch?: number;
  /** Initial upward velocity produced by Space. Defaults to 5.5. */
  jumpSpeed?: number;
  /** Downward acceleration in world units per second squared. Defaults to 16. */
  gravity?: number;
  /** Transform Y offset above the sampled surface (for example a sphere radius). */
  groundOffset?: number;
  /** Height that can be stepped automatically without jumping. Defaults to 0.2. */
  maxStepHeight?: number;
  /**
   * Returns the local ground height for an X/Z position, or null when there is
   * no supporting surface. NavMesh.sampleSurface() is a natural adapter.
   */
  groundProbe?: (position: Readonly<Float32Array>) => number | null;
  /** Use Pointer Lock mouse look when available. Defaults to true. */
  pointerLock?: boolean;
  /** Keyboard event source. Defaults to canvas.ownerDocument.defaultView. */
  keyboardTarget?: EventTarget;
  /** Whether the supplied starting position is already grounded. Defaults to true. */
  initialGrounded?: boolean;
}

/**
 * Pointer-lock first-person movement with optional surface-aware gravity,
 * jumping, low-step rejection, and hole fall-through.
 *
 * Add it to a Scene as a non-render system or call step() before scene update.
 * The controlled transform may be a camera or a player root containing a
 * child camera.
 */
export class FirstPersonControls extends System {
  moveSpeed: number;
  sprintMultiplier: number;
  lookSensitivity: number;
  maxPitch: number;
  jumpSpeed: number;
  gravity: number;
  groundOffset: number;
  maxStepHeight: number;

  readonly velocity = new Float32Array(3);

  private readonly _canvas: HTMLCanvasElement;
  private readonly _transform: CartesianTransform3D;
  private readonly _document: Document | null;
  private readonly _keyboardTarget: EventTarget | null;
  private readonly _groundProbe: (position: Readonly<Float32Array>) => number | null;
  private readonly _pointerLock: boolean;
  private readonly _pointerLockSupported: boolean;
  private readonly _keys = new Set<string>();
  private readonly _current = new Float32Array(3);
  private readonly _desired = new Float32Array(3);
  private readonly _probePosition = new Float32Array(3);
  private _grounded: boolean;
  private _jumpQueued = false;
  private _disposed = false;
  private _fallbackInputActive = false;
  private _yaw: number;
  private _pitch: number;
  private _dragging = false;
  private _lastPointerX = 0;
  private _lastPointerY = 0;

  constructor(
    canvas: HTMLCanvasElement,
    transform: CartesianTransform3D,
    options: FirstPersonControlsOptions = {},
  ) {
    super(() => false);
    this.name = 'FirstPersonControls';
    this.priority = -100;
    this._canvas = canvas;
    this._transform = transform;
    this._document = canvas.ownerDocument ?? globalThis.document ?? null;
    this._keyboardTarget = options.keyboardTarget
      ?? this._document?.defaultView
      ?? this._document;
    this._pointerLock = options.pointerLock ?? true;
    this._pointerLockSupported = this._pointerLock
      && typeof canvas.requestPointerLock === 'function'
      && this._document !== null;
    this._groundProbe = options.groundProbe ?? (() => 0);
    this._grounded = options.initialGrounded ?? true;

    this.moveSpeed = finiteNonNegative(options.moveSpeed ?? 4, 'moveSpeed');
    this.sprintMultiplier = finiteNonNegative(options.sprintMultiplier ?? 1.75, 'sprintMultiplier');
    this.lookSensitivity = finiteNonNegative(options.lookSensitivity ?? 0.002, 'lookSensitivity');
    this.maxPitch = finiteInRange(options.maxPitch ?? Math.PI * 0.5 - 0.01, 0, Math.PI * 0.5, 'maxPitch');
    this.jumpSpeed = finiteNonNegative(options.jumpSpeed ?? 5.5, 'jumpSpeed');
    this.gravity = finiteNonNegative(options.gravity ?? 16, 'gravity');
    this.groundOffset = finiteNonNegative(options.groundOffset ?? 0, 'groundOffset');
    this.maxStepHeight = finiteNonNegative(options.maxStepHeight ?? 0.2, 'maxStepHeight');
    this._pitch = transform.rotation[0] ?? 0;
    this._yaw = transform.rotation[1] ?? 0;
    this._bind();
  }

  get grounded(): boolean { return this._grounded; }
  get pointerLocked(): boolean { return this._document?.pointerLockElement === this._canvas; }

  requestPointerLock(): void {
    if (!this._pointerLockSupported || this._disposed) return;
    this._fallbackInputActive = true;
    try {
      const pending = this._canvas.requestPointerLock();
      if (pending && typeof (pending as Promise<void>).catch === 'function') {
        void (pending as Promise<void>).catch(() => { this._fallbackInputActive = true; });
      }
    } catch {
      // Pointer lock can be denied by browser policy; drag-look remains usable.
      this._fallbackInputActive = true;
    }
  }

  /** Clears accumulated velocity and moves the controlled transform atomically. */
  teleport(position: readonly [number, number, number] | Float32Array, grounded = true): this {
    const x = finiteCoordinate(position[0], 'teleport X');
    const y = finiteCoordinate(position[1], 'teleport Y');
    const z = finiteCoordinate(position[2], 'teleport Z');
    this.velocity.fill(0);
    this._jumpQueued = false;
    this._grounded = grounded;
    this._transform.setPosition(x, y, z);
    return this;
  }

  /** Advances movement. Delta is expressed in milliseconds, matching World.update(). */
  step(deltaMilliseconds: number): this {
    if (this.disabled || this._disposed) return this;
    if (!Number.isFinite(deltaMilliseconds)) {
      throw new RangeError('FirstPersonControls deltaMilliseconds must be finite.');
    }
    const deltaSeconds = Math.min(
      Math.max(deltaMilliseconds * 0.001, 0),
      MAX_FRAME_SECONDS,
    );
    if (deltaSeconds === 0) return this;

    const position = this._transform.position;
    this._current.set(position);
    const currentGround = this._probe(this._current[0]!, this._current[2]!, this._current[1]!);
    if (this._grounded) {
      if (currentGround === null) {
        this._grounded = false;
      } else {
        this._current[1] = currentGround + this.groundOffset;
      }
    }

    if (this._jumpQueued && this._grounded) {
      this.velocity[1] = this.jumpSpeed;
      this._grounded = false;
    }
    this._jumpQueued = false;

    const forwardInput = axis(this._keys, ['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const rightInput = axis(this._keys, ['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const inputLength = Math.hypot(forwardInput, rightInput);
    const inputScale = inputLength > 1 ? 1 / inputLength : 1;
    const speed = this.moveSpeed * (this._keys.has('ShiftLeft') || this._keys.has('ShiftRight')
      ? this.sprintMultiplier
      : 1);
    const sinYaw = Math.sin(this._yaw);
    const cosYaw = Math.cos(this._yaw);
    this.velocity[0] = (cosYaw * rightInput - sinYaw * forwardInput) * inputScale * speed;
    this.velocity[2] = (-sinYaw * rightInput - cosYaw * forwardInput) * inputScale * speed;
    if (this._grounded) this.velocity[1] = 0;
    else this.velocity[1] = this.velocity[1]! - this.gravity * deltaSeconds;

    this._desired[0] = this._current[0]! + this.velocity[0]! * deltaSeconds;
    this._desired[1] = this._current[1]! + this.velocity[1]! * deltaSeconds;
    this._desired[2] = this._current[2]! + this.velocity[2]! * deltaSeconds;
    this._resolveHorizontalMotion();
    this._resolveVerticalMotion();
    this._transform.setPosition(this._desired[0]!, this._desired[1]!, this._desired[2]!);
    return this;
  }

  override update(_world: World, _time: number, delta: number): this {
    return this.step(delta);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._keys.clear();
    this._canvas.removeEventListener('click', this._onClick);
    this._canvas.removeEventListener('pointerdown', this._onPointerDown);
    this._canvas.removeEventListener('pointermove', this._onPointerMove);
    this._canvas.removeEventListener('pointerup', this._onPointerUp);
    this._canvas.removeEventListener('pointercancel', this._onPointerUp);
    this._document?.removeEventListener('mousemove', this._onDocumentMouseMove);
    this._document?.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this._keyboardTarget?.removeEventListener('keydown', this._onKeyDown);
    this._keyboardTarget?.removeEventListener('keyup', this._onKeyUp);
    this._keyboardTarget?.removeEventListener('blur', this._onBlur);
    if (this.pointerLocked) this._document?.exitPointerLock?.();
  }

  override destroy(): this {
    this.dispose();
    return super.destroy();
  }

  private _resolveHorizontalMotion(): void {
    if (this._canOccupy(this._desired[0]!, this._desired[2]!)) return;
    const desiredX = this._desired[0]!;
    const desiredZ = this._desired[2]!;
    this._desired[0] = this._current[0]!;
    this._desired[2] = this._current[2]!;
    if (Math.abs(desiredX - this._current[0]!) > SURFACE_EPSILON
      && this._canOccupy(desiredX, this._current[2]!)) {
      this._desired[0] = desiredX;
      return;
    }
    if (Math.abs(desiredZ - this._current[2]!) > SURFACE_EPSILON
      && this._canOccupy(this._current[0]!, desiredZ)) {
      this._desired[2] = desiredZ;
    }
  }

  private _canOccupy(x: number, z: number): boolean {
    const surface = this._probe(x, z, this._desired[1]!);
    if (surface === null) return true;
    const targetY = surface + this.groundOffset;
    if (targetY <= this._current[1]! + this.maxStepHeight + SURFACE_EPSILON) return true;
    return Math.max(this._current[1]!, this._desired[1]!) >= targetY - SURFACE_EPSILON;
  }

  private _resolveVerticalMotion(): void {
    const surface = this._probe(this._desired[0]!, this._desired[2]!, this._desired[1]!);
    if (surface === null) {
      this._grounded = false;
      return;
    }
    const targetY = surface + this.groundOffset;
    const stepDelta = targetY - this._current[1]!;
    if (this._grounded && Math.abs(stepDelta) <= this.maxStepHeight + SURFACE_EPSILON) {
      this._desired[1] = targetY;
      this.velocity[1] = 0;
      return;
    }
    if (this.velocity[1]! <= 0
      && this._current[1]! >= targetY - SURFACE_EPSILON
      && this._desired[1]! <= targetY + SURFACE_EPSILON) {
      this._desired[1] = targetY;
      this.velocity[1] = 0;
      this._grounded = true;
      return;
    }
    this._grounded = false;
  }

  private _probe(x: number, z: number, y: number): number | null {
    this._probePosition[0] = x;
    this._probePosition[1] = y;
    this._probePosition[2] = z;
    const height = this._groundProbe(this._probePosition);
    if (height === null) return null;
    if (!Number.isFinite(height)) throw new RangeError('FirstPersonControls groundProbe must return a finite height or null.');
    return height;
  }

  private _bind(): void {
    this._canvas.addEventListener('click', this._onClick);
    this._canvas.addEventListener('pointerdown', this._onPointerDown);
    this._canvas.addEventListener('pointermove', this._onPointerMove);
    this._canvas.addEventListener('pointerup', this._onPointerUp);
    this._canvas.addEventListener('pointercancel', this._onPointerUp);
    this._document?.addEventListener('mousemove', this._onDocumentMouseMove);
    this._document?.addEventListener('pointerlockchange', this._onPointerLockChange);
    this._keyboardTarget?.addEventListener('keydown', this._onKeyDown);
    this._keyboardTarget?.addEventListener('keyup', this._onKeyUp);
    this._keyboardTarget?.addEventListener('blur', this._onBlur);
  }

  private _onClick = () => this.requestPointerLock();

  private _onPointerDown = (event: PointerEvent) => {
    if (this.pointerLocked) return;
    this._fallbackInputActive = true;
    this._dragging = true;
    this._lastPointerX = event.clientX;
    this._lastPointerY = event.clientY;
    this._canvas.setPointerCapture?.(event.pointerId);
  };

  private _onPointerMove = (event: PointerEvent) => {
    if (!this._dragging || this.pointerLocked) return;
    const dx = event.clientX - this._lastPointerX;
    const dy = event.clientY - this._lastPointerY;
    this._lastPointerX = event.clientX;
    this._lastPointerY = event.clientY;
    this._applyLook(dx, dy);
  };

  private _onPointerUp = () => { this._dragging = false; };

  private _onDocumentMouseMove = (event: MouseEvent) => {
    if (!this.pointerLocked) return;
    this._applyLook(event.movementX, event.movementY);
  };

  private _onPointerLockChange = () => {
    if (this.pointerLocked) {
      this._dragging = false;
      this._fallbackInputActive = false;
    } else {
      this._fallbackInputActive = false;
      this._clearInput();
    }
  };

  private _onKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (!this._acceptsKeyboard() || !isControlCode(keyboardEvent.code)) return;
    if (keyboardEvent.code === 'Space' && !keyboardEvent.repeat) this._jumpQueued = true;
    this._keys.add(keyboardEvent.code);
    keyboardEvent.preventDefault?.();
  };

  private _onKeyUp = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (!isControlCode(keyboardEvent.code)) return;
    this._keys.delete(keyboardEvent.code);
    keyboardEvent.preventDefault?.();
  };

  private _onBlur = () => this._clearInput();

  private _acceptsKeyboard(): boolean {
    return !this._pointerLockSupported || this.pointerLocked || this._fallbackInputActive;
  }

  private _clearInput(): void {
    this._keys.clear();
    this._jumpQueued = false;
  }

  private _applyLook(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this._yaw -= dx * this.lookSensitivity;
    this._pitch = Math.max(-this.maxPitch, Math.min(this.maxPitch, this._pitch - dy * this.lookSensitivity));
    this._transform.setRotation(this._pitch, this._yaw, 0);
  }
}

function axis(keys: ReadonlySet<string>, positive: readonly string[], negative: readonly string[]): number {
  return Number(positive.some(key => keys.has(key))) - Number(negative.some(key => keys.has(key)));
}

function isControlCode(code: string): boolean {
  return code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD'
    || code === 'ArrowUp' || code === 'ArrowLeft' || code === 'ArrowDown' || code === 'ArrowRight'
    || code === 'ShiftLeft' || code === 'ShiftRight' || code === 'Space';
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`FirstPersonControls ${label} must be finite and non-negative.`);
  return value;
}

function finiteInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value <= min || value >= max) {
    throw new RangeError(`FirstPersonControls ${label} must be finite and between ${min} and ${max}.`);
  }
  return value;
}

function finiteCoordinate(value: number | undefined, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`FirstPersonControls ${label} must be finite.`);
  return value as number;
}
