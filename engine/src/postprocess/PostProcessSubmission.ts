import type { PostProcessPass } from './PostProcessPass';

type AfterSubmit = (callback: (queue: GPUQueue) => void) => void;
const boundaries = new WeakMap<PostProcessPass, AfterSubmit>();

/** Internal encoding scope; never retain a callback from a completed frame. */
export function setPostProcessSubmission(pass: PostProcessPass, afterSubmit?: AfterSubmit): void {
  if (afterSubmit) boundaries.set(pass, afterSubmit);
  else boundaries.delete(pass);
}

export function deferPostProcessDisposal(pass: PostProcessPass, dispose: () => void): boolean {
  const afterSubmit = boundaries.get(pass);
  if (!afterSubmit) return false;
  afterSubmit(queue => { void queue.onSubmittedWorkDone().then(dispose, dispose); });
  return true;
}
