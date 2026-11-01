export const audioCpuProfile=Object.freeze({voices:[32,128],owners:4,perOwner:32,warmup:12,samples:30,rounds:3,operationsPerSample:200,reverseRound:2});
export function audioCpuOrder(){return[1,2,3].flatMap(round=>(round===2?[128,32]:[32,128]).flatMap(voices=>(round===2?['current','legacy']:['legacy','current']).map(variant=>({round,voices,variant}))));}
export function validateAudioCpu(r){
 const errors=[],comparisons=[];
 const cohorts=Array.isArray(r?.cohorts)?r.cohorts:[];
 if(r?.schemaVersion!==1||r.status!=='passed'||JSON.stringify(r.profile)!==JSON.stringify(audioCpuProfile)||r.cohorts?.length!==12)errors.push('Complete frozen CPU corpus required.');
 for(const voices of audioCpuProfile.voices)for(const variant of['legacy','current'])for(const round of[1,2,3]){
  const c=cohorts.filter(c=>c.voices===voices&&c.variant===variant&&c.round===round);
  if(c.length!==1||c[0].warmup?.length!==12||c[0].samples?.length!==30||c[0].final?.voices!==0||c[0].final?.audioNodes!==0||c[0].final?.buffers!==0||c[0].final?.owners!==0||c[0].final?.decodeJobs!==0||c[0].disconnectedAll!==true||!Number.isFinite(c[0].retireMs)||c[0].retireMs<0){errors.push('Missing cohort or residual '+[voices,variant,round]);continue;}
  for(const s of[...c[0].warmup,...c[0].samples])if(!['playMs','statsMs'].every(k=>Number.isFinite(s[k])&&s[k]>=0)||s.activeVoices!==voices||s.activeNodes!==4+voices*3||s.owners!==4)errors.push('Invalid accounting/timing '+[voices,variant,round]);
 }
 const p95=a=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1];
 if(audioCpuOrder().some((expected,i)=>Object.entries(expected).some(([key,v])=>cohorts[i]?.[key]!==v)))errors.push('Frozen forward/reverse order changed.');
 for(const voices of audioCpuProfile.voices){const value=Object.fromEntries(['legacy','current'].map(variant=>[variant,cohorts.filter(c=>c.voices===voices&&c.variant===variant).flatMap(c=>Array.isArray(c.samples)?c.samples:[])]));if(value.legacy.length===90&&value.current.length===90)comparisons.push({voices,legacyPlayP95Ms:p95(value.legacy.map(v=>v.playMs)),currentPlayP95Ms:p95(value.current.map(v=>v.playMs)),legacyStatsP95Ms:p95(value.legacy.map(v=>v.statsMs)),currentStatsP95Ms:p95(value.current.map(v=>v.statsMs))});}
 return{status:errors.length?'failed':'passed',errors,comparisons,role:'CPU diagnostic; no new microbenchmark threshold or GPU timing claim'};
}
