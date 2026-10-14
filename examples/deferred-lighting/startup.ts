import type { HaiyueEngine } from '@haiyue/engine';

/** Prepare actual draw paths and temporal history before exposing interaction. */
export async function prepareFirstFrames(engine: HaiyueEngine, signal: AbortSignal): Promise<void> {
  for (let frame = 0; frame < 2; frame++) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { engine.off('after-update', complete); engine.stop(); reject(signal.reason); };
      const complete = () => { signal.removeEventListener('abort', abort); engine.stop(); resolve(); };
      signal.addEventListener('abort', abort, { once: true });
      engine.once('after-update', complete);
      engine.run();
    });
    await engine.device.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
  }
}
