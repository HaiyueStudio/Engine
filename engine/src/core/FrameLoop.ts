export interface FrameLoopOptions {
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  onFrame(time: number, delta: number): void;
}

export class FrameLoop {
  private readonly _now: () => number;
  private readonly _requestFrame: (callback: FrameRequestCallback) => number;
  private readonly _cancelFrame: (handle: number) => void;
  private readonly _onFrame: (time: number, delta: number) => void;
  private _frameId = 0;
  private _running = false;
  private _lastTime = 0;

  constructor(options: FrameLoopOptions) {
    this._now = options.now ?? (() => performance.now());
    this._requestFrame = options.requestFrame ?? (callback => requestAnimationFrame(callback));
    this._cancelFrame = options.cancelFrame ?? (handle => cancelAnimationFrame(handle));
    this._onFrame = options.onFrame;
  }

  get running(): boolean {
    return this._running;
  }

  start(): this {
    if (this._running) return this;
    this._running = true;
    this._lastTime = this._now();
    this._frameId = this._requestFrame(this._tick);
    return this;
  }

  stop(): this {
    if (!this._running && !this._frameId) return this;
    this._running = false;
    if (this._frameId) {
      this._cancelFrame(this._frameId);
      this._frameId = 0;
    }
    return this;
  }

  private readonly _tick = (time: number): void => {
    if (!this._running) return;
    const delta = time - this._lastTime;
    this._lastTime = time;
    this._onFrame(time, delta);
    if (this._running) {
      this._frameId = this._requestFrame(this._tick);
    }
  };
}
