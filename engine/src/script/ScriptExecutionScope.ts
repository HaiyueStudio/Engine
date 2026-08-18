export type ScriptDisposer = () => void;

/** Owns every side effect registered through the script capability API. */
export class ScriptExecutionScope {
  private readonly _disposers = new Set<ScriptDisposer>();
  private _disposed = false;

  constructor(readonly label: string) {}

  get disposed(): boolean { return this._disposed; }
  get disposableCount(): number { return this._disposers.size; }

  add(disposer: ScriptDisposer): ScriptDisposer {
    if (this._disposed) {
      disposer();
      return () => {};
    }
    this._disposers.add(disposer);
    return () => {
      if (!this._disposers.delete(disposer)) return;
      disposer();
    };
  }

  listen(
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): ScriptDisposer {
    target.addEventListener(type, listener, options);
    return this.add(() => target.removeEventListener(type, listener, options));
  }

  setTimeout(callback: () => void, delayMs = 0): ScriptDisposer {
    const id = globalThis.setTimeout(() => {
      this._disposers.delete(cancel);
      if (!this._disposed) callback();
    }, delayMs);
    const cancel = () => globalThis.clearTimeout(id);
    return this.add(cancel);
  }

  setInterval(callback: () => void, delayMs = 0): ScriptDisposer {
    const id = globalThis.setInterval(() => {
      if (!this._disposed) callback();
    }, delayMs);
    return this.add(() => globalThis.clearInterval(id));
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const disposers = [...this._disposers].reverse();
    this._disposers.clear();
    for (const disposer of disposers) {
      try { disposer(); } catch (error) { console.error(`[ScriptExecutionScope:${this.label}] dispose failed`, error); }
    }
  }
}
