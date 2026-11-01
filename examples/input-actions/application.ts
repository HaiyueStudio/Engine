import {HaiyueEngine} from '@haiyue/engine';
import {Entity,System} from '@haiyue/engine/ecs';
import {Mesh2D,Transform2D} from '@haiyue/engine/components';
import {createRect2D} from '@haiyue/engine/geometry';
import {Material2D} from '@haiyue/engine/material';
import {ColorSRGB} from '@haiyue/engine/color';
import {Mesh2DRenderSystem} from '@haiyue/engine/systems';
import {GuiRoot,GuiLabel,GuiButton,GuiSystem} from '@haiyue/engine/gui';
import {InputActionMap} from '@haiyue/engine/input';
import {BrowserMultiplayerInput} from '@haiyue/engine/experimental/simulation';
import type {StandardGamepadSnapshot} from '@haiyue/engine/input';
import type {MultiplayerInputSnapshot} from '@haiyue/engine/experimental/simulation';
import {GameSaveService,LocalStorageSaveBackend} from '@haiyue/engine/save';
import type {GameSaveBackend} from '@haiyue/engine/save';
import {createInputBindingProfile} from '@haiyue/extensions/input-actions';
import type {InputBindingProfileData} from '@haiyue/extensions/input-actions';

/** The same source is strictly compiled against real installed tarballs. */
export async function createInputExample(canvas:HTMLCanvasElement,options:{getGamepads?:()=>ArrayLike<StandardGamepadSnapshot|null>;eventTarget?:EventTarget;backend?:GameSaveBackend}={}){
  const coldStart={startedAt:performance.now(),readyAt:0};
  const engine=new HaiyueEngine({canvas,msaaSamples:1,timestampQuery:false,diagnostics:{enabled:true},clearColor:{r:.025,g:.035,b:.055,a:1}});await engine.init();
  const scene=engine.createScene({name:'Input settings',camera:{type:'2d',camera2D:{designWidth:960,designHeight:640,viewportMode:'fixed'}},render2D:false,render3D:false,gui:false});
  const map=InputActionMap.standardGameplay(),target=options.eventTarget??window;
  const saves=new GameSaveService<InputBindingProfileData>({gameId:'engine-input-profile-example',dataVersion:1,backend:options.backend??new LocalStorageSaveBackend({namespace:'haiyue-engine-examples'}),ownsBackend:options.backend===undefined,maxSlots:1});
  const root=new GuiRoot({theme:{fontSize:15,radius:6}}),status=root.add(new GuiLabel({x:24,y:390,width:900,height:28,text:'Choose a binding or select Play.'}));
  root.add(new GuiLabel({x:24,y:24,width:700,height:34,text:'INPUT ACTIONS',fontSize:23}));
  const valueLabel=root.add(new GuiLabel({x:24,y:445,width:900,height:28,text:'MoveX 0.00  MoveY 0.00'}));
  const bindingLabel=root.add(new GuiLabel({x:24,y:480,width:900,height:26,text:'Keyboard: A/D or arrows. Gamepad: left stick.'}));
  for(const [i,text] of ['Rebind: release the opener, then press a new control.','Escape cancels capture. Conflicts keep the previous binding.','Save / Restore use the existing game-save service.','Play hides settings; F1 brings them back.'].entries())root.add(new GuiLabel({x:24,y:525+i*23,width:900,height:22,text,fontSize:14}));
  const markerTransform=new Transform2D({x:210,y:0}),marker=new Entity('Action-controlled marker').addComponent(markerTransform).addComponent(new Mesh2D(createRect2D({width:54,height:54}),new Material2D({color:new ColorSRGB(.2,.72,.98,1)})));scene.add(marker);
  scene.addSystem(new Mesh2DRenderSystem(engine,scene.cameraEntity));
  const gui=new GuiSystem(engine,{roots:new Set([root])});scene.add(new Entity('Settings').addComponent(root));scene.addSystem(gui);
  let binding=false,frameCapture=false,disposed=false,tick=0,polls=0,changes=0,statusText=status.text,last:MultiplayerInputSnapshot|undefined;
  const message=(text:string)=>{if(!disposed){statusText=text;status.text=text;}};
  const profile=createInputBindingProfile({map,onChange:()=>{binding=false;changes++;message('Binding updated. Save to keep this profile.');},onConflict:detail=>message('Already bound to '+detail.otherActions.join(', ')+'. Choose another control.')});
  const input=new BrowserMultiplayerInput({eventTarget:target,players:[{id:'player',bindings:map,gamepadIndex:0}],getGamepads:()=>{
    polls++;frameCapture=binding;const pads=options.getGamepads?.()??(typeof navigator.getGamepads==='function'?navigator.getGamepads():[]);
    if(binding){const pad=pads[0]??{connected:false,buttons:[],axes:[]};try{profile.offer({device:'gamepad',index:0,snapshot:pad});}catch(error){message(error instanceof Error?error.message:String(error));}}
    return pads;
  }});
  const offGui=gui.attachGamepadInput(input),offCapture=input.addGamepadRoute(()=>frameCapture||binding);
  const begin=(action:string,kind:'button'|'negative'|'positive')=>{input.release();profile.beginRebind(action,kind);binding=true;message('Release controls, then choose '+action+' ('+kind+'). Escape cancels.');};
  const settings=(visible:boolean)=>{if(binding){profile.cancelRebind();binding=false;}root.root.visible=visible;gui.focus.blur();input.release();message(visible?'Settings open.':'Play: arrows / A D / gamepad. F1 opens settings.');};
  const save=async()=>{await saves.save({saveId:'controls',name:'Input bindings',data:profile.exportData()});message('Input profile saved.');};
  const restore=async()=>{const saved=await saves.load('controls');if(disposed)return;if(!saved){message('No saved profile yet.');return;}input.release();profile.restore(saved.data);message('Saved input profile restored.');};
  const run=(job:()=>Promise<void>)=>{void job().catch(error=>message(error instanceof Error?error.message:String(error)));};
  const buttons=[
    root.add(new GuiButton({x:24,y:80,width:300,height:36,text:'Rebind Move left',onClick:()=>begin('MoveX','negative')})),
    root.add(new GuiButton({x:24,y:126,width:300,height:36,text:'Rebind Move right',onClick:()=>begin('MoveX','positive')})),
    root.add(new GuiButton({x:24,y:172,width:300,height:36,text:'Rebind Jump',onClick:()=>begin('Jump','button')})),
    root.add(new GuiButton({x:24,y:218,width:145,height:36,text:'Save',onClick:()=>run(save)})),
    root.add(new GuiButton({x:179,y:218,width:145,height:36,text:'Restore',onClick:()=>run(restore)})),
    root.add(new GuiButton({x:24,y:264,width:300,height:36,text:'Play (F1: settings)',onClick:()=>settings(false)})),
  ];
  const onKey=(event:Event)=>{
    const key=event as KeyboardEvent;
    if(key.type==='keydown'&&key.code==='F1'&&!key.repeat){event.preventDefault();settings(!root.root.visible);return;}
    if(!binding||key.repeat)return;
    if(key.type==='keydown'&&key.code==='Escape'){profile.cancelRebind();binding=false;input.release();message('Rebind cancelled.');return;}
    try{profile.offer({device:'keyboard',code:key.code,down:key.type==='keydown'});}catch(error){message(error instanceof Error?error.message:String(error));}finally{input.release();}
  };
  const onPointer=(event:Event)=>{if(!binding)return;const pointer=event as PointerEvent;if(pointer.button<0)return;try{profile.offer({device:'pointer',button:pointer.button,down:pointer.type==='pointerdown'});}catch(error){message(error instanceof Error?error.message:String(error));}finally{input.release();}};
  const onBlur=()=>{profile.cancelRebind();binding=false;};
  target.addEventListener('keydown',onKey);target.addEventListener('keyup',onKey);target.addEventListener('pointerdown',onPointer);target.addEventListener('pointerup',onPointer);target.addEventListener('blur',onBlur);
  const step=(delta=1000/60)=>{
    if(disposed)return last;
    last=input.sample(++tick);frameCapture=false;
    const values=new Map(last.players[0]!.actions.map(action=>[action.action,action.value])),x=values.get('MoveX')??0,y=values.get('MoveY')??0;
    const dt=Math.max(0,Number.isFinite(delta)?delta:0)/1000;
    markerTransform.x=Math.max(40,Math.min(420,markerTransform.x+x*150*dt));markerTransform.y=Math.max(-100,Math.min(180,markerTransform.y-y*150*dt));
    valueLabel.text='MoveX '+x.toFixed(2)+'  MoveY '+y.toFixed(2)+'  Jump '+(values.get('Jump')??0).toFixed(0)+'  Fire '+(values.get('Fire')??0).toFixed(0);
    const move=map.toJSON().MoveX?.keyboardAxes?.[0];bindingLabel.text='Left: '+(move?.negative.join(' / ')??'unbound')+'   Right: '+(move?.positive.join(' / ')??'unbound');return last;
  };
  const frame=new System(entity=>entity===marker,(_world,_time,delta)=>{step(delta);});scene.addSystem(frame,false);
  const dispose=async()=>{if(disposed)return;disposed=true;binding=false;profile.dispose();offCapture();offGui();input.dispose();target.removeEventListener('keydown',onKey);target.removeEventListener('keyup',onKey);target.removeEventListener('pointerdown',onPointer);target.removeEventListener('pointerup',onPointer);target.removeEventListener('blur',onBlur);scene.destroy();engine.destroy();await saves.dispose();};
  engine.switchScene(scene).run();coldStart.readyAt=performance.now();
  return{engine,scene,map,profile,input,gui,root,marker,markerTransform,buttons,step,dispose,coldStart,actions:{begin,settings,save,restore,cancel:()=>{profile.cancelRebind();binding=false;input.release();}},stats:()=>({tick,polls,changes,binding,status:statusText,last})};
}
