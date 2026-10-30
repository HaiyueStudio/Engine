import type {RenderCommandContext} from './RenderCommandContext';
import type {RenderViewSnapshot,RenderViewTarget} from './RenderView';

interface Composition {committed:boolean;pending:WeakMap<RenderCommandContext,{replacement:boolean}>;}
const compositions=new WeakMap<RenderViewTarget,Composition>();

/** A cleared bitmap starts as an overlay; loading preserves its prior coverage meaning. */
export function beginRegionComposition(target:RenderViewTarget,context:RenderCommandContext,clear:boolean,history?:RenderViewTarget):void {
  if(!context.afterSubmit||!context.afterCancel)throw Error('Region composition requires submission and cancellation boundaries.');
  let state=compositions.get(target);
  if(!state){state={committed:false,pending:new WeakMap()};compositions.set(target,state);}
  const selected=state,record={replacement:!clear&&(history?compositions.get(history)?.committed??false:state.committed)};
  state.pending.set(context,record);
  context.afterSubmit(()=>{selected.committed=record.replacement;selected.pending.delete(context);});
  context.afterCancel(()=>selected.pending.delete(context));
}

/** A non-blended full scene output already owns its background, including partial alpha. */
export function markRegionReplacement(view:RenderViewSnapshot,context:RenderCommandContext):void {
  if(view.loadOp==='load')return;
  const target=view.target,full=(r:{x:number;y:number;width:number;height:number}|null)=>!r||(r.x===0&&r.y===0&&r.width===target.width&&r.height===target.height);
  if(!full(view.viewport)||!full(view.scissor))return;
  const record=compositions.get(target)?.pending.get(context);
  if(record)record.replacement=true;
}

/** Foreground-only GUI pixels blend; complete scene bitmaps replace their covered parent pixels. */
export function regionReplacesParent(target:RenderViewTarget,context:RenderCommandContext):boolean {
  const state=compositions.get(target);
  return state?.pending.get(context)?.replacement??state?.committed??false;
}
