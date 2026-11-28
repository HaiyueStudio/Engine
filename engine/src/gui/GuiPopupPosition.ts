import type {GuiRect} from './GuiTypes';
export interface GuiPopupPositionOptions {readonly placement?:'top'|'right'|'bottom'|'left';readonly align?:'start'|'center'|'end';readonly gap?:number;readonly margin?:number;readonly viewport?:GuiRect;readonly anchor?:GuiRect;readonly flip?:boolean;readonly shift?:boolean;}
export function positionGuiPopup(anchor:GuiRect,size:Readonly<{width:number;height:number}>,viewport:GuiRect,options:GuiPopupPositionOptions={}):GuiRect {
  const gap=options.gap??8,margin=options.margin??4,side=options.placement??'bottom',align=options.align??'center';
  if(!['top','right','bottom','left'].includes(side)||!['start','center','end'].includes(align)||![gap,margin,size.width,size.height,viewport.x,viewport.y,viewport.width,viewport.height].every(Number.isFinite)||size.width<0||size.height<0||gap<0||margin<0)throw new RangeError('Invalid GUI popup geometry.');
  const width=Math.min(size.width,Math.max(0,viewport.width-margin*2)),height=Math.min(size.height,Math.max(0,viewport.height-margin*2));
  const at=(s:string):GuiRect=>{const horizontal=s==='top'||s==='bottom',offset=align==='start'?0:align==='end'?(horizontal?anchor.width-width:anchor.height-height):(horizontal?anchor.width-width:anchor.height-height)/2;return {x:horizontal?anchor.x+offset:s==='left'?anchor.x-width-gap:anchor.x+anchor.width+gap,y:horizontal?s==='top'?anchor.y-height-gap:anchor.y+anchor.height+gap:anchor.y+offset,width,height};};
  let r=at(side);const overflow=(r:GuiRect)=>Math.max(0,viewport.x+margin-r.x)+Math.max(0,r.x+r.width-viewport.x-viewport.width+margin)+Math.max(0,viewport.y+margin-r.y)+Math.max(0,r.y+r.height-viewport.y-viewport.height+margin);
  if(options.flip!==false){const other=at({top:'bottom',bottom:'top',left:'right',right:'left'}[side]);if(overflow(other)<overflow(r))r=other;}
  if(options.shift!==false){r.x=Math.max(viewport.x+margin,Math.min(r.x,viewport.x+viewport.width-margin-width));r.y=Math.max(viewport.y+margin,Math.min(r.y,viewport.y+viewport.height-margin-height));}
  return r;
}
