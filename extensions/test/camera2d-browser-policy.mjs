export const profile=Object.freeze({sampleCounts:[1,4],cadences:[30,60,120,144],durationMs:1000,warmupFrames:12,resourceCycles:20,characters:32,obstacles:128,pressureFrames:600});
export function validateCameraBrowserResult(r){
 const errors=[],vector=v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite),gpu=g=>g&&Number.isSafeInteger(g.resources)&&g.resources>=0&&Number.isSafeInteger(g.estimatedBytes)&&g.estimatedBytes>=0;
 if(r?.status!=='passed'||r.qualification!==false||!profile.sampleCounts.includes(r.sampleCount)||r.adapter?.isFallbackAdapter!==false||r.recoveredAdapter?.isFallbackAdapter!==false)errors.push('missing hardware feature run');
 const cadences=Array.isArray(r?.cadences)?r.cadences:[];
 if(cadences.length!==4)errors.push('missing cadence cohorts');
 for(const hz of profile.cadences){const c=cadences.find(c=>c?.hz===hz);if(!c||c.frames!==hz||c.durationMs!==1000||c.physicalUntouched!==true||!vector(c.position)||Math.abs(c.position[0]-250*(1-Math.exp(-8)))>1e-7||Math.abs(c.position[1]-70*(1-Math.exp(-8)))>1e-7)errors.push('cadence failed: '+hz);}
 if(r?.gui?.pixelDifferences!==0||r?.gui?.redrawsDuringCameraMove!==0||!(r?.gui?.litPixels>1000)||!(r?.gui?.worldPixelDifferences>100)||r?.gui?.pointerAccepted!==true||r?.gui?.coordinatesValid!==true||r?.gui?.physicsUntouched!==true||r?.gui?.floorOracle!==true||r?.gui?.backgroundOracle!==true)errors.push('camera/GUI coordinate or pixel failure');
 if(!gpu(r?.baseline)||!Array.isArray(r?.samples)||r.samples.length!==20)errors.push('missing resource workload');
 for(const sample of Array.isArray(r?.samples)?r.samples:[])if(!gpu(sample?.gpu)||!gpu(r?.baseline)||sample.gpu.resources>r.baseline.resources||sample.gpu.estimatedBytes>r.baseline.estimatedBytes||sample.worlds!==1||sample.bodies!==5||sample.releasedOwnerResiduals!==0||sample.cachedRegions>8||!Number.isFinite(sample.retainedColorBytes)||sample.retainedColorBytes>64*1048576)errors.push('resource growth');
 if(r?.recoveryReset!==true||r?.projectionMatches!==true||!Array.isArray(r?.gpuErrors)||r.gpuErrors.length||r?.worlds?.activeWorlds!==0||r?.worlds?.totalWorlds!==1||r?.finalGpu?.resources!==0||r?.finalGpu?.estimatedBytes!==0)errors.push('recovery, projection or teardown failure');
 const p=r?.pressure;if(!p||p.characters!==32||p.obstacles!==128||p.frames!==600||p.createdWorlds!==1||p.destroyedWorlds!==1||p.beforeDestroy?.bodies!==160||p.afterDestroy?.bodies!==0||p.afterDestroy?.colliders!==0||p.afterDestroy?.joints!==0||p.afterDestroy?.activeContacts!==0||p.physicsUntouched!==true||!Array.isArray(p.grounded)||p.grounded.length!==32||!p.grounded.every(Boolean))errors.push('combined character-camera pressure incomplete');
 return{status:errors.length?'failed':'passed',errors};
}
