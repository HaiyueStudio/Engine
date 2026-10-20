import {Render3DSystem,Entity,createDeferredReferenceProfile,disposeSceneFrameGpuArena} from '../../artifacts/engine-0.2.1/g05/fixture.js';
import {G05_LOW_LIMIT_CASES,validateG05LowLimits} from './deferred-g05-low-limits-policy.mjs';
import {observeForwardAllocations} from './deferred-g05-forward-allocation.mjs';
const node=document.querySelector('#result'),check=(v,m)=>{if(!v)throw Error(m);};
try{
 const preference=new URLSearchParams(location.search).get('powerPreference')??'high-performance',adapter=await navigator.gpu.requestAdapter({powerPreference:preference});
 check(adapter&&!adapter.info.isFallbackAdapter,'Native adapter required');const cases=[],validationErrors=[];
 for(const c of G05_LOW_LIMIT_CASES)for(const algorithm of c.algorithms){
  document.querySelector('#progress').textContent=`${c.key}/${algorithm}`;
  const caseAdapter=await navigator.gpu.requestAdapter({powerPreference:preference});
  check(caseAdapter&&caseAdapter.info.vendor===adapter.info.vendor&&caseAdapter.info.architecture===adapter.info.architecture&&!caseAdapter.info.isFallbackAdapter,'Adapter changed during matrix');
  const device=await caseAdapter.requestDevice({requiredLimits:{[c.key]:c.requested}}),audit=observeForwardAllocations(device),actual=device.limits[c.key];
  let system,row;device.addEventListener('uncapturederror',e=>validationErrors.push(e.error.message));device.pushErrorScope('validation');
  try{
   if(actual>=c.required){
    row={status:'unavailable',key:c.key,algorithm,requested:c.requested,actual,limitSource:'native-device.limits',reason:'native-limit-at-or-above-engine-requirement',deferredCreated:audit.snapshot().deferredCreated,deviceDestroyed:false};
    const error=await device.popErrorScope();if(error)validationErrors.push(error.message);
   }else{
   const host={device,format:'rgba16float',width:32,height:32,defaults:{},getDepthFormat:()=> 'depth24plus'};
   system=new Render3DSystem(host,new Entity('low-limit-camera'));const options=algorithm==='tiled'?{tiled:{}}:{};
   let strict;try{await createDeferredReferenceProfile(system,host,{...options,failurePolicy:'strict'});throw Error('Unsupported strict profile accepted');}
   catch(error){strict={code:error.code,reason:error.reason,observed:error.observed,supported:error.supported};check(error.code==='E_DEFERRED_LIGHTING_CAPABILITY','Wrong rejection: '+String(error));}
   const fallback=await createDeferredReferenceProfile(system,host,{...options,failurePolicy:'forward'});
   row={status:'passed',key:c.key,algorithm,requested:c.requested,actual,limitSource:'native-device.limits',strict,forward:{...fallback.backend.diagnostics,recordResult:fallback.backend.record({})},deferredCreated:audit.snapshot().deferredCreated,deviceDestroyed:false,systemDestroyed:false};
   const error=await device.popErrorScope();if(error)validationErrors.push(error.message);
   }
  }finally{system?.destroy();disposeSceneFrameGpuArena(device);device.destroy();await device.lost;if(row){if(system)row.systemDestroyed=true;row.deviceDestroyed=true;}}
  cases.push(row);
 }
 const result={schemaVersion:1,suite:'g05-native-low-limits',status:cases.some(c=>c.status==='unavailable')?'unavailable':'passed',physicalLowLimitQualified:cases.every(c=>c.status==='passed'),adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},cases,validationErrors};validateG05LowLimits(result);node.textContent=JSON.stringify(result);node.dataset.status=result.status;
}catch(error){node.textContent=JSON.stringify({schemaVersion:1,status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
