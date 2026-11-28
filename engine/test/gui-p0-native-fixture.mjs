import {HaiyueEngine,Entity} from '@haiyue/engine';
import {GuiRoot,GuiElement,GuiLabel,GuiButton,GuiInput,GuiCheckbox,GuiRadio,GuiSwitch,GuiTooltip,GuiToast,GuiModal,GuiThemeResource,GuiSystem} from '@haiyue/engine/gui';
const query=new URLSearchParams(location.search),mode=query.get('theme')??'dark',density=query.get('density')??'comfortable',modalMode=query.has('modal');
const theme=GuiThemeResource.createTheme(mode,density),canvas=document.querySelector('canvas');
const engine=new HaiyueEngine({canvas,devicePixelRatio:Number(query.get('dpr')??1),msaaSamples:query.get('msaa')==='1'?1:4,timestampQuery:false,renderProfile:'simple',clearColor:{r:0.02,g:0.03,b:0.08,a:1}});
const finish=value=>{const out=document.querySelector('#result');out.textContent=JSON.stringify(value);out.dataset.status=value.status;};
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
try{
 await document.fonts.ready;await engine.init();const errors=[];engine.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));engine.device.pushErrorScope('validation');
 const root=new GuiRoot({theme});root.add(new GuiElement({width:1200,height:880,style:{backgroundColor:theme.colors.background,radius:0}}));
 const label=(text,x,y,width=1100,size=14)=>root.add(new GuiLabel({x,y,width,height:26,text,fontSize:size,style:{color:theme.colors.text}}));
 label(`Haiyue GUI · ${mode} / ${density}`,30,20,1100,24);
 label('Normal         Hover           Focus           Pressed         Disabled        Primary         Danger          Outline',30,70,1140,13);
 const buttons=[];for(const [i,state]of ['normal','hover','focus','pressed','disabled','primary','danger','outline'].entries()){
  const button=root.add(new GuiButton({x:30+i*142,y:102,width:126,text:state==='normal'?'Continue':state,variant:['primary','danger','outline'].includes(state)?state:'default',disabled:state==='disabled'}));
  if(state==='hover')button.hovered=true;if(state==='focus')button.focused=true;if(state==='pressed')button.pressed=true;buttons.push(button);
 }
 root.add(new GuiButton({x:30,y:160,width:160,text:'Custom orange',style:{backgroundColor:'#9a3412',color:'#fff7ed',radius:12,borderColor:'#c05b26',parts:{label:{color:'#ffedd5'}}}}));
 root.add(new GuiButton({x:210,y:160,width:120,text:'Text action',variant:'text'}));root.add(new GuiButton({x:350,y:160,width:120,text:'Open link',variant:'link'}));
 const loading=root.add(new GuiButton({x:490,y:160,width:140,text:'Loading',variant:'primary',loading:true}));
 root.add(new GuiButton({x:650,y:160,width:170,text:'Gradient',style:{gradient:{from:'#8177f2',to:'#db7dbe',angle:20},cornerRadii:[14,3,14,3],borderWidth:1,borderColor:'#c6b7ff',color:'#fff'}}));
 label('Input states, shared text/IME geometry, prefix / suffix / clear',30,222,1100,16);
 root.add(new GuiInput({x:30,y:260,width:250,value:'Player name',clearable:true,prefix:'@'}));
 const input=root.add(new GuiInput({x:300,y:260,width:250,value:'你好 Player',suffix:'px'}));input.focused=true;
 root.add(new GuiInput({x:570,y:260,width:250,value:'Invalid value',invalid:true,helpText:'Please enter a valid name',style:{parts:{help:{color:theme.colors.danger}}}}));
 root.add(new GuiInput({x:840,y:260,width:250,value:'Read only',readOnly:true}));
 root.add(new GuiInput({x:30,y:326,width:250,value:'Disabled',disabled:true}));root.add(new GuiInput({x:300,y:326,width:250,value:'password',inputType:'password'}));
 label('Selection indicators and track / thumb part overrides',30,390,1100,16);
 root.add(new GuiCheckbox({x:30,y:430,width:170,label:'Checked',checked:true}));root.add(new GuiCheckbox({x:210,y:430,width:170,label:'Indeterminate',indeterminate:true}));
 root.add(new GuiCheckbox({x:400,y:430,width:170,label:'Disabled',checked:true,disabled:true}));
 root.add(new GuiRadio({x:580,y:430,width:130,label:'Normal',checked:true}));root.add(new GuiRadio({x:730,y:430,width:130,label:'Disabled',disabled:true}));
 root.add(new GuiSwitch({x:890,y:430,width:54,checked:true}));root.add(new GuiSwitch({x:975,y:430,width:86,checked:true,checkedLabel:'ON',style:{parts:{thumb:{backgroundColor:'#fff5d6'},track:{backgroundColor:'#b15a3c'}}}}));
 label('Rounded nested clipping · image + text · four-corner box · borrowed icon rotation',30,500,1100,16);
 const outer=root.add(new GuiElement({x:30,y:540,width:350,height:145,style:{backgroundColor:theme.colors.surface,clipRadius:22,cornerRadii:[22,8,22,8]}}));
 const inner=outer.add(new GuiElement({x:90,y:24,width:300,height:140,style:{backgroundColor:'#c15b80',clipRadius:30}}));inner.add(new GuiLabel({x:-40,y:15,width:360,height:100,text:'Clipped text · 你好 · clipped text',fontSize:24,style:{color:'#fff'}}));
 const icon=document.createElement('canvas');icon.width=icon.height=32;const ctx=icon.getContext('2d');ctx.fillStyle='#f8cb71';ctx.fillRect(1,1,30,30);ctx.fillStyle='#6d50b3';ctx.fillRect(4,4,12,12);
 root.add(new GuiButton({x:420,y:555,width:160,height:60,text:'',iconOnly:true,style:{icon,iconRotation:35,iconSize:28}}));
 const clipped=root.add(new GuiElement({x:620,y:540,width:200,height:145,style:{clipRadius:30}}));clipped.add(new GuiButton({width:240,height:160,text:'',style:{icon,iconSize:160,iconRotation:25,backgroundColor:'#426d8c'}}));
 root.add(new GuiLabel({x:860,y:552,width:310,height:90,text:'Semibold 600\nTypography baseline',style:{fontWeight:600,lineHeight:28,color:theme.colors.text},fontSize:20}));
 root.add(new GuiLabel({x:860,y:650,width:160,height:24,text:'Long text should end with an ellipsis',style:{textOverflow:'ellipsis'}}));
 label('Tooltip flip / shift and toast share the popup layer',30,722,1100,16);
 const anchor=root.add(new GuiButton({x:30,y:766,width:150,text:'Tooltip target'}));anchor.hovered=true;
 root.add(new GuiTooltip({target:anchor,content:'A themed tooltip',placement:'left',width:190,height:34}));
 const toast=root.add(new GuiToast({x:420,y:760,width:330,text:'Saved · application skin remains yours',animationMs:0,durationMs:100000}));toast.show();
 if(modalMode)root.add(new GuiModal({title:'Keep exploring',message:'Theme-aware title, body and actions.\nExplicit part styles remain available.',visible:true,style:{parts:{confirm:{backgroundColor:'#985f35',color:'#fff'}}}}));
 if(query.has('deep')){root.root.setStyle({clipRadius:16});let parent=root.root;for(let i=0;i<127;i++)parent=parent.add(new GuiElement({x:i===0?1100:0,y:i===0?800:0,width:24,height:24,style:{clipRadius:2,...(i===126?{backgroundColor:'#42b883'}:{})}}));}
 const scene=engine.createScene({name:'GUI P0 gallery',camera:{type:'2d',camera2D:{designWidth:1200,designHeight:880,viewportMode:'fixed'}},render2D:false,render3D:false,gui:false});
 const gui=new GuiSystem(engine,{roots:new Set([root]),font:{fontFamily:'system-ui',fontSize:32,atlasSize:1024}});scene.add(new Entity().add(root)).addSystem(gui);engine.switchScene(scene).run();
 for(let i=0;i<12;i++)await frame();loading.setActivity(null);input.focused=false;anchor.hovered=true;
 for(let i=0;i<6;i++)await frame();
 const writes=[],write=engine.device.queue.writeBuffer.bind(engine.device.queue);engine.device.queue.writeBuffer=(buffer,...args)=>{if(buffer.label?.startsWith('gui'))writes.push({label:buffer.label,size:args.at(-1)});return write(buffer,...args);};
 for(let i=0;i<12;i++)await frame();await engine.device.queue.onSubmittedWorkDone();const scoped=await engine.device.popErrorScope();if(scoped)errors.push(scoped.message);
 finish({status:errors.length||writes.length?'failed':'passed',theme:mode,density,msaa:engine.msaaSamples,modal:modalMode,errors,staticGuiWrites:writes,viewport:{width:1200,height:880},scope:'P0 native visual and static-upload verification'});
 window.addEventListener('pagehide',()=>{engine.stop();scene.destroy();engine.destroy();},{once:true});
}catch(error){finish({status:'failed',error:String(error.stack??error)});}
