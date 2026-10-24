import {Entity,HaiyueEngine} from '@haiyue/engine';
import {GuiRoot,GuiButton,GuiInput} from '@haiyue/engine/gui';
import {getSceneRenderPipeline} from '@haiyue/engine/experimental';
import {beginRenderCommandPass,type RenderCommandContext} from '@haiyue/engine/extension-authoring';
import {createHyaPlayer,type HyaPlayer,type HyaFrameRequest,type HyaResourcePort} from '@haiyue/extensions/hya-player';

interface Asset {file:string;bytes:number;sha256:string;integrity:string;}
const canvas=document.querySelector<HTMLCanvasElement>('#canvas')!;
const status=document.querySelector<HTMLOutputElement>('#status')!;
const engine=new HaiyueEngine({canvas,clearColor:{r:240/255,g:240/255,b:240/255,a:1}});
const abort=new AbortController();let player:HyaPlayer|null=null,disposed=false;
let liveResources=0;
const cleanup=()=>{if(disposed)return;disposed=true;abort.abort();try{player?.dispose();}finally{player=null;engine.destroy();}};
window.addEventListener('pagehide',cleanup,{once:true});

async function main():Promise<void>{
  await engine.init();
  const readJson=async(path:string)=>{const response=await fetch(path,{signal:abort.signal});if(!response.ok)throw new Error('Cannot load '+path);return response.json();};
  const manifest=await readJson('./assets.json') as {assets:Record<string,Asset>;scene:{sha256:string}};
  const verified=new Map<string,Uint8Array>();
  for(const[id,descriptor]of Object.entries(manifest.assets)){
    if(!/^[a-zA-Z0-9.-]+$/.test(descriptor.file))throw new Error('Invalid asset filename.');
    const response=await fetch('./'+descriptor.file,{signal:abort.signal});if(!response.ok)throw new Error('Cannot load '+descriptor.file);
    const bytes=await response.arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
    if(hash!==descriptor.sha256||bytes.byteLength!==descriptor.bytes)throw new Error('Asset integrity mismatch: '+id);
    verified.set(id,new Uint8Array(bytes));
  }
  const resources:HyaResourcePort={async acquire(request){
    if(abort.signal.aborted||request.signal.aborted)throw new Error('Resource acquisition aborted.');
    const id=request.asset==='core-image'?'alternate':request.asset,descriptor=manifest.assets[id],bytes=verified.get(id);
    if(!descriptor||!bytes||request.integrity!==descriptor.integrity)throw new Error('Undeclared resource: '+request.asset);
    const value=bytes.slice();let released=false;++liveResources;
    return{value,generation:1,bytes:value.byteLength,release(){if(!released){released=true;--liveResources;}}};
  }};
  const sceneResponse=await fetch('./scene.json',{signal:abort.signal});if(!sceneResponse.ok)throw new Error('Cannot load scene.json');
  const sceneBytes=await sceneResponse.arrayBuffer();
  const sceneHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',sceneBytes)),value=>value.toString(16).padStart(2,'0')).join('');
  if(sceneHash!==manifest.scene.sha256)throw new Error('Scene integrity mismatch.');
  const source=JSON.parse(new TextDecoder().decode(sceneBytes)) as {parts:readonly {extension:string}[]};
  const scene=engine.createScene({name:'HYA composition',render3D:false,render2D:false,view:{clearColor:{r:240/255,g:240/255,b:240/255,a:1}},gui:{loadOp:'load',textInputHost:'browser',font:{chars:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 你好世界•/():;,.?!-_|'}}});
  getSceneRenderPipeline(scene).add({record(_world:unknown,context:RenderCommandContext){const{passEncoder,ownsPass}=beginRenderCommandPass(context);if(ownsPass)passEncoder.end();}},{order:-1,pass:'isolated',loadOp:'clear',depth:false});
  const root=new GuiRoot();scene.add(new Entity('HYA controls').addComponent(root));
  player=await createHyaPlayer(source,{mode:'render',scene,gui:scene.guiSystem!,root,viewport:[engine.displayWidth,engine.displayHeight],dpr:devicePixelRatio,signal:abort.signal,
    host:{resources,capabilities:new Set(source.parts.map(part=>part.extension)),invalidate(){},diagnostic(value){status.textContent=value.message;}}});
  if(disposed){player.dispose();return;}
  const current=player;
  // Prepare one fixed zero-delta frame before activating its draw owner.
  const initial:HyaFrameRequest={sequence:1,deltaSeconds:0,viewport:[engine.displayWidth,engine.displayHeight],dpr:devicePixelRatio};
  const deadline=performance.now()+30000;
  status.textContent='Preparing first HYA frame…';
  while(!current.advance(initial).ready){
    if(abort.signal.aborted)throw new Error('Scene preparation aborted.');
    if(performance.now()>=deadline)throw new Error('Required scene resources did not become ready.');
    await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  root.add(new GuiInput({x:12,y:'82%',width:190,height:38,value:'你好 A',onChange:value=>current.data?.run(write=>write.set({part:'data',id:'root'},['label'],value))}));
  root.add(new GuiButton({x:214,y:'82%',width:126,height:38,text:'Pause / Resume',onClick:()=>{if(current.status==='paused')current.resume();else current.pause();}}));
  root.add(new GuiButton({x:352,y:'82%',width:120,height:38,text:'Toggle state',onClick:()=>{const go=current.data?.read({part:'data',id:'root'},['go']);current.data?.run(write=>write.set({part:'data',id:'root'},['go'],!go));}}));
  let sequence=1,pending:HyaFrameRequest|null=null;
  engine.on('update',event=>{
    if(disposed)return;
    try{
      pending??={sequence:++sequence,deltaSeconds:sequence===1?0:Math.max(0,event.detail.delta)/1000,viewport:[engine.displayWidth,engine.displayHeight],dpr:devicePixelRatio};
      const frame=current.advance(pending);
      if(frame.ready){pending=null;status.textContent=`HYA ${current.status} · frame ${frame.sequence} · ${liveResources} resource leases`;status.dataset.state='ready';}
    }catch(error){status.textContent=String(error);status.dataset.state='error';cleanup();}
  });
  engine.switchScene(scene);
  engine.run();
}
void main().catch(error=>{status.textContent=String(error);status.dataset.state='error';cleanup();});
