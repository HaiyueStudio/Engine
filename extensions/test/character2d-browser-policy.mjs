export const profile=Object.freeze({shapes:['box','circle'],cadences:[30,60,120,144],ticks:120,warmupFrames:12,resourceCycles:20,characters:32,obstacles:128,pressureFrames:600});
export function validateCharacterBrowserResult(result){
 const errors=[];
 const gpu=g=>g&&Number.isSafeInteger(g.resources)&&g.resources>=0&&Number.isSafeInteger(g.estimatedBytes)&&g.estimatedBytes>=0;
 const vector=v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite);
 const shapes=Array.isArray(result?.shapes)?result.shapes:[];
 if(result?.status!=='passed'||result.qualification!==false||shapes.length!==2)errors.push('missing two complete feature runs');
 for(const shape of profile.shapes){
  const run=shapes.find(r=>r?.shape===shape);
  if(!run||!Array.isArray(run.cadences)||run.cadences.length!==4||!Array.isArray(run.samples)||run.samples.length!==20||!gpu(run.baseline)||run.finalGpu?.resources!==0||run.finalGpu?.estimatedBytes!==0||run.worlds?.activeWorlds!==0||run.worlds?.totalWorlds!==1||run.adapter?.isFallbackAdapter!==false||run.recoveredAdapter?.isFallbackAdapter!==false) {errors.push('incomplete shape: '+shape);continue;}
  const reference=run.cadences[0];
  for(const hz of profile.cadences){const c=run.cadences.find(c=>c?.hz===hz);if(!c||c.tickDelta!==120||!c.grounded||c.stuck||!c.physicalUnaffectedByPresentation||!vector(c.position)||!vector(reference?.position)||c.position.some((v,i)=>Math.abs(v-reference.position[i])>1e-6))errors.push('cadence failed: '+shape+'/'+hz);}
  for(const sample of run.samples)if(!gpu(sample?.gpu)||sample.gpu.resources>run.baseline.resources||sample.gpu.estimatedBytes>run.baseline.estimatedBytes||sample.physics?.bodies!==5||sample.worlds!==1||sample.releasedOwnerResiduals!==0)errors.push('resource growth: '+shape);
  if(!run.recoveryReset||!Array.isArray(run.gpuErrors)||run.gpuErrors.length!==0)errors.push('recovery or GPU validation failed: '+shape);
 }
 const p=result?.pressure;
 if(!p||p.characters!==32||p.obstacles!==128||p.frames!==600||p.createdWorlds!==1||p.destroyedWorlds!==1||p.beforeDestroy?.bodies!==160||p.afterDestroy?.bodies!==0||p.afterDestroy?.colliders!==0||p.afterDestroy?.joints!==0||p.afterDestroy?.activeContacts!==0||!Array.isArray(p.grounded)||!p.grounded.every(Boolean)||p.grounded.length!==32)errors.push('production pressure workload incomplete');
 return{status:errors.length?'failed':'passed',errors};
}
