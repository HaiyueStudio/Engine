import {GuiElement,GuiModal,GuiDirtyFlags} from '@haiyue/engine/gui';
import type {GuiRect,GuiPointerEvent} from '@haiyue/engine/gui';
import {surface,within,number,choice,fail} from '../gui-common/composite.js';
import {ownContentFrame} from '../gui-layout/presets.js';
import {GuiCleanup} from '../gui-layout/panel-cleanup.js';
import {LayoutError} from '../layout.js';
import type {GuiOverlayOptions,GuiOverlayCloseReason} from './types.js';
import {hoveredWithin} from '../gui-common/hover.js';

/** Validate before a derived popup constructs or borrows any content. */
export function validateOverlayTrigger<T extends GuiOverlayOptions>(options:T,mode:'click'|'hover'|'manual'):T {
  choice(mode,['click','hover','manual'],'overlay trigger');
  if(mode!=='manual'&&!options?.anchor)fail('Automatic popup triggers require an anchor.');
  return options;
}

type RectFor=(element:GuiElement)=>GuiRect;
type Geometry=(viewport:GuiRect,rectFor:RectFor)=>GuiRect;
type Mode={kind:'popup'|'dialog'|'drawer';side?:'left'|'right'|'top'|'bottom'};
class OverlayHost extends GuiModal {
  readonly panels=new Map<GuiElement,Geometry>();
  constructor(options:GuiOverlayOptions,private readonly geometry:Geometry,private readonly requestClose:(reason:GuiOverlayCloseReason)=>void){
    super({visible:false,width:options.width??280,height:options.height??200,showCloseButton:false,showConfirmButton:false,showCancelButton:false,closeOnBackdrop:options.closeOnOutside??true,backdropColor:'transparent',style:options.style,themeControlType:'GuiOverlay'});
    this.titleLabel.setVisible(false);this.messageLabel.setVisible(false);
  }
  override getDialogRect(viewport:GuiRect,rectFor:RectFor=element=>element.rect):GuiRect {return this.geometry(viewport,rectFor);}
  override getContentLayoutRect(child:GuiElement,viewport:GuiRect,rectFor:RectFor=element=>element.rect):GuiRect {return (this.panels.get(child)??this.geometry)(viewport,rectFor);}
  override layout(viewport:GuiRect):void {super.layout(viewport);for(const [panel,geometry]of this.panels)panel.layout(geometry(viewport,e=>e.rect));}
  override close(reason:'close'|'confirm'|'cancel'|'backdrop'='close'):void {this.requestClose(reason==='backdrop'?'outside':reason==='cancel'?'escape':reason);}
}
/** One modal host may contain several menu panels. GuiFocusManager remains the only focus stack. */
export class OverlayController {
  readonly element:GuiElement;readonly panel:GuiElement;
  private readonly host:OverlayHost;
  private readonly releases:(()=>void)[]=[];
  private readonly children=new Set<OverlayController>();
  private opened=false;private dead=false;private point:Readonly<{x:number;y:number}>|undefined;
  private rootOff:()=>void=()=>{};private hoverOff:()=>void=()=>{};
  private hoverTrigger=false;private hoverClosing=false;
  private readonly geometry:Geometry;
  constructor(protected readonly options:GuiOverlayOptions,content:GuiElement,mode:Mode={kind:'popup'},private readonly parentOverlay?:OverlayController){
    if(!options?.root||options.root.destroyed||!options.focusManager)fail('Overlays borrow a live GUI root and its existing focus manager.');
    number(options.width??280,'overlay width',1,8192);number(options.height??200,'overlay height',1,8192);
    choice(options.placement??'bottom',['top','right','bottom','left'],'overlay placement');choice(options.align??'start',['start','center','end'],'overlay alignment');
    if(!(content instanceof GuiElement)||content.parent)fail('Overlay content must be an unattached borrowed element.');
    if(options.anchor!==undefined&&!(options.anchor instanceof GuiElement))fail('Overlay anchor must be a GUI element.');
    this.geometry=(viewport,rectFor)=>{
      const margin=mode.kind==='drawer'?0:8,width=Math.min(options.width??280,Math.max(0,viewport.width-margin*2)),height=Math.min(options.height??200,Math.max(0,viewport.height-margin*2));
      if(mode.kind==='dialog')return{x:viewport.x+(viewport.width-width)/2,y:viewport.y+(viewport.height-height)/2,width,height};
      if(mode.kind==='drawer'){const side=mode.side??'right',horizontal=side==='left'||side==='right';return{x:viewport.x+(side==='right'?viewport.width-width:0),y:viewport.y+(side==='bottom'?viewport.height-height:0),width:horizontal?width:viewport.width,height:horizontal?viewport.height:height};}
      const anchor=options.anchor??options.root.root,rect=this.point?{x:this.point.x,y:this.point.y,width:0,height:0}:rectFor(anchor);
      return anchor.getPopupRect({width,height},{anchor:rect,viewport,placement:options.placement??'bottom',align:options.align??'start',gap:this.point?0:6,margin:8});
    };
    const shared=parentOverlay!==undefined;
    this.host=parentOverlay?.host??new OverlayHost(options,this.geometry,reason=>{if(reason==='escape'&&options.closeOnEscape===false)return;this.close(reason);});
    this.panel=surface('GuiOverlayPanel',{direction:'column',width:{percent:100},height:{percent:100},minWidth:0,minHeight:0,padding:{left:12,right:12,top:12,bottom:12},rowGap:8},{pointerFilter:'stop',...(shared&&options.style?{style:options.style}:{})},shared?theme=>({backgroundColor:theme.colors.elevated??theme.colors.surface,borderColor:theme.colors.border,borderWidth:1,radius:8,shadow:{color:theme.colors.shadow??'#0004',blur:14,y:5}}):undefined);
    this.element=shared?this.panel:this.host;
    if(!shared&&mode.kind!=='popup')this.host.backdropColor=options.root.theme.colors.overlay??'#0006';
    try{this.releases.push(ownContentFrame(content,{width:'auto',height:'auto',grow:1,basis:0,minWidth:0,minHeight:0}));
      this.releases.push(()=>{if(content.parent===this.panel)this.panel.remove(content);});
      this.panel.add(content);this.releases.push(this.element.bindPart('content',content));if(!shared){this.host.add(this.panel);this.host.panels.set(this.panel,this.geometry);this.releases.push(this.host.bindPart('panel',this.panel));}
      const off=options.root.onDispose(()=>this.dispose());if(this.dead){off();fail('GUI root was disposed during overlay construction.');}this.releases.push(off);
    }catch(error){const cleanup=new GuiCleanup();cleanup.run(()=>this.dispose());cleanup.complete('GUI overlay construction failed.',{cause:error});}
  }
  get isOpen():boolean{return this.opened;}
  protected alive():void {if(this.dead)throw new LayoutError('disposed','GUI overlay is disposed.');}
  openAt(point?:Readonly<{x:number;y:number}>):boolean {if(point){number(point.x,'popup x',-1e7,1e7);number(point.y,'popup y',-1e7,1e7);}this.point=point?{...point}:undefined;return this.open();}
  open():boolean {
    this.alive();const anchor=this.options.anchor;if(anchor&&(!within(anchor,this.options.root.root)||!anchor.isEffectivelyVisible()))return false;
    if(this.opened)return true;if(this.parentOverlay&&!this.parentOverlay.isOpen)return false;this.opened=true;
    if(this.parentOverlay){this.parentOverlay.children.add(this);this.host.panels.set(this.panel,this.geometry);this.host.add(this.panel);}else {this.options.root.add(this.host);this.host.show();}
    this.panel.setVisible(true);this.host.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Visual);this.options.focusManager.reconcile();
    this.rootOff=this.options.root.onInvalidation(change=>{if(!this.opened)return;if(anchor&&(!within(anchor,this.options.root.root)||!anchor.isEffectivelyVisible()))this.close('anchor-hidden');else if(this.hoverTrigger&&change.reasons.some(reason=>reason==='input'||reason==='layout'))this.reconcileHover();});
    this.reconcileHover();
    this.options.onOpenChange?.(true,'trigger');return true;
  }
  setOpen(value:boolean):void {if(typeof value!=='boolean')throw new TypeError('Invalid overlay state.');if(value)this.open();else this.close('trigger');}
  close(reason:GuiOverlayCloseReason='close'):void {
    if(!this.opened)return;this.opened=false;const cleanup=new GuiCleanup();
    for(const child of [...this.children].reverse())cleanup.run(()=>child.close(reason));this.children.clear();
    const focused=within(this.options.focusManager.focused,this.panel);if(focused)cleanup.run(()=>this.options.focusManager.blur());
    cleanup.run(this.rootOff);this.rootOff=()=>{};cleanup.run(()=>this.cancelHoverClose());
    if(this.parentOverlay){this.parentOverlay.children.delete(this);this.host.panels.delete(this.panel);cleanup.run(()=>this.host.remove(this.panel));cleanup.run(()=>this.host.markDirty(GuiDirtyFlags.Layout));}
    else {cleanup.run(()=>this.host.hide());cleanup.run(()=>this.host.parent?.remove(this.host));}
    cleanup.run(()=>this.options.focusManager.reconcile());if(focused&&this.parentOverlay?.isOpen&&this.options.anchor)cleanup.run(()=>this.options.focusManager.focus(this.options.anchor!));
    cleanup.run(()=>this.options.onOpenChange?.(false,reason));cleanup.complete('GUI overlay close failed.');
  }
  protected bindTrigger(mode:'click'|'hover'|'manual'):void {
    const acquired:(()=>void)[]=[];
    try{
      this.alive();validateOverlayTrigger(this.options,mode);this.hoverTrigger=mode==='hover';const anchor=this.options.anchor;if(mode==='manual')return;
      const click=()=>{if(!this.dead)this.setOpen(!this.opened);};
      const enter=(event:{detail:GuiPointerEvent})=>{if(event.detail.nativeEvent?.pointerType!=='touch'&&!this.dead)this.open();};
      const leave=(event:{detail:GuiPointerEvent})=>{if(event.detail.nativeEvent?.pointerType!=='touch')this.reconcileHover();};
      if(mode==='click'){acquired.push(()=>anchor!.off('click',click));anchor!.on('click',click);}
      else {acquired.push(()=>anchor!.off('pointerenter',enter));anchor!.on('pointerenter',enter);acquired.push(()=>anchor!.off('pointerleave',leave));anchor!.on('pointerleave',leave);}
      this.alive();this.releases.push(...acquired);
    }catch(error){const cleanup=new GuiCleanup();for(const off of acquired.reverse())cleanup.run(off);cleanup.run(()=>this.dispose());cleanup.complete('GUI overlay trigger construction failed.',{cause:error});}
  }
  private hasHoveredRegion():boolean {return !!this.options.anchor&&hoveredWithin(this.options.anchor)||hoveredWithin(this.panel)||[...this.children].some(child=>child.isOpen&&child.hasHoveredRegion());}
  private cancelHoverClose():void {const off=this.hoverOff;this.hoverOff=()=>{};this.hoverClosing=false;off();}
  private reconcileHover():void {
    if(this.dead||!this.opened||!this.hoverTrigger)return;
    if(this.hasHoveredRegion()){this.cancelHoverClose();return;}
    if(this.hoverClosing)return;this.hoverClosing=true;let elapsed=0;
    const off=this.panel.setActivity(delta=>{if(this.dead||!this.opened||this.hasHoveredRegion()){this.cancelHoverClose();return false;}elapsed+=delta;if(elapsed>=120){this.close('trigger');return false;}},{motion:false});
    if(this.dead||!this.opened||!this.hoverClosing)off();else this.hoverOff=off;
  }
  protected releaseWith(release:()=>void):void{this.releases.push(release);}
  dispose():void {
    if(this.dead)return;this.dead=true;const children=[...this.children],cleanup=new GuiCleanup();cleanup.run(()=>this.close('disposed'));for(const child of children)cleanup.run(()=>child.dispose());this.children.clear();
    for(const off of this.releases.splice(0).reverse())cleanup.run(off);cleanup.run(()=>this.panel.setActivity(null));cleanup.run(()=>this.panel.removeAllListeners());cleanup.complete('GUI overlay disposal failed.');
  }
}
