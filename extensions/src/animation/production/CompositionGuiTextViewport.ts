import type {GuiSystem,GuiRoot} from '@haiyue/engine/gui';
import type {GuiTextModel,ProductionCompositionFrame} from './CompositionOwner.js';
import type {ProductionTextResult} from '../text/production/types.js';
import {productionTextEditing} from '../text/production/ProductionTextEditing.js';
type Rect=readonly[number,number,number,number];
type Geometry=Parameters<GuiSystem['projectInputPresentation']>[0];
type Presentation=ReturnType<GuiSystem['projectInputPresentation']>;
type RootView=GuiRoot['viewport'];

/** Absolute GUI geometry from the same unscrolled prepared HYA result; no font or editor is owned here. */
export function guiTextGeometry(model:GuiTextModel,shape:ProductionTextResult,root:RootView,viewport:readonly[number,number],offset:number,projectTransform=true):Geometry{
 const r=model.node.rect,sx=root.width/viewport[0],sy=root.height/viewport[1],reader=productionTextEditing(shape);
 const convert=(q:Rect)=>({x:root.x+(r[0]+q[0])*sx,y:root.y+(r[1]+q[1])*sy,width:q[2]*sx,height:q[3]*sy});
 const clip=model.node.clip?intersect(r,model.node.clip):r,caret=reader.caret(offset);
 let left=0,top=0,right=0,bottom=0;for(const group of [shape.editing!.carets,shape.editing!.cells])for(const item of group){const q=item.rect;left=Math.min(left,q[0]);top=Math.min(top,q[1]);right=Math.max(right,q[0]+q[2]);bottom=Math.max(bottom,q[1]+q[3]);}
 const bounds=convert([left,top,right-left,bottom-top]);
 const m=projectTransform?model.node.transform:undefined;
 const coordinateTransform=m?[m[0],m[1]*sy/sx,m[2]*sx/sy,m[3],root.x+sx*m[4]-m[0]*root.x-m[2]*sx/sy*root.y,root.y+sy*m[5]-m[1]*sy/sx*root.x-m[3]*root.y] as const:undefined;
 return{...(coordinateTransform?{coordinateTransform}:{}),adornments:{eye:null,counter:null,right:0,bottom:0},clip:{x:root.x+clip[0]*sx,y:root.y+clip[1]*sy,width:clip[2]*sx,height:clip[3]*sy},origin:{x:root.x+r[0]*sx,y:root.y+r[1]*sy},textHeight:r[3]*sy,caret:convert(caret),lines:shape.lines.map(line=>shape.editing!.text.slice(line.startUtf16,line.endUtf16)),lineHeight:caret[3]*sy,ranges:(a,b)=>reader.ranges(a,b).map(convert),indexAt:(x,y)=>Math.min(shape.editing!.text.length,reader.indexAt((x-root.x)/sx-r[0],(y-root.y)/sy-r[1])),contentWidth:bounds.width,contentHeight:bounds.height,contentBounds:bounds};
}

/** Project retained real glyphs and controls; the original immutable font result stays unscrolled for G06. */
export function projectGuiText(model:GuiTextModel,source:ProductionTextResult,p:Presentation,root:RootView,viewport:readonly[number,number],focused:boolean):GuiTextModel['node']{
 const sx=viewport[0]/root.width,sy=viewport[1]/root.height,dx=p.scrollX*sx,dy=p.scrollY*sy,r=model.node.rect,shift=(q:Rect):Rect=>Object.freeze([q[0]-dx,q[1]-dy,q[2],q[3]]),local=(q:{x:number;y:number;width:number;height:number}):Rect=>Object.freeze([(q.x-root.x)*sx-r[0],(q.y-root.y)*sy-r[1],q.width*sx,q.height*sy]);
 const controls:ProductionTextResult['controls'][number][]=source.controls.filter(c=>c.kind==='selection'&&model.view?.selection&&focused).map(c=>Object.freeze({...c,rect:shift(c.rect)}));
 if(p.caretVisible)controls.push(Object.freeze({kind:'cursor',rect:local(p.caret)}));
 const composition=Object.freeze((p.compositionRanges??[]).filter(q=>q.width>0).map(q=>{const r=local(q);return Object.freeze([r[0],r[1]+r[3]-2,r[2],1]) as Rect;}));
 const text:ProductionTextResult=Object.freeze({...source,
  runs:Object.freeze(source.runs.map(run=>Object.freeze({...run,glyphs:Object.freeze(run.glyphs.map(g=>Object.freeze({...g,rect:shift(g.rect),transform:Object.freeze([g.transform[0],g.transform[1],g.transform[2],g.transform[3],g.transform[4]-dx,g.transform[5]-dy]) as ProductionTextResult['runs'][number]['glyphs'][number]['transform']})))}))),
  lines:Object.freeze(source.lines.map(line=>Object.freeze({...line,rect:shift(line.rect)}))),controls:Object.freeze(controls),presentation:Object.freeze({composition}),
  ...(source.editing?{editing:Object.freeze({...source.editing,carets:Object.freeze(source.editing.carets.map(c=>Object.freeze({...c,rect:shift(c.rect)}))),cells:Object.freeze(source.editing.cells.map(c=>Object.freeze({...c,rect:shift(c.rect)})))})}:{}),
 });
 const clip=model.node.clip?intersect(r,model.node.clip):r;
 return Object.freeze({...model.node,text,clip:Object.freeze(clip),clipShapes:Object.freeze([...(model.node.clipShapes??[]),Object.freeze({rect:r,radii:Object.freeze([0,0,0,0]) as Rect})])});
}
export function replaceGuiTextNodes(frame:ProductionCompositionFrame,nodes:ReadonlyMap<string,GuiTextModel['node']>):ProductionCompositionFrame{
 if(!nodes.size)return frame;return Object.freeze({...frame,layouts:Object.freeze(Object.fromEntries(Object.entries(frame.layouts).map(([part,layout])=>[part,Object.freeze({...layout,nodes:Object.freeze(layout.nodes.map(n=>nodes.get(JSON.stringify([part,n.text?.block,n.instance,n.node]))??n))})])))});
}
function intersect(a:Rect,b:Rect):Rect{const x=Math.max(a[0],b[0]),y=Math.max(a[1],b[1]);return[x,y,Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-x),Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-y)];}
