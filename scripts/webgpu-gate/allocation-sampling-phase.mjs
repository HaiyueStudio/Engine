/** Explicit fixture handshake excludes setup, warmup, readback and cleanup from sampling. */
export async function captureAllocationPhase(cdp, waitFor, options, timeoutMs) {
 if(options.phase!=='fixture-steady-state-v1')throw Error('Unknown allocation sampling phase');
 const ready=state=>async()=>{
  const response=await cdp.call('Runtime.evaluate',{expression:`(() => {const r=document.querySelector('#result');if(r?.dataset.status==='failed')throw Error(r.textContent);return globalThis.__webgpuAllocationPhase?.state===${JSON.stringify(state)};})()`,returnByValue:true});
  if(response.result?.exceptionDetails)throw Error(`Allocation fixture failed: ${response.result.exceptionDetails.exception?.description??response.result.exceptionDetails.text}`);
  return response.result?.result?.value===true;
 };
 const resume=async()=>{
  const response=await cdp.call('Runtime.evaluate',{expression:'globalThis.__webgpuAllocationPhase.resume()',returnByValue:true});
  if(response.result?.exceptionDetails)throw Error('Allocation phase resume failed');
 };
 await waitFor(ready('ready'),timeoutMs,'allocation warmup');
 await cdp.call('HeapProfiler.startSampling',{samplingInterval:options.samplingInterval??32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
 await resume();
 let profile;
 try{await waitFor(ready('done'),timeoutMs,'allocation frames');}
 finally{profile=(await cdp.call('HeapProfiler.stopSampling')).result?.profile;}
 if(!profile?.head||!Array.isArray(profile.samples))throw Error('Missing allocation profile');
 await resume();
 return profile;
}
