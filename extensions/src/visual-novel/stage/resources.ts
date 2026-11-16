/** A single acquisition queue bounds both candidate loading and explicit branch preloads. */
export class StageResourceQueue {
  private active = 0;
  private readonly queued = new Set<() => void>();

  constructor(private readonly concurrency: number) {}

  run<T>(signal: AbortSignal, acquire: () => Promise<T>, release: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const cancel = () => {
        if (this.queued.delete(start)) signal.removeEventListener('abort', cancel);
        reject(signal.reason);
      };
      const start = () => {
        this.queued.delete(start);
        this.active++;
        void Promise.resolve().then(() => {
          signal.throwIfAborted();
          return acquire();
        }).then(value => {
          if (signal.aborted) release(value);
          else resolve(value);
        }).catch(reject).finally(() => {
          signal.removeEventListener('abort', cancel);
          this.active--;
          this.pump();
        });
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.queued.add(start);
      this.pump();
    });
  }

  private pump(): void {
    for (const start of this.queued) {
      if (this.active >= this.concurrency) break;
      start();
    }
  }
}
