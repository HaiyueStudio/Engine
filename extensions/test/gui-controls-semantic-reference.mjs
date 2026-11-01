// Independent test projection from an application model. No new composite controller is imported.
import{GuiElement,GuiButton,GuiLabel,GuiModal,GuiScrollView}from'@haiyue/engine/gui';
import{createGuiContainer}from'@haiyue/extensions/gui-layout';
const container=(preset,style)=>createGuiContainer(preset,{style}),style=(icon,position='left',size,gap)=>({icon:icon??null,iconPosition:position,...(size===undefined?{}:{iconSize:size}),...(gap===undefined?{}:{iconGap:gap})});
const button=(text,type,skin={})=>new GuiButton({text,themeControlType:type,style:skin});
export function tabsReference(model){
 const element=container('column',{width:'auto',height:'auto',minWidth:0,minHeight:0}),headers=element.add(container('flow',{width:{percent:100},height:'auto',shrink:0,alignItems:'start',alignContent:'start'})),body=element.add(container('grid',{width:'auto',height:'auto',grow:1,basis:0,minWidth:0,minHeight:0,columns:[{fr:1}],rows:[{fr:1}]}));
 const settings=[];
 for(const p of model.pages){if(p.hidden)continue;const row=headers.add(container('row',{width:76,height:36,shrink:0})),b=row.add(button(p.title,'GuiTab',style(p.icon,p.iconPosition,p.iconSize,p.iconGap)));b.variant=p.id===model.active?'primary':'default';settings.push([b,{width:'auto',height:{percent:100},grow:1,basis:0,minWidth:0}]);if(p.closable){const close=row.add(button('x','GuiTabClose'));settings.push([close,{width:32,height:{percent:100},shrink:0}]);}}
 const active=model.pages.find(p=>p.id===model.active);if(active){const content=body.add(new GuiElement({width:'100%',height:'100%'}));content.add(new GuiLabel({text:active.title+' content',x:12,y:12,width:300,height:28}));}
 return{element,configure(binding){for(const[n,s]of settings)binding.setStyle(n,s);},dispose(){}};
}
class ReferenceMenu extends GuiModal{
 constructor(anchor,items){super({visible:true,width:240,height:items.length*32,showCloseButton:false,showConfirmButton:false,showCancelButton:false,backdropColor:'transparent'});this.anchor=anchor;this.titleLabel.setVisible(false);this.messageLabel.setVisible(false);this.list=this.add(new GuiScrollView({width:'100%',height:'100%',contentHeight:items.length*32,showScrollbar:true}));items.forEach((item,i)=>this.list.add(new GuiButton({x:0,y:i*32,width:'100%',height:32,text:item.label,disabled:!!item.disabled,style:style(item.icon),themeControlType:'GuiBreadcrumbMenuItem'})));}
 layout(viewport){super.layout(viewport);const w=Math.min(240,Math.max(0,viewport.width)),h=Math.min(this.list.contentHeight,Math.max(0,viewport.height)),x=Math.max(viewport.x,Math.min(this.anchor.rect.x,viewport.x+viewport.width-w)),below=this.anchor.rect.y+this.anchor.rect.height;Object.assign(this.dialogRect,{x,y:below+h<=viewport.y+viewport.height?below:Math.max(viewport.y,this.anchor.rect.y-h),width:w,height:h});this.list.layout(this.dialogRect);}
}
export function breadcrumbReference(model){
 const element=container('flow',{width:'auto',height:'auto',minWidth:0,alignItems:'center'}),settings=[];let menuTrigger=null;
 model.items.forEach((p,i)=>{const row=element.add(container('row',{width:'auto',height:32,minWidth:0,maxWidth:{percent:100},alignItems:'center'})),b=row.add(button(p.label,'GuiBreadcrumbItem',{...style(p.icon,p.iconPosition),cursor:p.disabled||p.key===model.current?'default':'pointer'}));b.setDisabled(!!p.disabled||p.key===model.current);settings.push([b,{width:'auto',height:32,minWidth:0,shrink:1}]);if(p.menu?.length){const trigger=row.add(button('v','GuiBreadcrumbMenuTrigger'));trigger.setDisabled(!!p.disabled);settings.push([trigger,{width:28,height:32,shrink:0}]);if(p.key===model.open)menuTrigger=trigger;}const sep=row.add(new GuiLabel({text:i===model.items.length-1?'':p.separator??model.separator??'/',autoWidth:true,themeControlType:'GuiBreadcrumbSeparator'}));sep.setVisible(i!==model.items.length-1);settings.push([sep,{width:'auto',height:32,shrink:0,margin:{left:4,right:4}}]);});
 return{element,configure(binding){for(const[n,s]of settings)binding.setStyle(n,s);},afterLayout(root,focus){if(menuTrigger){const popup=root.add(new ReferenceMenu(menuTrigger,model.items.find(p=>p.key===model.open).menu));focus.reconcile();focus.focus(popup.list.children.find(c=>!c.disabled)??null);}},dispose(){}};
}
const badgeColors={default:'#64748b',processing:'#2563eb',success:'#16a34a',warning:'#d97706',error:'#dc2626'};
export function badgesReference(model){
 const element=new GuiElement({width:'100%',height:'100%'}),settings=[];
 model.badges.forEach((s,i)=>{
  const host=element.add(new GuiElement({x:20+i%8*116,y:20+Math.floor(i/8)*48,width:108,height:32})),wrap=host.add(container('row',{width:'auto',height:'auto',alignItems:'center'}));settings.push([wrap,{width:108,height:32}]);
  if(s.attached!==false)wrap.add(new GuiButton({width:100,height:32,text:'Item '+i}));
  const variant=s.variant??'count',isCount=variant==='count',isStatus=variant==='status',value=s.value??0,show=!isCount||value!==0||s.showZero===true,shownText=isCount?typeof value==='number'&&value>(s.overflowCount??99)?(s.overflowCount??99)+'+':String(value):'';
  const decoration=wrap.add(container('row',{width:'auto',height:20,alignItems:'center',columnGap:6}));decoration.setVisible(show);
  const count=decoration.add(new GuiLabel({text:shownText,autoWidth:isCount,textAlign:'center',themeControlType:'GuiBadge',style:{fontSize:12,padding:isCount?4:0,radius:isCount?10:4,color:'#ffffff',backgroundColor:isCount?badgeColors.error:badgeColors[s.status??'default'],...s.style}}));
  const label=decoration.add(new GuiLabel({text:isStatus?s.statusText??'':'',autoWidth:true,themeControlType:'GuiBadgeStatusText'}));label.setVisible(isStatus&&!!s.statusText);settings.push([count,{width:isCount?'auto':8,height:isCount?20:8,minWidth:isCount?20:8,shrink:0}]);
  const[x,y]=s.offset??[0,0],placement=s.placement??'top-right';settings.push([decoration,s.attached!==false?{position:'absolute',width:'auto',height:20,inset:{...(placement.endsWith('left')?{left:x}:{right:-x}),...(placement.startsWith('top')?{top:y}:{bottom:-y})}}:{width:'auto',height:20,margin:{left:x,top:y}}]);
 });
 return{element,configure(binding){for(const[n,s]of settings)binding.setStyle(n,s);},dispose(){}};
}
export function collapseReference(model){
 const element=container('column',{width:'auto',height:'auto',minWidth:0}),settings=[];
 model.items.forEach(p=>{
  const open=model.expanded.includes(p.key),section=element.add(container('column',{width:{percent:100},height:36+(open?32:0),minWidth:0,shrink:0})),head=section.add(container('row',{width:{percent:100},height:36,minWidth:0,shrink:0,alignItems:'center'})),body=section.add(container('column',{width:{percent:100},height:open?32:0,minWidth:0,shrink:0,display:open?'flex':'none'}));body.setVisible(open);
  const title=button(p.title,'GuiCollapseHeader',style(p.icon,p.iconPosition)),arrow=button(open?'v':'>','GuiCollapseToggle');title.setDisabled(!!p.disabled);arrow.setDisabled(!!p.disabled);for(const b of model.indicator==='right'?[title,arrow]:[arrow,title])head.add(b);settings.push([title,{width:'auto',height:36,minWidth:0,grow:1,basis:0}],[arrow,{width:32,height:36,shrink:0}]);
  if(p.extra)head.add(new GuiButton({text:'Extra',width:64,height:28}));const content=body.add(new GuiElement({width:'100%',height:32}));content.add(new GuiLabel({text:p.title+' content',x:12,y:2,width:300,height:28}));
 });
 return{element,configure(binding){for(const[n,s]of settings)binding.setStyle(n,s);},dispose(){}};
}
