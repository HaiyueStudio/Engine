import {HaiyueEngine} from '@haiyue/engine';
import {Entity} from '@haiyue/engine/ecs';
import {GuiRoot,GuiElement,GuiInput,GuiLabel,GuiButton,GuiSystem,GuiThemeResource} from '@haiyue/engine/gui';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
import {attachGuiLayout,createGuiContainer} from '@haiyue/extensions/gui-layout';
import {GuiInputNumber} from '@haiyue/extensions/gui-forms';
import {GuiPopover,GuiDropdown,GuiPopconfirm} from '@haiyue/extensions/gui-overlays';
import {GuiCarousel} from '@haiyue/extensions/gui-content';

const result=document.querySelector('#result'),cases=[],failures=[],validationErrors=[],owned=[];
const check=(id,condition,detail={})=>{cases.push({id,passed:!!condition,...detail});if(!condition)failures.push({id,detail});};
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
let engine,scene,root,gui,layout,popup,dropdown,carousel,number,frames=0,subscriptions=0;
const numericChanges=[],carouselChanges=[];
try{
  engine=new HaiyueEngine({canvas:document.querySelector('canvas'),devicePixelRatio:1,msaaSamples:4,timestampQuery:false,renderProfile:'simple',diagnostics:{enabled:true}});await engine.init();
  engine.device.pushErrorScope('validation');engine.device.addEventListener('uncapturederror',event=>validationErrors.push(event.error.message));
  root=new GuiRoot({theme:GuiThemeResource.createTheme('dark')});const onDispose=root.onDispose;root.onDispose=function(listener){subscriptions++;const off=onDispose.call(this,listener);let active=true;return()=>{if(active){active=false;subscriptions--;}off();};};
  scene=engine.createScene({name:'GUI lifetime and hover regression',camera:{type:'2d',camera2D:{designWidth:720,designHeight:520,viewportMode:'fixed'}},render2D:false,render3D:false,gui:false});
  gui=new GuiSystem(engine,{roots:new Set([root]),textInputHost:'browser',font:{fontFamily:'system-ui',fontSize:24,atlasSize:1024}});scene.add(new Entity('GUI').add(root)).addSystem(gui);layout=attachGuiLayout(root);
  root.add(new GuiLabel({x:24,y:12,width:650,height:32,text:'GUI lifecycle and routed hover',fontSize:22}));
  const mount=(element,x,y,width,height)=>root.add(new GuiElement({x,y,width,height,pointerFilter:'ignore'})).add(element);
  const numberHost=root.add(new GuiElement({x:24,y:52,width:270,height:36,pointerFilter:'ignore'}));
  function newNumber(value){number=new GuiInputNumber({root,focusManager:gui.focus,value,onChange:value=>numericChanges.push(value)});owned.push(number);numberHost.add(number.element);return number;}
  newNumber(1);
  const anchor=root.add(new GuiButton({x:24,y:112,width:220,height:36,text:'Hover popup'}));
  const content=createGuiContainer('column',{style:{rowGap:8,width:'auto',height:'auto'}}),childA=content.add(new GuiButton({text:'Popup A',height:32})),childB=content.add(new GuiInput({value:'Borrowed editor',height:32}));
  popup=new GuiPopover({root,focusManager:gui.focus,anchor,content,trigger:'hover',width:280,height:144,style:{parts:{content:{backgroundColor:'#123456'}}}});owned.push(popup);
  const menuAnchor=root.add(new GuiButton({x:340,y:112,width:240,height:36,text:'Hover nested menu'}));
  dropdown=new GuiDropdown({root,focusManager:gui.focus,anchor:menuAnchor,trigger:'hover',items:[{key:'parent',label:'More',children:[{key:'leaf',label:'Nested leaf'}]}]});owned.push(dropdown);
  const slideA=new GuiInput({value:'Carousel editor',height:48}),slideB=new GuiLabel({text:'Second slide',height:48});carousel=new GuiCarousel({root,focusManager:gui.focus,slides:[slideA,slideB],autoplayMs:250,width:320,onChange:index=>carouselChanges.push(index)});owned.push(carousel);mount(carousel.element,340,240,320,216);
  root.add(new GuiLabel({x:24,y:440,width:280,height:42,text:'Leave both popups here'}));
  const walk=element=>[element,...element.children.flatMap(walk)];
  const point=element=>element?{x:element.rect.x+element.rect.width/2,y:element.rect.y+element.rect.height/2,width:element.rect.width,height:element.rect.height}:null;
  const state=()=>({frames,number:{point:point(number.input),focused:gui.focus.focused===number.input,value:number.value,text:number.input.value,changes:[...numericChanges]},popup:{open:popup.isOpen,closing:popup.hoverClosing,anchor:point(anchor),a:point(childA),b:point(childB),childHovered:childA.hovered||childB.hovered,panelHovered:popup.panel.hovered,color:content.getResolvedStyle().backgroundColor},dropdown:{open:dropdown.isOpen,anchor:point(menuAnchor),parent:point(dropdown.menu.buttons[0]),leaf:point(walk(root.root).find(node=>node instanceof GuiButton&&node.text==='Nested leaf'))},carousel:{index:carousel.index,point:point(slideA),hovered:slideA.hovered,rootHovered:carousel.element.hovered},subscriptions});
  window.guiRegression={state,check,
    disposeNumber(){let error;try{number.dispose();}catch(cause){error=String(cause);}check('number-dispose',!error&&number.value===1&&numericChanges.length===0&&number.element.parent===null,{error,value:number.value,changes:[...numericChanges]});},
    normalNumber(){newNumber(3);},
    checkNumberBlur(){check('number-blur',number.value===4&&numericChanges.length===1&&numericChanges[0]===4,{value:number.value,changes:[...numericChanges]});number.dispose();},
    rejectConstructors(){
      for(const[name,create]of [['popover',content=>new GuiPopover({root,focusManager:gui.focus,content,trigger:'click'})],['dropdown',()=>new GuiDropdown({root,focusManager:gui.focus,items:[{key:'x',label:'X'}]})],['popconfirm',()=>new GuiPopconfirm({root,focusManager:gui.focus,title:'Confirm'})]]){
        const content=new GuiInput({value:'kept'}),before=subscriptions;let rejected=false,reusable=false,error;
        try{create(content);}catch(cause){rejected=true;error=String(cause);}
        try{const manual=new GuiPopover({root,focusManager:gui.focus,content,trigger:'manual'});manual.dispose();reusable=true;}catch{}
        check('constructor-'+name,rejected&&subscriptions===before&&content.parent===null&&reusable,{rejected,reusable,subscriptionsBefore:before,subscriptionsAfter:subscriptions,error});
      }
    },
    resetCarousel(){carousel.setIndex(0);carouselChanges.length=0;},
    carouselChanges(){return [...carouselChanges];},
    async finish(){
      for(const value of owned.reverse())try{value.dispose();}catch(error){failures.push({id:'dispose',error:String(error)});}
      check('subscriptions-released',subscriptions===0,{subscriptions});
      await engine.device.queue.onSubmittedWorkDone();const error=await engine.device.popErrorScope();if(error)validationErrors.push(error.message);
      layout.dispose();scene.destroy();engine.destroy();await settle();const usage=getEngineDiagnosticsSnapshot(engine).gpuResources.totals;
      check('resources-released',usage.resources===0,{usage});if(validationErrors.length)failures.push({id:'gpu-validation',errors:validationErrors});
      result.textContent=JSON.stringify({schemaVersion:1,status:failures.length?'failed':'passed',role:'native-gui-interaction-regression',generatedAt:new Date().toISOString(),browser:navigator.userAgent,cases,failures,validationErrors,resourceResidue:usage});result.dataset.status=failures.length?'failed':'passed';
    }
  };
  engine.on('after-update',()=>{frames++;});engine.switchScene(scene).run();
}catch(error){try{layout?.dispose();scene?.destroy();engine?.destroy();}catch{}result.textContent=JSON.stringify({status:'failed',error:error.stack??String(error)});result.dataset.status='failed';}
