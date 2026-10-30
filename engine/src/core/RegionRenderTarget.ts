import type {RenderViewTarget,RenderViewSnapshot} from './RenderView';
import type {ViewportRect} from './ViewportRect';

// Storage is always linear; its scene meaning follows the owning parent output.
// Keep this immutable for the target generation, including unsubmitted recordings.
const targets=new WeakMap<RenderViewTarget,boolean>();
export function registerRegionRenderTarget(target:RenderViewTarget,displayTransform=true):void {if(targets.has(target)&&targets.get(target)!==displayTransform)throw Error('Region target color meaning is immutable.');targets.set(target,displayTransform);}
export function isRegionRenderTarget(target:RenderViewTarget|undefined):boolean {return !!target&&targets.has(target);}
export function isRegionDisplayTarget(target:RenderViewTarget|undefined):boolean {return !!target&&targets.get(target)===true;}

// A clipped hardware viewport must not compress region-local GUI coordinates.
// Keep the original projection separate; it may extend outside the attachment.
const projections=new WeakMap<RenderViewSnapshot,Readonly<ViewportRect>>();
export function setRegionProjection(view:RenderViewSnapshot,rect:Readonly<ViewportRect>):void {projections.set(view,Object.freeze({...rect}));}
export function getRegionProjection(view:RenderViewSnapshot|undefined):Readonly<ViewportRect>|undefined {return view?projections.get(view):undefined;}
