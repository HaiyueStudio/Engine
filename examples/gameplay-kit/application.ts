import {HaiyueEngine} from '@haiyue/engine';
import {Entity,System} from '@haiyue/engine/ecs';
import {Camera2D,Transform2D,Mesh2D} from '@haiyue/engine/components';
import {Physics2DBody,Physics2DSystem} from '@haiyue/engine/physics';
import {createBox2DPhysics2DBackend} from '@haiyue/engine/physics/backend';
import {Mesh2DRenderSystem} from '@haiyue/engine/systems';
import {createRect2D,createCircle2D} from '@haiyue/engine/geometry';
import {Material2D} from '@haiyue/engine/material';
import {ColorSRGB} from '@haiyue/engine/color';
import {GuiRoot,GuiElement,GuiLabel,GuiButton,GuiInput,GuiScrollView,GuiSystem,GuiDirtyFlags} from '@haiyue/engine/gui';
import {InputActionMap} from '@haiyue/engine/input';
import {BrowserMultiplayerInput} from '@haiyue/engine/experimental/simulation';
import type {StandardGamepadSnapshot} from '@haiyue/engine/input';
import type {MultiplayerInputSnapshot} from '@haiyue/engine/experimental/simulation';
import {OwnerSafeAudioMixer} from '@haiyue/engine/audio';
import {GameSaveService,LocalStorageSaveBackend} from '@haiyue/engine/save';
import type {GameSaveBackend} from '@haiyue/engine/save';
import type {Scene} from '@haiyue/engine/scene';
import type {ScenePluginScene,RenderRegion} from '@haiyue/engine/core';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
import type {EngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
import {createSceneFlow} from '@haiyue/extensions/scene-flow';
import {createCharacter2D} from '@haiyue/extensions/character2d';
import {createCamera2DController} from '@haiyue/extensions/camera2d';
import {createInputBindingProfile} from '@haiyue/extensions/input-actions';
import type {InputBindingProfileData} from '@haiyue/extensions/input-actions';
import {createGuiVirtualList,createGuiVirtualTree} from '@haiyue/extensions/gui-collections';
import {GuiTabContainer,createGuiContainer,attachGuiLayout} from '@haiyue/extensions/gui-layout';
import {GuiBreadcrumb,GuiBadge,GuiCollapse} from '@haiyue/extensions/gui-controls';
import {Tilemap2DComponent,Tilemap2DRenderSystem} from '@haiyue/extensions/tilemap';
import {createGameAudio} from '@haiyue/extensions/audio';
import type {GameAudio,GameAudioProfile} from '@haiyue/extensions/audio';

interface Settings {input:InputBindingProfileData;audio:GameAudioProfile;name:string;}
interface Level {
 scene:Scene;physics:Physics2DSystem;characters:ReturnType<typeof createCharacter2D>[];
 camera:ReturnType<typeof createCamera2DController>;map:Tilemap2DComponent;audio:GameAudio;loadedParts:string[];
 startVoices():void;stopVoices():void;resize():void;edit(percent:number):void;readonly dead:boolean;
}
export interface GameplayFrame {time:number;rawDelta:number;cpuFrameMs:number;guiCpuMs:number;diagnostics:EngineDiagnosticsSnapshot;guiRecords:number;}
export interface GameplayOptions {
 samples?:1|4;assetUrl?:string;assetDelayMs?:number;backend?:GameSaveBackend;
 getGamepads?:()=>ArrayLike<StandardGamepadSnapshot|null>;gamepadIndex?:number;onFrame?:(frame:GameplayFrame)=>void;
 timestampQuery?:boolean;
}

/** One real application over the published owners; the installed-package gate compiles this exact source. */
export async function createGameplayKit(canvas:HTMLCanvasElement,options:GameplayOptions={}) {
 const coldStart={startedAt:performance.now(),readyAt:0,firstRenderedAt:null as number|null,startupFrames:[] as GameplayFrame[],completedFrames:[] as {frame:number;completedAt:number}[]};
 const engine=new HaiyueEngine({canvas,msaaSamples:options.samples??1,timestampQuery:options.timestampQuery??true,diagnostics:{enabled:true},clearColor:{r:.025,g:.045,b:.075,a:1}});
 const rollback:(()=>unknown)[]=[()=>engine.destroy()];
 try {
 await engine.init();
 let dead=false,serial=0,guiRecords=0,liveWorlds=0,peakWorlds=0,liveLevels=0,createdLevels=0,destroyedLevels=0,loads=0,releases=0,loading=0,peakLoading=0;
 let tick=0,polls=0,binding=false,capturingFrame=false,axis=0,jump=false,paused=false,mutationPercent=0,audioEnabled=false,transitioning=false,frameCpuStart=0,frameGuiCpu=0;
 let current:Level|null=null,lastInput:MultiplayerInputSnapshot|undefined,audioContext:AudioContext|undefined;
 const levels=new WeakMap<ScenePluginScene,Level>(),guiRegions=new WeakMap<Scene,RenderRegion>(),resizers=new WeakMap<Scene,()=>void>(),rows={created:0,disposed:0,bound:0,unbound:0};
 const side=()=>Math.min(480,engine.displayWidth),assetUrl=options.assetUrl??new URL('./level.json',import.meta.url).href;
 const mixer=new OwnerSafeAudioMixer({contextFactory:()=>audioContext??(audioContext=new AudioContext({sampleRate:48000})),ownsContext:false});
 const audio=createGameAudio({mixer}),saves=new GameSaveService<Settings>({gameId:'engine-gameplay-kit-023',dataVersion:1,backend:options.backend??new LocalStorageSaveBackend({namespace:'haiyue-engine-examples'}),ownsBackend:options.backend===undefined,maxSlots:1});
 rollback.push(async()=>{mixer.dispose();if(audioContext&&audioContext.state!=='closed')await audioContext.close();},()=>audio.dispose(),()=>saves.dispose());
 const shell=engine.createScene({name:'Persistent gameplay GUI',camera:{type:'2d'},render2D:false,render3D:false,gui:false});
 shell.renderView.loadOp='load';
 rollback.push(()=>shell.destroy());
 const root=new GuiRoot({theme:{fontSize:14,radius:4}});let guiRegion:RenderRegion|undefined;
 class CountedGui extends GuiSystem {
  override prepareFrame(...args:Parameters<GuiSystem['prepareFrame']>):void {const started=performance.now();try{super.prepareFrame(...args);}finally{frameGuiCpu+=performance.now()-started;}}
  override record(world:Parameters<GuiSystem['record']>[0],context:Parameters<GuiSystem['record']>[1]):this {const started=performance.now();guiRecords++;try{return super.record(world,context);}finally{frameGuiCpu+=performance.now()-started;}}
 }
 const gui=new CountedGui(engine,{roots:new Set([root]),textInputHost:'browser',loadOp:'load'}),guiEntity=new Entity('Persistent settings').addComponent(root);shell.add(guiEntity);shell.addSystem(gui,false);
 // Transfer the borrowed GUI entity before the original SceneFlow retires the old scene.
 // The shell retains one System lifetime; only the active scene's original pipeline renders it.
 const sceneHost={get activeScene(){return engine.activeScene;},switchScene(scene:Scene|null,settings?:{destroyPrevious?:boolean}){
  if(scene){let region=guiRegions.get(scene);if(!region){region=scene.renderView.createRegion({id:'gameplay-settings',bounds:{x:0,y:0,width:side(),height:engine.displayHeight},updateMode:'demand',clearMode:'on-update',visible:true});guiRegions.set(scene,region);}scene.world.transferEntity(guiEntity);scene.addSystem(gui,{region,pass:'isolated',loadOp:'load'});guiRegion=region;}
  else{shell.world.transferEntity(guiEntity);guiRegion=undefined;}
  const value=engine.switchScene(scene,settings);if(scene)resizers.get(scene)?.();return value;
 }};
 root.add(new GuiElement({width:'100%',height:'100%',pointerFilter:'ignore',style:{backgroundColor:'#07111e'}}));
 root.add(new GuiLabel({x:12,y:8,width:'95%',height:30,text:'GAMEPLAY KIT',fontSize:22}));
 const status=root.add(new GuiLabel({id:'kit-status',x:12,y:680,width:'95%',height:28,text:'Menu — configure settings, then start a level.'}));
 const say=(value:string)=>{if(!dead)status.setText(value);};
 const map=InputActionMap.standardGameplay();
 // Application command slots stay unbound until configured; the separate frozen input workload measures 128 active bindings.
 for(let i=map.actionNames().length;i<128;i++)map.setAction('Command'+i,{});
 const profile=createInputBindingProfile({map,onChange:()=>{binding=false;say('Binding updated. Save settings to keep it.');},onConflict:conflict=>say('Conflict: '+conflict.otherActions.join(', '))});
 rollback.push(()=>profile.dispose());
 const input=new BrowserMultiplayerInput({eventTarget:window,players:[{id:'player',bindings:map,gamepadIndex:options.gamepadIndex??0}],getGamepads:()=>{
  polls++;capturingFrame=binding;const pads=options.getGamepads?.()??navigator.getGamepads?.()??[];
  if(binding)profile.offer({device:'gamepad',index:options.gamepadIndex??0,snapshot:pads[options.gamepadIndex??0]??{connected:false,buttons:[],axes:[]}});
  return pads;
 }}),offGui=gui.attachGamepadInput(input),offCapture=input.addGamepadRoute(()=>capturingFrame||binding);
 rollback.push(()=>{offCapture();offGui();input.dispose();});
 const setGuiActive=(active:boolean)=>{if(gui.disabled===!active)return;binding=false;profile.cancelRebind();gui.disabled=!active;gui.focus.blur();input.release();axis=0;jump=false;};
 const beginRebind=(kind:'negative'|'positive'|'button')=>{input.release();profile.beginRebind(kind==='button'?'Jump':'MoveX',kind);binding=true;say('Release, then press the new control. Esc cancels.');};
 const name=new GuiInput({id:'kit-name',width:'100%',height:32,value:'Player'});
 const save=async()=>{await saves.save({saveId:'settings',name:'Gameplay settings',data:{input:profile.exportData(),audio:audio.exportProfile(),name:name.value}});say('Settings saved.');};
 const restore=async()=>{
  const value=await saves.load('settings');if(dead||!value)return false;
  if(!value.data||typeof value.data.name!=='string')throw new TypeError('Invalid gameplay settings name.');
  const previous={input:profile.exportData(),audio:audio.exportProfile(),name:name.value};let inputApplied=false;
  try{profile.restore(value.data.input);inputApplied=true;audio.restoreProfile(value.data.audio);name.setValue(value.data.name);}
  catch(error){
   if(inputApplied){const failures:unknown[]=[];for(const restorePart of [()=>name.setValue(previous.name),()=>audio.restoreProfile(previous.audio),()=>profile.restore(previous.input)])try{restorePart();}catch(rollbackError){failures.push(rollbackError);}
    if(failures.length)throw new AggregateError([error,...failures],'Gameplay settings restore and rollback failed.');}
   throw error;
  }
  input.release();say('Settings restored.');return true;
 };
 const run=(job:()=>Promise<unknown>)=>{void job().catch(error=>{if(!dead&&!(error&&typeof error==='object'&&'code'in error&&['E_SCENE_FLOW_ABORTED','E_SCENE_FLOW_SUPERSEDED'].includes(String(error.code))))say(error instanceof Error?error.message:String(error));});};
 engine.assetManager!.registerLoader<{title:string}>({type:'gameplay-level',async load(url,context){
  loads++;loading++;peakLoading=Math.max(peakLoading,loading);
  try{const response=await fetch(url,{signal:context.signal});if(!response.ok)throw Error('Level response '+response.status);const value:unknown=await response.json();
   if(options.assetDelayMs){await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>{context.signal.removeEventListener('abort',abort);yes();},options.assetDelayMs),abort=()=>{clearTimeout(timer);context.signal.removeEventListener('abort',abort);no(context.signal.reason);};context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();});}
   if(new URL(url).searchParams.has('fail'))throw Error('Requested level failure.');if(!value||typeof(value as {title?:unknown}).title!=='string')throw Error('Invalid level descriptor.');return value as {title:string};
  }finally{loading--;}
 },dispose(){releases++;}});
 const atlasCanvas=document.createElement('canvas');atlasCanvas.width=16;atlasCanvas.height=8;const paint=atlasCanvas.getContext('2d')!;
 paint.fillStyle='#17364a';paint.fillRect(0,0,8,8);paint.fillStyle='#285366';paint.fillRect(0,0,8,1);paint.fillRect(0,0,1,8);paint.fillStyle='#255238';paint.fillRect(8,0,8,8);paint.fillStyle='#458358';paint.fillRect(8,0,8,2);
 const atlasHandle=await engine.assetManager!.loadTexture(atlasCanvas,{label:'gameplay-kit-atlas',premultipliedAlpha:true,mipmaps:'none'}),atlas={source:{get texture(){return atlasHandle.value;}},sourceWidth:16,sourceHeight:8,tileWidth:8,tileHeight:8};
 rollback.push(async()=>{await engine.device.queue.onSubmittedWorkDone();atlasHandle.release();});
 const backendSource=createBox2DPhysics2DBackend(),backend={id:backendSource.id,capabilities:backendSource.capabilities,createWorld:(value:Parameters<typeof backendSource.createWorld>[0])=>{const driver=backendSource.createWorld(value),destroy=driver.destroy.bind(driver);let live=true;liveWorlds++;peakWorlds=Math.max(peakWorlds,liveWorlds);driver.destroy=()=>{if(!live)return;live=false;liveWorlds--;destroy();};return driver;}};
 function buildLevel():Level {
  const id=++serial,scene=engine.createScene({name:'Level '+id,camera:{type:'2d',camera2D:{designWidth:800,designHeight:720,viewportMode:'expand'}},render2D:false,render3D:false,gui:false});
  createdLevels++;liveLevels++;let closed=false,removeStep=()=>{},camera:ReturnType<typeof createCamera2DController>|undefined,voiceStops:(()=>void)[]=[],voiceIds:string[]=[],voiceStarted=false;
  const characters:ReturnType<typeof createCharacter2D>[]=[],levelAudio=createGameAudio({mixer,listener:()=>characters[0]?.state.position??[0,0]});
  class Lifetime extends System {override destroy():this {if(!closed){closed=true;liveLevels--;destroyedLevels++;removeStep();camera?.dispose();for(const c of characters)c.dispose();for(const off of voiceStops)off();voiceStops=[];levelAudio.dispose();}return super.destroy();}}
  scene.addSystem(new Lifetime(()=>false),false);
  const region=scene.renderView.createRegion({id:'gameplay-world',bounds:{x:side(),y:0,width:Math.max(1,engine.displayWidth-side()),height:engine.displayHeight},updateMode:'continuous',clearMode:'on-update',visible:true});
  const physics=new Physics2DSystem({backend,gravity:[0,0],priority:-100});scene.addSystem(physics,false);
  const commonObstacle=createRect2D({width:48,height:24}),material=new Material2D({color:new ColorSRGB(.24,.52,.62,1)});
  const obstacle=(index:number,x:number,y:number,width:number,height:number,rotation=0,type:'static'|'kinematic'='static')=>{const geometry=width===48&&height===24?commonObstacle:createRect2D({width,height}),entity=new Entity('Obstacle '+index).addComponent(new Transform2D({x,y,rotation})).addComponent(new Physics2DBody({type,width,height})).addComponent(new Mesh2D(geometry,material));scene.add(entity);return entity;};
  obstacle(0,0,-250,2600,24);obstacle(1,320,-180,240,16,Math.PI/6);obstacle(2,700,-80,8,320);const platform=obstacle(3,-180,-130,150,16,0,'kinematic');
  for(let i=4;i<128;i++)obstacle(i,1100+(i%16)*96,-220+Math.floor(i/16)*80,48,24);
  const circles=createCircle2D({radius:18}),box=createRect2D({width:36,height:36}),actorMaterial=new Material2D({color:new ColorSRGB(.3,.78,.98,1)}),visuals:Transform2D[]=[];
  for(let i=0;i<32;i++){const x=-500+(i%8)*54,y=-80+Math.floor(i/8)*64,actor=new Entity('Character '+i).addComponent(new Transform2D({x,y})).addComponent(new Physics2DBody({type:'kinematic',shape:i%2?'circle':'box',width:36,height:36,radius:18}));scene.add(actor);characters.push(createCharacter2D({physics,entity:actor}));const visual=new Transform2D({x,y});visuals.push(visual);scene.add(new Entity('Presentation '+i).addComponent(visual).addComponent(new Mesh2D(i%2?circles:box,actorMaterial)));}
  const cells=Int16Array.from({length:512*512},(_,i)=>i%37===0?0:1+Math.floor(i/512/4)%2),terrain=new Tilemap2DComponent({columns:512,rows:512,cells,cellWidth:32,cellHeight:32,originX:-8192,originY:-8192,gap:0,atlas});scene.add(new Entity('Terrain').addComponent(new Transform2D()).addComponent(terrain));
  scene.addSystem(new Tilemap2DRenderSystem(engine,scene.cameraEntity,{loadOp:'clear'}),{region,pass:'isolated'});scene.addSystem(new Mesh2DRenderSystem(engine,scene.cameraEntity,{loadOp:'load'}),{region,pass:'isolated'});
  scene.cameraEntity.addComponent(new Transform2D());camera=createCamera2DController({camera:scene.cameraEntity,target:()=>characters[0]!.state.position,damping:8,deadZone:{width:100,height:60},bounds:{x:-1200,y:-500,width:4000,height:1600},interpolation:()=>({previous:characters[0]!.state.previousPosition,current:characters[0]!.state.position,alpha:physics.interpolationAlpha})});camera.reset();
  removeStep=physics.onFixedStep(event=>{if(event.phase!=='before')return;const p=platform.getComponent(Transform2D)!,direction=p.x>-80?-1:p.x<-300?1:undefined;if(direction!==undefined)platformDirection=direction;physics.setLinearVelocity(platform.getComponent(Physics2DBody)!,platformDirection*.4,0,false);for(let i=0;i<characters.length;i++){const c=characters[i]!,state=c.state,x=i===0?axis:0;const y=i===0&&jump&&state.grounded?330:state.grounded?0:Math.max(-500,state.velocity[1]-800*event.deltaSeconds);c.setVelocity([x*180,y]);}jump=false;});
  let platformDirection=1,editGeneration=0;
  const edit=(percent:number)=>{if(![0,1,10].includes(percent))throw new RangeError('Use 0, 1 or 10 percent.');const count=Math.ceil(cells.length*percent/100);for(let i=0;i<count;i++){const cell=(i*997+editGeneration*131)%cells.length,x=cell%512,y=Math.floor(cell/512);terrain.setCell(x,y,terrain.getCell(x,y)===1?2:1);}editGeneration++;};
  const presentation=new System(entity=>entity===scene.cameraEntity,(_entity,_time,delta)=>{const dt=Math.max(0,delta);for(let i=0;i<characters.length;i++){const s=characters[i]!.state,t=visuals[i]!,a=physics.interpolationAlpha;t.x=s.previousPosition[0]+(s.position[0]-s.previousPosition[0])*a;t.y=s.previousPosition[1]+(s.position[1]-s.previousPosition[1])*a;}camera!.update(dt);levelAudio.update(dt);if(mutationPercent)edit(mutationPercent);});presentation.priority=-50;scene.addSystem(presentation,false);
  const stopVoices=()=>{for(const off of voiceStops)off();voiceStops=[];for(const voice of voiceIds)mixer.stopVoice(voice);voiceIds=[];voiceStarted=false;};
  const startVoices=()=>{if(!audioEnabled||voiceStarted||closed)return;if(mixer.getCapabilities().stereoPan!==true){say('Required stereo emitter capability is unavailable.');return;}voiceStarted=true;for(let i=0;i<32;i++){const channel='ambient-'+i,owner='level-'+id;voiceStops.push(levelAudio.bindEmitter2D({owner,channel,position:()=>characters[i]!.state.position,maxDistance:1200,volume:.015}));const voice=levelAudio.play({eventId:id+'-'+i,owner,channel,bufferId:'tone',bus:'sfx',loop:true,startTick:tick});if(voice!==null)voiceIds.push(voice);}};
  const resize=()=>{region.setBounds({x:side(),y:0,width:Math.max(1,engine.displayWidth-side()),height:engine.displayHeight});scene.cameraEntity.getComponent(Camera2D)!.resize(Math.max(1,engine.displayWidth-side()),engine.displayHeight);};
  const result:Level={scene,physics,characters,camera,map:terrain,audio:levelAudio,loadedParts:[],startVoices,stopVoices,resize,edit,get dead(){return closed;}};levels.set(scene,result);resizers.set(scene,resize);return result;
 }
 const flow=createSceneFlow({engine:sceneHost,onProgress:value=>{if(value.phase==='active'){current=engine.activeScene?levels.get(engine.activeScene)??null:null;transitioning=false;current?.startVoices();}say(value.phase==='preparing'?'Loading '+value.completed+'/'+value.total:value.phase==='active'?(current?'Level ready':'Menu'):value.phase==='failed'?'Load failed; previous scene retained.':value.phase==='cancelled'?'Loading cancelled.':value.phase);}});
 rollback.push(()=>flow.dispose());
 const menu=()=>flow.transition({id:'menu',create:()=>{const scene=engine.createScene({name:'Menu',camera:{type:'2d',camera2D:{designWidth:800,designHeight:720,viewportMode:'expand'}},render2D:false,render3D:false,gui:false}),region=scene.renderView.createRegion({id:'gameplay-world',bounds:{x:side(),y:0,width:Math.max(1,engine.displayWidth-side()),height:engine.displayHeight},updateMode:'continuous',clearMode:'on-update',visible:true});scene.add(new Entity('Menu backdrop').addComponent(new Transform2D()).addComponent(new Mesh2D(createRect2D({width:280,height:180}),new Material2D({color:new ColorSRGB(.1,.22,.32,1)}))));scene.addSystem(new Mesh2DRenderSystem(engine,scene.cameraEntity,{loadOp:'clear'}),{region,pass:'isolated'});resizers.set(scene,()=>{region.setBounds({x:side(),y:0,width:Math.max(1,engine.displayWidth-side()),height:engine.displayHeight});scene.cameraEntity.getComponent(Camera2D)!.resize(Math.max(1,engine.displayWidth-side()),engine.displayHeight);});return scene;}});
 const start=async(failIndex=-1)=>{transitioning=true;try{return await flow.transition({id:'level',create:()=>buildLevel().scene,assets:Array.from({length:32},(_,i)=>{const url=new URL(assetUrl);url.searchParams.set('part',String(i));if(i===failIndex)url.searchParams.set('fail','1');return{url:url.href,type:'gameplay-level',assign:(value:unknown,scene:ScenePluginScene)=>{const level=levels.get(scene);if(!level)throw Error('Missing level application state.');level.loadedParts[i]=(value as {title:string}).title;}};})});}finally{transitioning=false;}};
 const unlock=async()=>{await audio.resume();if(dead)return;if(!audioContext)throw Error('Audio host did not provide a context.');if(!audioEnabled){const buffer=audioContext.createBuffer(1,audioContext.sampleRate,audioContext.sampleRate);const data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.sin(2*Math.PI*440*i/audioContext.sampleRate)*.12;mixer.installBuffer('tone',buffer);audioEnabled=true;}current?.startVoices();say('Audio unlocked — '+String(mixer.getCapabilities().stereoPan?'stereo available':'stereo unavailable'));};
 let auditionPosition:readonly[number,number]=[0,0],stopAudition=()=>{};
 const audition=async(x:number,y=0)=>{await unlock();current?.stopVoices();stopAudition();audio.setListener(()=>[0,0]);stopAudition=audio.bindEmitter2D({owner:'audition',channel:'tone',position:()=>auditionPosition,maxDistance:100,volume:1,panStrength:10});auditionPosition=[x,y];audio.play({eventId:'audition-'+(++serial),owner:'audition',channel:'tone',bufferId:'tone',bus:'ui',loop:true,startTick:tick});audio.update(0);};
 const icon=(color:string)=>{const c=document.createElement('canvas');c.width=16;c.height=16;const draw=c.getContext('2d')!;draw.fillStyle=color;draw.fillRect(2,2,12,12);return c;},icons=[icon('#3b82f6'),icon('#f59e0b')];
 const breadcrumb=new GuiBreadcrumb({focus:gui.focus,items:['Home','Settings','Load','Level','Map','Items','Audio','Current'].map((label,i)=>({key:'crumb-'+i,label,...(i===1?{menu:[{key:'menu-controls',label:'Controls'},{key:'menu-collections',label:'Collections'}]}:{})})),onNavigate:key=>{if(key==='crumb-0')run(menu);else if(key==='menu-collections')tabs.activate('tab-1');else tabs.activate('tab-0');say('Navigate '+key);}});root.add(new GuiElement({x:12,y:40,width:'95%',height:58,pointerFilter:'ignore'})).add(breadcrumb.element);
 rollback.push(()=>breadcrumb.dispose());
 const badges:GuiBadge[]=[],badgeButtons:GuiButton[]=[];let badgeClicks=0;
 for(let i=0;i<32;i++){const button=new GuiButton({width:46,height:22,text:String(i+1),onClick:()=>{badgeClicks++;badges[i]!.setValue(badgeClicks);say('Badge clicked '+badgeClicks);}}),badge=new GuiBadge({content:button,value:i===1?99:i===2?100:i,style:{fontSize:10}});root.add(new GuiElement({x:12+(i%8)*57,y:103+Math.floor(i/8)*26,width:52,height:22,pointerFilter:'ignore'})).add(badge.element);badges.push(badge);badgeButtons.push(button);}
 rollback.push(()=>{for(const badge of badges)badge.dispose();});
 const items=Array.from({length:1000},(_,i)=>({key:'item-'+i,value:'Item '+i})),edits=new Map<string,string>();
 const list=createGuiVirtualList({items,keyOf:item=>item.key,rowHeight:28,height:560,focus:gui.focus,createRow(){rows.created++;const element=new GuiInput({width:'100%',height:28});return{element,bind(item,key){rows.bound++;element.setValue(edits.get(key)??item.value);const change=(value:string)=>edits.set(key,value);element.onChange=change;return()=>{if(element.onChange===change)element.onChange=null;rows.unbound++;};},dispose(){rows.disposed++;element.removeAllListeners();}};}});
 rollback.push(()=>list.dispose());
 const tree=createGuiVirtualTree({nodes:Array.from({length:10},(_,i)=>({key:'group-'+i,value:'Group '+i,children:Array.from({length:100},(_,j)=>({key:'node-'+i+'-'+j,value:'Node '+i+'/'+j}))})),expandedKeys:['group-0'],rowHeight:28,height:560,focus:gui.focus,createRow(){rows.created++;const element=new GuiButton({width:'100%',height:28});return{element,bind(node){rows.bound++;element.setText(node.value);return()=>{rows.unbound++;};},dispose(){rows.disposed++;element.removeAllListeners();}};}});
 rollback.push(()=>tree.dispose());
 const button=(text:string,action:()=>void)=>new GuiButton({width:'100%',height:32,text,onClick:action});
 const stack=(...children:GuiElement[])=>{const e=createGuiContainer('column',{style:{width:{percent:100},height:'auto',contentMinimum:true,rowGap:6}});for(const child of children)e.add(child);return e;};
 const controls=stack(name,button('Start level',()=>run(()=>start())),button('Control world (F1: settings)',()=>setGuiActive(false)),button('Cancel loading',()=>flow.cancel()),button('Return to menu',()=>run(menu)),button('Try failed load',()=>run(()=>start(3))),button('Save settings',()=>run(save)),button('Restore settings',()=>run(restore)),button('Rebind left',()=>beginRebind('negative')),button('Rebind right',()=>beginRebind('positive')),button('Rebind Jump',()=>beginRebind('button')));
 const audioControls=()=>stack(button('Unlock audio',()=>run(unlock)),button('Hear left',()=>run(()=>audition(-10))),button('Hear center',()=>run(()=>audition(0,10))),button('Hear right',()=>run(()=>audition(10))),button('Far / silent',()=>{auditionPosition=[100,0];audio.update(0);}),button('Fade UI over two seconds',()=>audio.fadeBus('ui',0,2000)),button('Mute / unmute',()=>audio.setMuted(!audio.exportProfile().muted)),button('Reset audio volumes',()=>{audio.setVolumes({master:1,music:1,sfx:1,ui:1});audio.setMuted(false);}),button('Suspend / resume audio',()=>run(()=>mixer.stats.state==='suspended'?audio.resume():audio.suspend())));
 const sound=audioControls();
 const extra=new GuiButton({width:110,height:28,text:'Reset name',onClick:()=>name.setValue('Player')});
 const panels=Array.from({length:16},(_,i)=>({key:'panel-'+i,title:i===0?'Play and settings':i===1?'Audio':i===2?'Map and camera':'Panel '+(i+1),content:i===0?controls:i===1?sound:i===2?stack(button('Edit visible terrain',()=>current?.edit(1)),button('Shake camera',()=>current?.camera.shake({amplitude:14,durationMs:500,seed:7})),button('Teleport / reset',()=>{current?.characters[0]!.teleport([-500,0]);current?.camera.reset();}),button('Pause / resume physics',()=>{paused=!paused;if(current)current.physics.disabled=paused;})):new GuiElement({height:32}),...(i===0?{extra}:{})}));
 const collapse=new GuiCollapse({items:panels,expandedKeys:['panel-0'],focus:gui.focus}),pages=Array.from({length:12},(_,i)=>({id:'tab-'+i,title:['Play','List','Tree','Audio','Map','Profile','Load','Camera','Info','Theme','Help','Close'][i]!,content:i===0?collapse.element:i===1?list.element:i===2?tree.element:new GuiElement({height:32}),closable:i===11,...(i%3!==2?{icon:icons[i%2]!,iconPosition:i%2?'right' as const:'left' as const}:{})}));
 rollback.push(()=>collapse.dispose());
 const label=(text:string)=>new GuiLabel({text,width:'100%',height:32});
 pages[3]!.content=stack(label('A gesture unlocks the original audio host.'),audioControls());
 pages[4]!.content=stack(label('512 × 512 cells; one borrowed atlas.'),button('Edit 1% once',()=>current?.edit(1)),button('Edit 10% once',()=>current?.edit(10)),button('Static map',()=>{mutationPercent=0;}),button('Continuous 1% updates',()=>{mutationPercent=1;}),button('Continuous 10% updates',()=>{mutationPercent=10;}));
 pages[5]!.content=stack(label('Bindings and audio share one save slot.'),button('Rebind Move left',()=>beginRebind('negative')),button('Rebind Move right',()=>beginRebind('positive')),button('Rebind Jump',()=>beginRebind('button')),button('Save profile',()=>run(save)),button('Restore profile',()=>run(restore)));
 pages[6]!.content=stack(label('32 asset leases; four concurrent requests.'),button('Prepare and enter level',()=>run(()=>start())),button('Cancel current load',()=>flow.cancel()),button('Fail one asset',()=>run(()=>start(3))),button('Return to menu',()=>run(menu)));
 pages[7]!.content=stack(label('Presentation follows; physics is unchanged.'),button('Shake camera',()=>current?.camera.shake({amplitude:14,durationMs:500,seed:7})),button('Teleport and reset',()=>{current?.characters[0]!.teleport([-500,0]);current?.camera.reset();}),button('Pause / resume',()=>{paused=!paused;if(current)current.physics.disabled=paused;}));
 pages[8]!.content=stack(label('World, assets and sounds keep their own owners.'),button('Show live owners',()=>say('Worlds '+liveWorlds+' · levels '+liveLevels+' · voices '+mixer.stats.voices+' · rows '+list.stats.rowInstances)),label('First-frame counters include real startup work.'));
 pages[9]!.content=stack(button('Use 14px theme',()=>{root.theme.fontSize=14;root.root.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Text);}),button('Use 16px theme',()=>{root.theme.fontSize=16;root.root.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Text);}),label('Icons, labels and panels use original metrics.'));
 pages[10]!.content=stack(label('Arrow keys / A D move; Space jumps.'),label('Gamepad uses the original single sampler.'),label('Tab / shoulders move GUI focus.'),label('Escape closes menus or cancels rebinding.'));
 pages[11]!.content=stack(label('Close this tab using its x button.'),label('Borrowed page content is detached safely.'));
 const scrolls=pages.map(page=>{const scroll=new GuiScrollView({width:'100%',height:'100%',contentHeight:0,showScrollbar:true});scroll.add(page.content);return scroll;});
 let configureActiveScroll=()=>{};
 const tabs=new GuiTabContainer({id:'kit-tabs',focus:gui.focus,pages:pages.map((p,i)=>({...p,content:scrolls[i]!})),tabWidth:92,tabHeight:30,onActiveChange:()=>configureActiveScroll()});root.add(new GuiElement({x:12,y:215,width:'95%',height:452,pointerFilter:'ignore'})).add(tabs.element);
 rollback.push(()=>tabs.dispose());
 const layout=attachGuiLayout(root);rollback.push(()=>layout.dispose());layout.setStyle(breadcrumb.element,{width:456,height:58});layout.setStyle(tabs.element,{width:456,height:452});configureActiveScroll=()=>{const scroll=scrolls[Number(tabs.activeId?.slice(4))];if(scroll)layout.setStyle(scroll,{direction:'column'});};configureActiveScroll();for(const badge of badges)layout.setStyle(badge.element,{width:52,height:22});
 layout.setStyle(status,{anchors:{left:0,top:1,right:1,bottom:1},offsets:{left:12,right:-12,top:-36,bottom:-8},height:28});
 const key=(event:KeyboardEvent)=>{if(event.code==='F1'&&event.type==='keydown'&&!event.repeat){event.preventDefault();setGuiActive(gui.disabled);return;}if(event.code==='Escape'&&binding){profile.cancelRebind();binding=false;input.release();return;}if(!binding||event.repeat)return;profile.offer({device:'keyboard',code:event.code,down:event.type==='keydown'});input.release();};
 const pointerFocus=(event:PointerEvent)=>{const bounds=canvas.getBoundingClientRect(),x=(event.clientX-bounds.left)*engine.displayWidth/bounds.width;setGuiActive(x<side());};
 const blur=()=>{binding=false;profile.cancelRebind();};window.addEventListener('keydown',key);window.addEventListener('keyup',key);window.addEventListener('blur',blur);canvas.addEventListener('pointerdown',pointerFocus,{capture:true});
 rollback.push(()=>{window.removeEventListener('keydown',key);window.removeEventListener('keyup',key);window.removeEventListener('blur',blur);canvas.removeEventListener('pointerdown',pointerFocus,{capture:true});});
 const before=()=>{if(dead)return;frameCpuStart=performance.now();frameGuiCpu=0;lastInput=input.sample(++tick);capturingFrame=false;const values=lastInput.players[0]!.actions;axis=values.find(v=>v.action==='MoveX')?.value??0;jump ||=values.some(v=>v.action==='Jump'&&v.pressed);audio.update(0);};
 const after=(event:{detail:{time:number;delta:number}})=>{if(dead)return;audio.update(Math.max(0,event.detail.delta));const diagnostics=getEngineDiagnosticsSnapshot(engine),frame={time:event.detail.time,rawDelta:event.detail.delta,cpuFrameMs:performance.now()-frameCpuStart,guiCpuMs:frameGuiCpu,diagnostics,guiRecords};if(coldStart.startupFrames.length<32)coldStart.startupFrames.push(frame);if(diagnostics.frame.counters.draws>0){coldStart.firstRenderedAt??=performance.now();if(completionPending.size<2){const index=diagnostics.frame.frame;completionPending.add(index);void engine.device.queue.onSubmittedWorkDone().then(()=>{coldStart.completedFrames.push({frame:index,completedAt:performance.now()});});}}options.onFrame?.(frame);};
 const completionPending=new Set<number>();
 const resize=()=>{guiRegion?.setBounds({x:0,y:0,width:side(),height:engine.displayHeight});if(engine.activeScene)resizers.get(engine.activeScene)?.();root.root.markDirty(GuiDirtyFlags.Layout);};
 const recover=()=>{current?.camera.reset();input.release();};engine.on('update',before);engine.on('after-update',after);engine.on('resize',resize);engine.on('device-restored',recover);
 rollback.push(()=>{engine.stop();engine.off('update',before);engine.off('after-update',after);engine.off('resize',resize);engine.off('device-restored',recover);});
 const dispose=async()=>{if(dead)return;dead=true;engine.stop();engine.off('update',before);engine.off('after-update',after);engine.off('resize',resize);engine.off('device-restored',recover);window.removeEventListener('keydown',key);window.removeEventListener('keyup',key);window.removeEventListener('blur',blur);canvas.removeEventListener('pointerdown',pointerFocus,{capture:true});flow.dispose();offCapture();offGui();input.dispose();profile.dispose();stopAudition();audio.dispose();breadcrumb.dispose();tabs.dispose();collapse.dispose();list.dispose();tree.dispose();for(const badge of badges)badge.dispose();layout.dispose();shell.destroy();engine.switchScene(null,{destroyPrevious:true});current=null;await engine.device.queue.onSubmittedWorkDone();atlasHandle.release();mixer.dispose();await saves.dispose();if(audioContext&&audioContext.state!=='closed')await audioContext.close();engine.destroy();};
 try{await menu();resize();engine.run();coldStart.readyAt=performance.now();}catch(error){await dispose();throw error;}
 return{engine,shell,root,gui,get guiRegion(){return guiRegion;},tabs,breadcrumb,badges,badgeButtons,collapse,name,list,tree,items,edits,rows,map,profile,input,mixer,audio,flow,coldStart,
  actions:{start,menu,cancel:()=>flow.cancel(),save,restore,unlock,audition,beginRebind,setGuiActive,selectTab:(index:number)=>tabs.activate('tab-'+index),setMutationPercent:(value:number)=>{if(![0,1,10].includes(value))throw new RangeError('Use 0, 1 or 10 percent.');mutationPercent=value;}},
  get level(){return current;},stats:()=>({dead,tick,polls,binding,transitioning,liveWorlds,peakWorlds,liveLevels,createdLevels,destroyedLevels,loads,releases,loading,peakLoading,guiRecords,badgeClicks,audioEnabled,audio:mixer.stats,list:list.stats,tree:tree.stats,lastInput}),dispose};
 } catch(error) {
  const failures:unknown[]=[];for(const close of rollback.reverse())try{await close();}catch(cleanupError){failures.push(cleanupError);}
  if(failures.length)throw new AggregateError([error,...failures],'Gameplay initialization and rollback failed.');throw error;
 }
}
