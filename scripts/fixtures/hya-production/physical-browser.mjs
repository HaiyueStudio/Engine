import {HaiyueEngine, Entity} from '@haiyue/engine';
import {GuiRoot, GuiInput} from '@haiyue/engine/gui';
import {BrowserMultiplayerInput} from '@haiyue/engine/experimental/simulation';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
import {getSceneRenderPipeline} from '@haiyue/engine/experimental';
import {beginRenderCommandPass} from '@haiyue/engine/extension-authoring';
import {createHyaPlayer} from '@haiyue/extensions/hya-player';
import {createBrowserHyaAudioHost} from '@haiyue/extensions/hya-audio';
import {physicalGamepadReadiness} from '../../hya-corpus/physical-gamepad-readiness.mjs';

const profile=new URLSearchParams(location.search).get('profile'), smoke=new URLSearchParams(location.search).has('smoke');
const canvas=document.querySelector('canvas'), status=document.querySelector('#progress'), result=document.querySelector('#result');
const check=(v,m)=>{if(!v)throw Error(m);};
const events=[], commits=[], pendingCommitSnapshots=[], controls=[], failures=[], snapshots=[], hardware=[], leases=new Set();
let engine,scene,player,context,sampler,offPad,offUpdate,input,environment,validationDevice,done=false,sequence=1,pending=null,polls=0,padTick=0;
let lastPad=null,padPhase='waiting-focus';
const inputAudit={readySamples:0,sceneActionLeaks:0,unarmedGuiControls:0,transitions:[],lastSamples:[]};
const snapshot=()=>({time:performance.now(),data:player?.data.read({part:'data',id:'root'},['label']),display:input?.displayValue,
  composing:input?.isComposing,selection:[input?.selectionAnchor,input?.selectionFocus],focused:scene?.guiSystem.focus.focused===input,
  caret:scene?.guiSystem.getInputPresentation(input),commits:commits.length,viewport:[innerWidth,innerHeight]});
function finish(error){if(done)return;done=true;if(error)failures.push(String(error.stack??error));void cleanup();}
async function cleanup(){
  const release=async run=>{try{await run();}catch(error){failures.push(String(error.stack??error));}};
  try{
    await release(()=>engine?.stop());
    await release(()=>offUpdate?.());await release(()=>offPad?.());await release(()=>sampler?.dispose());
    await release(()=>player?.dispose());await release(()=>scene?.destroy());
    await release(()=>validationDevice?.queue.onSubmittedWorkDone());
    if(validationDevice)await release(async()=>{const error=await validationDevice.popErrorScope();if(error)throw error;});
    await release(()=>engine?.destroy());await release(()=>context?.close());
    const resources=engine?getEngineDiagnosticsSnapshot(engine).gpuResources:null;
    check(leases.size===0,'Resource leases remain');check(resources?.totals.resources===0,'Owned GPU resources remain');
    check(document.querySelectorAll('[data-haiyue-text-input]').length===0,'Native browser responder remains');
    result.textContent=JSON.stringify({status:failures.length?'failed':smoke?'setup-only':'awaiting-operator-confirmation',profile,
      smoke,events,commits,controls,snapshots,failures,polls,hardware,resources,leases:leases.size,inputAudit,
      physicalInputAccepted:false,environment});
    result.dataset.status=failures.length?'failed':'passed';
  }catch(error){result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),events,commits,controls,failures});result.dataset.status='failed';}
}
window.addEventListener('pagehide',()=>finish(Error('Window closed before qualification completed')),{once:true});
window.addEventListener('error',e=>finish(e.error??Error(e.message)));
for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','pointerdown']){
  document.addEventListener(type,event=>{
    if(!event.target?.matches?.('[data-haiyue-text-input]')&&type!=='pointerdown')return;
    if(events.length>=4096){finish(Error('Physical trace exceeded bounded event population'));return;}
    events.push({type,isTrusted:event.isTrusted,compositionData:event.data??null,inputType:event.inputType??null,key:event.key??null,
      responder:event.target?.dataset?.haiyueTextInput??null,nativeComposing:event.isComposing??null,keyCode:event.keyCode??null,
      button:event.button??null,buttons:event.buttons??null,...snapshot()});
  },true);
}
document.querySelector('#checkpoint').onclick=event=>{
  if(done||!event.isTrusted||!player)return;const state=snapshot();snapshots.push(state);
  status.textContent='Checkpoint '+snapshots.length+' saved. Value: '+JSON.stringify(state.data)+'; composing: '+state.composing;
};
document.querySelector('#finish').onclick=event=>{
  if(done||!event.isTrusted||!player)return;
  // Always transfer the raw run. The independent physical policy performs admission.
  // Throwing here would make the shared browser error handler discard the event population.
  snapshots.push(snapshot());finish();
};
try{
  engine=new HaiyueEngine({canvas,devicePixelRatio:1,msaaSamples:1,diagnostics:{enabled:true},clearColor:{r:.94,g:.94,b:.94,a:1}});await engine.init();
  const info=engine.adapter.info;environment={userAgent:navigator.userAgent,adapter:{vendor:info.vendor,architecture:info.architecture,description:info.description,device:info.device}};
  validationDevice=engine.device;validationDevice.pushErrorScope('validation');
  engine.device.addEventListener('uncapturederror',event=>finish(Error(event.error.message)));
  const manifest=await(await fetch('/g13-assets/manifest.json')).json(),bytes=new Map();
  for(const [id,a]of Object.entries(manifest.assets)){
    const b=new Uint8Array(await(await fetch('/g13-assets/'+a.file,{cache:'no-store'})).arrayBuffer());
    const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(v=>v.toString(16).padStart(2,'0')).join('');
    check(b.byteLength===a.bytes&&sha===a.sha256,'Asset integrity mismatch: '+id);bytes.set(id,b);
  }
  const sceneBytes=await(await fetch('/g13-assets/scene.json',{cache:'no-store'})).arrayBuffer();
  const sceneSha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',sceneBytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  check(sceneSha===manifest.scene.sha256,'Seven-part scene integrity mismatch');
  const source=JSON.parse(new TextDecoder().decode(sceneBytes));
  // The fixed Native scene remains the seven-part source; only the test control actions are added.
  if(profile==='physical-gamepad'){
    const interaction=source.parts.find(p=>p.id==='interaction').document;
    for(const [id,control,phase,value]of [['down','button:0','down','AAA'],['up','button:0','up','AA'],['axis','axis:0','change',null]])
      interaction.listeners.push({id:'g13-'+id,target:'field',event:'gamepad',gamepad:{control,phase},phases:['target'],
        actions:[...(value?[{kind:'data-set',binding:'write-label',value}]:[]),{kind:'custom',protocol:'g13.physical@1',port:id}]});
  }
  const resources={async acquire(request){const id=request.asset==='core-image'?'alternate':request.asset,a=manifest.assets[id];
    check(a&&a.integrity===request.integrity&&!request.signal.aborted,'Undeclared or aborted resource');const lease={};leases.add(lease);
    return{value:bytes.get(id).slice(),generation:1,bytes:a.bytes,release(){leases.delete(lease);}};}};
  context=new AudioContext();const audio=await createBrowserHyaAudioHost(context);
  const pendingControls=[];
  const actions={begin(){pendingControls.length=0;},invoke(action,event){if(profile==='physical-gamepad'&&padPhase!=='ready')inputAudit.unarmedGuiControls++;pendingControls.push({port:action.port,target:event.target,...event.gamepad,time:performance.now()});},
    commit(){controls.push(...pendingControls);pendingControls.length=0;},rollback(){pendingControls.length=0;}};
  scene=engine.createScene({name:'G13 actual packed seven-part input',render3D:false,render2D:false,
    gui:{loadOp:'load',textInputHost:'browser'},view:{clearColor:{r:.94,g:.94,b:.94,a:1}}});
  getSceneRenderPipeline(scene).add({record(_world,ctx){const{passEncoder,ownsPass}=beginRenderCommandPass(ctx);if(ownsPass)passEncoder.end();}},
    {order:-1,pass:'isolated',loadOp:'clear',depth:false});
  const root=new GuiRoot();scene.add(new Entity('G13 input root').addComponent(root));
  if(profile==='physical-gamepad'){
    sampler=new BrowserMultiplayerInput({getGamepads:()=>{polls++;const pads=navigator.getGamepads();lastPad=pads[0]??null;for(const pad of pads)if(pad?.connected&&!hardware.some(h=>h.index===pad.index&&h.id===pad.id)){check(hardware.length<16,'Too many hardware identities');hardware.push({id:pad.id,index:pad.index,mapping:pad.mapping,buttons:pad.buttons.length,axes:pad.axes.length});}return pads;},players:[{id:'scene',gamepadIndex:0,
      bindings:{jump:{gamepadButtons:[0]},move:{gamepadAxes:[{axis:0,deadZone:.001}]}}}]});
    offPad=scene.guiSystem.attachGamepadInput(sampler);
  }
  player=await createHyaPlayer(source,{mode:'render',scene,root,gui:scene.guiSystem,viewport:[480,360],dpr:1,
    host:{resources,audio,actions,capabilities:new Set(source.parts.map(p=>p.extension)),invalidate(){},diagnostic:d=>finish(Error(d.message))}});
  const initial={sequence:1,deltaSeconds:0,viewport:[480,360],dpr:1},deadline=performance.now()+30000;
  while(!player.advance(initial).ready){check(performance.now()<deadline,'Scene resources not ready');await new Promise(r=>setTimeout(r,0));}
  const walk=node=>{if(node instanceof GuiInput){check(!input,'Duplicate editable owner');input=node;}for(const c of node.children)walk(c);};walk(root.root);
  check(input,'Automatic G06 input missing');
  // Data observers run before GUI publication; inspect the editor only after advance returns.
  player.data.subscribe(changes=>{
    const record={time:performance.now(),data:player.data.read({part:'data',id:'root'},['label']),changes};
    commits.push(record);pendingCommitSnapshots.push(record);
  });
  const update=event=>{if(done)return;try{
    if(sampler){
      const sample=sampler.sample(++padTick),focused=scene.guiSystem.focus.focused===input,
        next=physicalGamepadReadiness(padPhase,{focused,foreground:document.hasFocus()&&!document.hidden,connected:lastPad?.connected===true,
          buttons:lastPad?.buttons.map(button=>button.value)??[],axes:lastPad?.axes??[]});
      if(next!==padPhase){
        check(inputAudit.transitions.length<256,'Too many focus transitions');inputAudit.transitions.push({from:padPhase,to:next,tick:padTick,time:performance.now()});padPhase=next;
        status.textContent=next==='ready'?'READY: hold A about one second, release; left stick left, right, center. Then Save evidence.':next==='waiting-focus'?'Click the HYA text to focus it; release all controls, then wait for READY.':next==='waiting-controller'?'Connect the controller, release controls and keep HYA text focused.':'Release all buttons and center the sticks; waiting for a neutral start.';
      }
      inputAudit.lastSamples.push({tick:padTick,phase:padPhase,focused,foreground:document.hasFocus(),axes:[...(lastPad?.axes??[])],actions:sample.players[0].actions});
      if(inputAudit.lastSamples.length>32)inputAudit.lastSamples.shift();
      if(padPhase==='ready'){inputAudit.readySamples++;const leaked=sample.players[0].actions.some(a=>a.value!==0);if(leaked)inputAudit.sceneActionLeaks++;
        check(!leaked,'GUI input leaked to scene while original HYA editor owned focus');}
    }
    pending??={sequence:++sequence,deltaSeconds:Math.max(0,event.detail.delta)/1000,viewport:[480,360],dpr:1};
    if(player.advance(pending).ready){pending=null;for(const record of pendingCommitSnapshots.splice(0))record.presentation=snapshot();}
    if(input.isComposing)check(player.data.read({part:'data',id:'root'},['label'])===commits.at(-1)?.data||commits.length===0,'Preedit changed committed data');
  }catch(error){finish(error);}};
  engine.on('update',update);offUpdate=()=>engine.off('update',update);
  engine.switchScene(scene);engine.run();
  window.g13Physical={ready:true,snapshot,finishSmoke:()=>{check(smoke,'Smoke completion is not available in manual runs');finish();}};
  status.textContent=profile==='browser-real-ime'?'Click HYA text at (20,180). Ctrl+A, real IME nihao → 你好, then save checkpoint. Begin composition and Esc, save checkpoint. Resize/focus/caret inspection, save checkpoint. Finally Save evidence.':
    'Click HYA text first; release all controls and wait for READY. Hold A about one second and release; left stick left, right, then center. Save evidence.';
}catch(error){finish(error);}
