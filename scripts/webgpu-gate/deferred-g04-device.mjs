import {DeferredReferenceBackend,PbrRenderer,disposeSceneFrameGpuArena} from '../../artifacts/engine-0.2.1/g04/fixture.js';
const check=(v,m)=>{if(!v)throw Error(m);};
const host=device=>({device,format:'rgba16float',width:32,height:32,defaults:{},getDepthFormat:()=> 'depth24plus'});
export async function runG04Device(device,adapter){
 const requestDevice=async()=>{const next=await navigator.gpu.requestAdapter({powerPreference:new URLSearchParams(location.search).get('powerPreference')??'high-performance'});check(next&&next.info.vendor===adapter.info.vendor&&next.info.architecture===adapter.info.architecture&&!next.info.isFallbackAdapter,'replacement adapter mismatch');return next.requestDevice();};
 const replacement=await requestDevice(),cases=[],errors=[];replacement.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const renderer=new PbrRenderer();renderer.prepare(host(device));
 try{
  for(const algorithm of ['reference','tiled']){
   const options={failurePolicy:'forward',...(algorithm==='tiled'?{tiled:{forceCulling:true}}:{})},backend=new DeferredReferenceBackend(host(device),options);
   try{
    await backend.initialize(renderer);
    check(backend.record({context:{device:replacement},view:{key:'foreign'}})===false,'stale generation admitted');check(backend.diagnostics.reason==='device-generation'&&!backend.diagnostics.completeCoverage,'stale generation diagnostic');
    cases.push({algorithm,id:'injected-device-generation',diagnostics:{...backend.diagnostics},kind:'injected-reference-mismatch'});
   }finally{backend.destroy(true);}
   const cancelled=new DeferredReferenceBackend(host(device),options),pending=cancelled.initialize(renderer);cancelled.destroy(true);
   let message;try{await pending;throw Error('late initialization resurrected');}catch(error){message=String(error.message);check(/cancelled/.test(message),`unexpected cancellation ${message}`);}
   check(!cancelled._initialized&&cancelled._destroyed,'cancelled backend installed');cases.push({algorithm,id:'initialization-cancellation',cancelled:true});
  }
 }finally{renderer.destroy();disposeSceneFrameGpuArena(device);}
 const replacementRenderer=new PbrRenderer();replacementRenderer.prepare(host(replacement));
 const backend=new DeferredReferenceBackend(host(replacement),{failurePolicy:'strict',tiled:{forceCulling:true}});
 try{
  await backend.initialize(replacementRenderer);
  // GPUDevice.destroy resolves the genuine browser device.lost promise. This is an intentional
  // native loss, not evidence of spontaneous driver-reset recovery or preserved GPU simulation.
  replacement.destroy();const loss=await replacement.lost;check(loss.reason==='destroyed','unexpected native loss reason');
  backend.destroy(true);check(backend._destroyed&&backend._bindGroups.size===0&&backend.lastAttachments===undefined,'lost owner retained handles');
  cases.push({id:'native-device-lost',kind:'native-destroy',reason:loss.reason,ownerDestroyed:true});
 }finally{backend.destroy(true);replacementRenderer.destroy();disposeSceneFrameGpuArena(replacement);replacement.destroy();}
 check(!errors.length,errors.join('\n'));
 // Recovery is explicit reconstruction on a new device; GPU-only scene state is not restored.
 const fresh=await requestDevice(),freshRenderer=new PbrRenderer(),freshBackend=new DeferredReferenceBackend(host(fresh),{failurePolicy:'strict'});fresh.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 try{freshRenderer.prepare(host(fresh));await freshBackend.initialize(freshRenderer);check(freshBackend._initialized,'fresh device failed initialization');cases.push({id:'fresh-device-reinitialize',kind:'explicit-reconstruction',initialized:true});}
 finally{freshBackend.destroy(true);freshRenderer.destroy();disposeSceneFrameGpuArena(fresh);fresh.destroy();}
 check(!errors.length,errors.join('\n'));return {cases,secondaryValidationErrors:errors};
}
