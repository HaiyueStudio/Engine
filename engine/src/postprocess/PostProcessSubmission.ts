import type { PostProcessPass } from './PostProcessPass';

type AfterSubmit = (callback: (queue: GPUQueue) => void) => void;
const boundaries = new WeakMap<PostProcessPass, AfterSubmit>();
const cancellations = new WeakMap<PostProcessPass, (callback:()=>void)=>void>();
interface PostProcessRecording {readonly afterSubmit:AfterSubmit;readonly afterCancel?:((callback:()=>void)=>void)|undefined;}
const recordings = new WeakMap<PostProcessPass, PostProcessRecording>();
const frameCancellations = new WeakMap<object, (callback:()=>void)=>void>();
/** Private renderer frame wiring; keeps cancellation out of the public renderer ABI. */
export function setPostProcessFrameCancellation(owner: object, afterCancel?: (callback:()=>void)=>void): void {
  if(afterCancel)frameCancellations.set(owner,afterCancel);else frameCancellations.delete(owner);
}
export function getPostProcessFrameCancellation(owner:object): ((callback:()=>void)=>void)|undefined {return frameCancellations.get(owner);}
export function getPostProcessSubmission(pass: PostProcessPass): AfterSubmit | undefined { return boundaries.get(pass); }
export function getPostProcessRecording(pass: PostProcessPass): PostProcessRecording | undefined {return recordings.get(pass);}

/** Internal encoding scope; never retain a callback from a completed frame. */
export function setPostProcessSubmission(pass: PostProcessPass, afterSubmit?: AfterSubmit, afterCancel?: (callback:()=>void)=>void): void {
  if (afterSubmit) boundaries.set(pass, afterSubmit);
  else boundaries.delete(pass);
  if(afterCancel)cancellations.set(pass,afterCancel);else cancellations.delete(pass);
  if(afterSubmit)recordings.set(pass,{afterSubmit,afterCancel});else recordings.delete(pass);
}

export function deferPostProcessDisposal(pass: PostProcessPass, dispose: () => void): boolean {
  const afterSubmit = boundaries.get(pass);
  const afterCancel=cancellations.get(pass);
  if (!afterSubmit&&!afterCancel) return false;
  let disposed=false;const once=()=>{if(disposed)return;disposed=true;dispose()};
  afterSubmit?.(queue => { void queue.onSubmittedWorkDone().then(once, once); });
  afterCancel?.(once);
  return true;
}
