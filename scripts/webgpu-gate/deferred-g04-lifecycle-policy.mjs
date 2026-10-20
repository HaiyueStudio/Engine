export function validateG04Lifecycle(result){
 if(result.schemaVersion!==1||result.status!=='passed')throw Error('G04 lifecycle failed');
 if(result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw Error('Native adapter required');
 if(!Array.isArray(result.validationErrors)||result.validationErrors.length)throw Error('Validation errors');
 if(result.cleanup?.ownerResidual!==0||result.cleanup?.liveGpuResources!==0)throw Error('Resource residue');
 if(result.lightingAo!==true)throw Error('Lighting AO lifecycle coverage required');
 if(result.switches!==312||result.profileChanges!==57||result.warmupSwitches!==24||result.allocations?.length!==312||result.samples?.length!==46)throw Error('Incomplete lifecycle matrix');
 for(const [i,s] of result.allocations.entries())if(s.step!==i||s.views!==(i%6===4?3:4)||!(s.buffers>0)||!(s.textures>0)||!(s.bufferBytes>0)||!(s.textureBytes>0))throw Error('Invalid allocation sample');
 for(const key of ['buffers','textures','bufferBytes','textureBytes']){const warm=Math.max(...result.allocations.slice(0,12).map(s=>s[key])),later=Math.max(...result.allocations.slice(12).map(s=>s[key]));if(!Number.isFinite(warm)||later>warm||result.highWater?.[key]?.warm!==warm||result.highWater[key].later!==later)throw Error('Unbounded resources');}
 if(result.viewRetirement?.frames!==121||result.viewRetirement.remainingHistories!==1)throw Error('Expired view history residue');
 for(const s of result.samples)if(!Number.isFinite(s.maxDelta)||s.maxDelta<0||s.maxDelta>3/255||s.lit<=50)throw Error('Invalid lifecycle pixels');
}
