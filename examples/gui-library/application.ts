import {HaiyueEngine} from '@haiyue/engine';
import {Entity} from '@haiyue/engine/ecs';
import {GuiRoot,GuiElement,GuiLabel,GuiButton,GuiInput,GuiProgress,GuiSlider,GuiSystem,GuiThemeResource,GuiScrollView} from '@haiyue/engine/gui';
import type {GuiFocusManager} from '@haiyue/engine/gui';
import {attachGuiLayout,createGuiContainer,GuiTabContainer,GuiSplitPanel} from '@haiyue/extensions/gui-layout';
import {GuiCard,GuiDivider,GuiTag,GuiAvatar,GuiImageView,GuiAlert,GuiEmpty,GuiSpin,GuiSkeleton,GuiButtonGroup,GuiSegmented} from '@haiyue/extensions/gui-display';
import {GuiMenu,GuiDropdown,GuiContextMenu,GuiPopover,GuiPopconfirm,GuiDialog,GuiDrawer,GuiNotificationCenter} from '@haiyue/extensions/gui-overlays';
import {GuiBreadcrumb,GuiBadge,GuiCollapse,GuiExpandable} from '@haiyue/extensions/gui-controls';
import {createGuiVirtualList,createGuiVirtualTree} from '@haiyue/extensions/gui-collections';

/** Public-package composition; consumers keep their own style, content and focus domain. */
export function createGuiLibraryContent(root:GuiRoot,focus:GuiFocusManager){
  const owned:{dispose():void}[]=[],own=<T extends {dispose():void}>(value:T):T=>{owned.push(value);return value;};
  const frames:{node:GuiElement;width:number;height:number}[]=[];
  const mount=(node:GuiElement,x:number,y:number,width:number,height:number)=>{const host=root.add(new GuiElement({x,y,width,height,pointerFilter:'ignore'}));host.add(node);frames.push({node,width,height});return host;};
  const label=(text:string,width=320,height=28)=>new GuiLabel({text,width,height,style:{textOverflow:'ellipsis'}});
  const column=(...children:GuiElement[])=>{const node=createGuiContainer('column',{style:{rowGap:10,width:'auto',minWidth:0}});for(const child of children)node.add(child);return node;};
  const row=(...children:GuiElement[])=>{const node=createGuiContainer('row',{style:{columnGap:8,alignItems:'center',height:36}});for(const child of children)node.add(child);return node;};
  root.add(new GuiElement({width:1200,height:1010,pointerFilter:'ignore'})).setDefaultSkin(theme=>({backgroundColor:theme.colors.background}));
  const status=root.add(new GuiLabel({id:'library-status',x:24,y:972,width:1152,height:24,text:'Ready · keyboard, mouse and gamepad share the GUI input domain.'}));
  const update=(message:string)=>status.setText(message);
  root.add(new GuiLabel({x:24,y:18,width:780,height:40,text:'GUI Library',fontSize:28,style:{fontWeight:600}}));
  root.add(new GuiLabel({x:24,y:61,width:840,height:28,text:'Composable surfaces · semantic themes · your styles and content'}));
  const themeButton=root.add(new GuiButton({id:'library-theme',x:1016,y:24,width:160,text:'Switch theme'}));
  let light=root.theme.colors.background===GuiThemeResource.createTheme('light').colors.background;themeButton.on('click',()=>{light=!light;root.theme=GuiThemeResource.createTheme(light?'light':'dark');update(light?'Light theme':'Dark theme');});
  const crumb=own(new GuiBreadcrumb({focus,items:[{key:'home',label:'Workspace'},{key:'library',label:'Components',menu:[{key:'surfaces',label:'Surfaces'},{key:'navigation',label:'Navigation'}]},{key:'current',label:'Gallery'}],onNavigate:key=>update(key)}));mount(crumb.element,24,101,720,36);
  const icon=document.createElement('canvas');icon.width=96;icon.height=64;const ctx=icon.getContext('2d')!;ctx.fillStyle='#6e64d9';ctx.fillRect(0,0,96,64);ctx.fillStyle='#f3c980';ctx.beginPath();ctx.arc(25,24,13,0,Math.PI*2);ctx.fill();ctx.fillStyle='#3ab9a3';ctx.fillRect(44,18,42,40);
  const tag=own(new GuiTag({root,text:'Published',status:'success',closable:true})),avatar=own(new GuiAvatar({root,label:'Hai Yue',size:40}));
  const badge=own(new GuiBadge({value:8,content:new GuiButton({text:'Inbox',width:100})}));
  const divider=own(new GuiDivider({text:'Project',textAlign:'start'}));
  const name=new GuiInput({id:'library-input',width:300,value:'A retained editor',clearable:true});
  const card=own(new GuiCard({root,focusManager:focus,pointerFilter:'pass',width:368,height:230,title:'Your workspace',hoverable:true,extra:new GuiButton({text:'Edit',width:62,variant:'text'}),content:column(row(avatar.element,tag.element,badge.element),divider.element,name),footer:label('Borrowed content stays yours',320,22)}));mount(card.element,24,153,368,230);
  const warning=own(new GuiAlert({root,title:'A small update is available',description:'Semantic colors follow the current theme.',status:'info',closable:true}));mount(warning.element,412,153,368,94);
  const selected=own(new GuiSegmented({root,focusManager:focus,width:368,items:[{key:'day',label:'Day'},{key:'week',label:'Week'},{key:'month',label:'Month',disabled:true}],selectedKey:'week',onSelect:key=>update('Period: '+key)}));mount(selected.element,412,263,368,40);
  const group=own(new GuiButtonGroup({root,focusManager:focus,width:368,items:[{key:'cut',label:'Cut'},{key:'copy',label:'Copy'},{key:'paste',label:'Paste'}],onSelect:key=>update(key)}));mount(group.element,412,319,368,36);
  const image=own(new GuiImageView({root,source:icon,fit:'cover',width:174,height:112})),emptyImage=own(new GuiImageView({root,width:174,height:112,placeholder:'No image'}));mount(image.element,804,153,174,112);mount(emptyImage.element,994,153,174,112);
  const custom=own(new GuiTag({root,text:'Custom skin',width:174,height:32,style:{backgroundColor:'#8b4d2e',color:'#fff2df',radius:12,parts:{label:{color:'#fff2df'}}}}));mount(custom.element,804,289,174,32);
  root.add(new GuiProgress({x:998,y:281,width:74,height:74,variant:'circle',value:72,status:'success',showText:true}));root.add(new GuiProgress({x:1086,y:281,width:74,height:74,variant:'circle',value:34,status:'exception',showText:true}));
  root.add(new GuiSlider({id:'library-slider',x:804,y:350,width:356,height:44,range:[20,70],marks:[{value:0,label:'0'},{value:50,label:'50'},{value:100,label:'100'}],tooltip:'hover',onRangeChange:value=>update('Range: '+value.join(' – '))}));
  const skeleton=own(new GuiSkeleton({root,width:170,height:132,rows:3,animated:false})),spin=own(new GuiSpin({root,width:154,height:132,label:'Loading',size:28}));
  const empty=own(new GuiEmpty({root,width:340,height:132,description:'No files yet',action:new GuiButton({text:'Create file',width:120})}));
  mount(skeleton.element,24,415,170,132);mount(spin.element,206,415,170,132);mount(empty.element,412,415,368,132);
  const expand=own(new GuiExpandable({title:'A lightweight detail',content:label('One Collapse implementation',300,32),expanded:true}));mount(expand.element,804,420,364,112);
  const collapse=own(new GuiCollapse({focus,variant:'bordered',items:[{key:'a',title:'Details',content:label('The original layout and editor owners',320,44)},{key:'b',title:'More information',content:label('Part styles remain independently configurable',320,44)}],expandedKeys:['a']}));
  const tabs=own(new GuiTabContainer({focus,variant:'line',pages:[{id:'overview',title:'Overview',icon,content:collapse.element},{id:'files',title:'Files',icon,iconPosition:'right',content:label('Stable page ownership',320,80)}],tabWidth:132}));mount(tabs.element,24,570,368,194);
  const rows=Array.from({length:1000},(_,i)=>({key:'row-'+i,text:'Item '+i}));
  const list=own(createGuiVirtualList({items:rows,keyOf:item=>item.key,rowHeight:32,height:156,focus,createRow(){const input=new GuiInput({width:'100%',height:32});return{element:input,bind(item){input.setValue(item.text);input.onChange=value=>{item.text=value;};return()=>{input.onChange=null;};},dispose(){input.removeAllListeners();}};}}));mount(list.element,412,606,176,156);root.add(new GuiLabel({x:412,y:571,width:180,height:28,text:'Virtual list · 1,000'}));
  const tree=own(createGuiVirtualTree({nodes:[{key:'group',value:'Components',children:[{key:'card',value:'Card'},{key:'input',value:'Input'},{key:'menu',value:'Menu'}]}],expandedKeys:['group'],rowHeight:32,height:156,focus,createRow(){const button=new GuiButton({height:32});return{element:button,bind(node){button.setText(node.value);return()=>{};},dispose(){button.removeAllListeners();}};}}));mount(tree.element,604,606,176,156);root.add(new GuiLabel({x:604,y:571,width:180,height:28,text:'Virtual tree'}));
  const split=own(new GuiSplitPanel({axis:'horizontal',ratio:.5,first:label('Resizable',130,100),second:label('Panels',130,100)}));mount(split.element,804,570,364,112);
  const standalone=own(new GuiMenu({root,focusManager:focus,items:[{key:'recent',label:'Recent files'},{key:'disabled',label:'Unavailable',disabled:true}],onSelect:key=>update(key)}));mount(standalone.element,804,702,364,84);
  const actions:Record<string,GuiButton>={},button=(key:string,title:string,index:number)=>actions[key]=root.add(new GuiButton({id:'library-'+key,x:24+index*164,y:818,width:150,height:38,text:title}));
  const menu=own(new GuiDropdown({root,focusManager:focus,anchor:button('menu','Open menu',0),width:224,height:160,items:[{key:'new',label:'New file',shortcut:'Ctrl+N'},{key:'more',label:'More',children:[{key:'export',label:'Export'},{key:'archive',label:'Archive'}]},{key:'delete',label:'Delete',danger:true}],onSelect:key=>update('Menu: '+key)}));
  const popover=own(new GuiPopover({root,focusManager:focus,anchor:button('popover','Popover',1),width:260,height:124,content:column(label('Keep your own content',230),new GuiInput({width:222,value:'Editable popover'}))}));
  const confirm=own(new GuiPopconfirm({root,focusManager:focus,anchor:button('confirm','Popconfirm',2),width:292,height:150,title:'Remove this file?',description:'The action can be cancelled.',onConfirm:()=>update('Confirmed')}));actions.confirm!.on('click',()=>confirm.open());
  const dialog=own(new GuiDialog({root,focusManager:focus,width:440,height:248,title:'A composed dialog',content:column(label('Title, body and actions follow your theme',390),new GuiInput({width:360,value:'Dialog editor'})),onConfirm:()=>update('Dialog confirmed')}));button('dialog','Dialog',3).on('click',()=>dialog.open());
  const drawer=own(new GuiDrawer({root,focusManager:focus,width:350,height:400,title:'Project settings',content:column(label('A drawer uses the same modal owner',300),new GuiInput({width:286,value:'Untitled project'}))}));button('drawer','Drawer',4).on('click',()=>drawer.open());
  const notices=own(new GuiNotificationCenter({root,focusManager:focus,maxVisible:3}));button('notice','Notification',5).on('click',()=>{notices.open({key:'saved',title:'Changes saved',description:'Notifications do not take keyboard focus.',status:'success'});});
  const context=own(new GuiContextMenu({root,focusManager:focus,anchor:card.element,width:218,height:124,items:[{key:'inspect',label:'Inspect card'},{key:'copy',label:'Copy settings'}],onSelect:key=>update('Context: '+key)}));
  root.add(new GuiLabel({x:24,y:884,width:1140,height:32,text:'Right-click / long-press the card for its context menu. Try Tab, arrows, Enter and Escape.'}));
  const layout=attachGuiLayout(root);for(const {node,width,height}of frames)if(!(node instanceof GuiScrollView))layout.setStyle(node,{width,height});let dead=false;
  const stopAnimations=()=>{const pending=[root.root];while(pending.length){const node=pending.pop()!;node.setActivity(null);pending.push(...node.children);}};
  const dispose=()=>{if(dead)return;dead=true;const errors:unknown[]=[];for(const value of owned.reverse())try{value.dispose();}catch(error){errors.push(error);}layout.dispose();if(errors.length)throw new AggregateError(errors,'GUI library cleanup failed.');};
  return{card,tag,avatar,image,emptyImage,custom,warning,selected,group,skeleton,spin,empty,expand,tabs,collapse,list,tree,split,standalone,menu,popover,confirm,dialog,drawer,notices,context,actions,name,layout,status,stopAnimations,dispose};
}

export async function createGuiLibraryExample(canvas:HTMLCanvasElement,theme:'dark'|'light'='dark'){
  const engine=new HaiyueEngine({canvas,devicePixelRatio:1,msaaSamples:4,timestampQuery:false,renderProfile:'simple',diagnostics:{enabled:true}});await engine.init();
  try{const root=new GuiRoot({theme:GuiThemeResource.createTheme(theme)}),scene=engine.createScene({name:'GUI component library',camera:{type:'2d',camera2D:{designWidth:1200,designHeight:1010,viewportMode:'fixed'}},render2D:false,render3D:false,gui:false}),gui=new GuiSystem(engine,{roots:new Set([root]),textInputHost:'browser',font:{fontFamily:'system-ui',fontSize:32,atlasSize:1024}});
    scene.add(new Entity('GUI library').add(root)).addSystem(gui);const content=createGuiLibraryContent(root,gui.focus);let dead=false;const dispose=()=>{if(dead)return;dead=true;try{content.dispose();}finally{scene.destroy();engine.destroy();}};engine.switchScene(scene).run();return{engine,scene,gui,root,...content,dispose};
  }catch(error){engine.destroy();throw error;}
}
