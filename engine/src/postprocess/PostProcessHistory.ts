import type {PostProcessPass} from './PostProcessPass';

const resets=new WeakMap<PostProcessPass,(viewKey:string)=>void>();
const frames=new WeakMap<object,(token:unknown)=>void>();
/** Private history capability: cancellation is CPU-immediate, separate from GPU retirement. */
export function registerPostProcessHistoryReset(pass:PostProcessPass,reset:(viewKey:string)=>void):void {resets.set(pass,reset);}
export function resetAbandonedPostProcessHistory(pass:PostProcessPass,viewKey:string):void {resets.get(pass)?.(viewKey);}
export function registerPostProcessFrameAbandonment(owner:object,abandon:(token:unknown)=>void):void {frames.set(owner,abandon);}
export function abandonPostProcessFrame(owner:object,token:unknown):void {frames.get(owner)?.(token);}
