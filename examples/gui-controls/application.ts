import{HaiyueEngine}from'@haiyue/engine';
import{Entity}from'@haiyue/engine/ecs';
import{GuiRoot,GuiElement,GuiLabel,GuiButton,GuiInput,GuiScrollView,GuiSystem,GuiThemeResource}from'@haiyue/engine/gui';
import type{GuiFocusManager}from'@haiyue/engine/gui';
import{GuiBreadcrumb,GuiBadge,GuiCollapse}from'@haiyue/extensions/gui-controls';
import{GuiTabContainer,createGuiContainer,attachGuiLayout}from'@haiyue/extensions/gui-layout';
import{createGuiVirtualList}from'@haiyue/extensions/gui-collections';

/** Shared application assembly, also called by the installed-package native reference fixture. */
export function createGuiControlsContent(root:GuiRoot,focus:GuiFocusManager){
 const makeIcon=(color:string)=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=20;const draw=canvas.getContext('2d')!;draw.fillStyle=color;draw.fillRect(0,0,32,20);draw.fillStyle='#ffffff';draw.fillRect(5,5,8,10);draw.fillRect(19,5,8,10);return canvas;};
 const icons=[makeIcon('#2563eb'),makeIcon('#d97706')];
 root.add(new GuiElement({width:'100%',height:'100%',pointerFilter:'ignore',style:{backgroundColor:'#07111e'}}));
 const status=root.add(new GuiLabel({id:'g10-status',x:20,y:655,width:920,height:28,text:'Choose a tab, follow a breadcrumb, or open a panel.'}));
 root.add(new GuiLabel({x:20,y:8,width:920,height:36,text:'GUI CONTROLS',fontSize:24}));
 const theme=new GuiThemeResource({normal:{fontSize:14},controls:{GuiTab:{normal:{iconGap:6}},GuiBreadcrumbItem:{normal:{backgroundColor:'transparent',borderColor:'transparent'}},GuiCollapseHeader:{normal:{backgroundColor:'#1e293b'}}}});
 let themeSubscriptions=0;
 const themeBinding={get version(){return theme.version;},resolve:(...args:Parameters<GuiThemeResource['resolve']>)=>theme.resolve(...args),subscribe(changed:()=>void){themeSubscriptions++;const off=theme.subscribe(changed);let live=true;return()=>{if(!live)return;live=false;themeSubscriptions--;off();};}};root.setThemeResource(themeBinding);
 const breadcrumb=new GuiBreadcrumb({focus,items:Array.from({length:8},(_,i)=>({key:'path-'+i,label:i===0?'Home':'Level '+i,...(i%3===0?{icon:icons[i%2]!,iconPosition:i%2?'right' as const:'left' as const}:{}),...(i===1?{menu:[{key:'path-menu-a',label:'Gallery',icon:icons[0]!},{key:'path-menu-b',label:'Archive'},{key:'path-menu-c',label:'Unavailable',disabled:true}]}:{}),disabled:i===5})),onNavigate:key=>status.setText('Navigate: '+key)});
 const breadHost=root.add(new GuiElement({x:20,y:54,width:920,height:64,pointerFilter:'ignore'}));breadHost.add(breadcrumb.element);
 const badges:GuiBadge[]=[],buttons:GuiButton[]=[];let badgeClicks=0;
 for(let i=0;i<32;i++){
  const button=new GuiButton({width:104,height:28,text:'Item '+(i+1),onClick:()=>{badgeClicks++;status.setText('Badge button '+(i+1)+': '+badgeClicks+' clicks');}}),badge=new GuiBadge({...(i===4?{}:{content:button}),value:i===0?0:i===1?99:i===2?100:i,...(i===3?{variant:'dot' as const}:{}),...(i===4?{variant:'status' as const,status:'success' as const,statusText:'Saved'}:{})});
  const host=root.add(new GuiElement({x:20+(i%8)*116,y:132+Math.floor(i/8)*40,width:108,height:28,pointerFilter:'ignore'}));host.add(badge.element);badges.push(badge);buttons.push(button);
 }
 const input=new GuiInput({id:'g10-retained-input',x:12,y:10,width:260,height:32,value:'Retained text'});
 const rowCounts={created:0,disposed:0,bound:0,unbound:0},items=Array.from({length:1000},(_,i)=>({key:'row-'+i,label:'Stable row '+i}));
 const list=createGuiVirtualList({items,keyOf:i=>i.key,rowHeight:28,height:140,focus,createRow(){rowCounts.created++;const element=new GuiButton({width:'100%',height:28,text:''});return{element,bind(item){rowCounts.bound++;element.setText(item.label);return()=>{rowCounts.unbound++;};},dispose(){rowCounts.disposed++;element.removeAllListeners();}};}});
 const contents=Array.from({length:16},(_,i)=>{const content=new GuiElement({width:'100%',height:i===1?140:64});if(i===0)content.add(input);else if(i===1)content.add(list.element);else content.add(new GuiLabel({x:12,y:12,width:600,height:28,text:'Panel '+(i+1)+' keeps its content while closed.'}));return content;});
 const extra=new GuiButton({width:76,height:28,text:'Reset',onClick:()=>input.setValue('Retained text')});
 const collapse=new GuiCollapse({focus,items:contents.map((content,i)=>({key:'panel-'+i,title:'Panel '+(i+1),content,disabled:i===15,...(i%3===0?{icon:icons[i%2]!,iconPosition:i%2?'right' as const:'left' as const}:{}),...(i===0?{extra}:{})})),expandedKeys:['panel-0'],onExpandChange:keys=>status.setText('Open panels: '+(keys.join(', ')||'none'))});
 const scroll=new GuiScrollView({width:'100%',height:'100%',contentHeight:0,showScrollbar:true});scroll.add(collapse.element);
 const pages=Array.from({length:12},(_,i)=>({id:'tab-'+i,title:'Tab '+(i+1),content:i===0?scroll:createGuiContainer('column',{style:{padding:{left:16,top:16}}}),closable:i===11,...(i%3!==2?{icon:icons[i%2]!,iconPosition:i%2?'right' as const:'left' as const,iconSize:16}: {})}));
 for(let i=1;i<pages.length;i++)pages[i]!.content.add(new GuiLabel({text:'Content for tab '+(i+1),width:500,height:32}));
 const tabs=new GuiTabContainer({id:'g10-tabs',focus,pages,tabWidth:92,tabHeight:36,onActiveChange:key=>status.setText('Active: '+key)});
 const tabsHost=root.add(new GuiElement({x:20,y:310,width:920,height:330,pointerFilter:'ignore'}));tabsHost.add(tabs.element);
 const layout=attachGuiLayout(root);layout.setStyle(breadcrumb.element,{width:920,height:64});layout.setStyle(tabs.element,{width:920,height:330});layout.setStyle(scroll,{direction:'column'});for(const badge of badges)layout.setStyle(badge.element,{width:108,height:28});
 let dead=false;const dispose=()=>{if(dead)return;dead=true;breadcrumb.dispose();tabs.dispose();collapse.dispose();for(const badge of badges)badge.dispose();list.dispose();layout.dispose();root.setThemeResource(null);theme.dispose();};
 return{breadcrumb,badges,buttons,tabs,collapse,input,list,items,rowCounts,icons,contents,theme,layout,status,get badgeClicks(){return badgeClicks;},get themeSubscriptions(){return themeSubscriptions;},dispose};
}

export async function createGuiControlsExample(canvas:HTMLCanvasElement,msaaSamples:1|4=1){
 const engine=new HaiyueEngine({canvas,msaaSamples,timestampQuery:false,diagnostics:{enabled:true},clearColor:{r:.025,g:.035,b:.055,a:1}});await engine.init();
 try{const scene=engine.createScene({name:'GUI composite controls',camera:{type:'2d',camera2D:{designWidth:960,designHeight:700,viewportMode:'fixed'}},render2D:false,render3D:false,gui:false}),root=new GuiRoot(),gui=new GuiSystem(engine,{roots:new Set([root]),textInputHost:'browser'});scene.add(new Entity('Controls').addComponent(root));scene.addSystem(gui);
  const content=createGuiControlsContent(root,gui.focus);let dead=false;const dispose=()=>{if(dead)return;dead=true;try{content.dispose();}finally{scene.destroy();engine.destroy();}};engine.switchScene(scene).run();return{engine,scene,gui,root,...content,get badgeClicks(){return content.badgeClicks;},get themeSubscriptions(){return content.themeSubscriptions;},dispose};
 }catch(error){engine.destroy();throw error;}
}

