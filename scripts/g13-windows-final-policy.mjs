import {resolve,relative,isAbsolute} from 'node:path';
import {assessEngine021G05Audit} from './engine-021-evidence-policy.mjs';
export const WINDOWS_RENDER_JOBS=Object.freeze([
  {id:'resources',args:['scripts/webgpu-gate/run-framegraph-study.mjs','--mode=resources','--full'],parent:'artifacts/engine-0.2.1/g09',prefix:'study-resources-',captures:4},
  {id:'rooms',args:['scripts/webgpu-gate/run-g05-continuous.mjs','--suite=rooms','--full'],parent:'artifacts/engine-0.2.1/g05',prefix:'continuous-rooms-',captures:156},
  {id:'instances',args:['scripts/webgpu-gate/run-g05-continuous.mjs','--suite=instances','--full'],parent:'artifacts/engine-0.2.1/g05',prefix:'continuous-instances-',captures:96},
  {id:'forward',args:['scripts/webgpu-gate/run-g05-continuous.mjs','--suite=forward','--full'],parent:'artifacts/engine-0.2.1/g05',prefix:'continuous-forward-',captures:24},
  {id:'production',args:['scripts/verify-framegraph-production.mjs','--run'],parent:'artifacts/engine-0.2.1/g09',prefix:'production-local-',captures:36},
  {id:'ablation',args:['scripts/webgpu-gate/run-framegraph-study.mjs','--mode=ablation','--full'],parent:'artifacts/engine-0.2.1/g09',prefix:'study-ablation-',captures:40},
  {id:'correctness',args:['scripts/verify-framegraph-acceptance.mjs','--correctness'],parent:'artifacts/engine-0.2.1/g09',prefix:'acceptance-full-',captures:224},
]);
export function windowsFinalPaths(root,id){
  if(typeof id!=='string'||!/^\d{13}-[a-f0-9]{8}$/.test(id))throw Error('A fresh Windows validation identity is required');
  const output=resolve(root,'artifacts/engine-0.2.2/g13','windows-final-'+id);
  return {output,checkout:resolve(output,'checkout'),preparation:resolve(output,'preparation.json'),result:resolve(output,'result.json')};
}
export function assertWindowsFinalLocation(root,output){
  const parent=resolve(root,'artifacts/engine-0.2.2/g13'),local=relative(parent,resolve(output));
  if(isAbsolute(local)||!/^windows-final-\d{13}-[a-f0-9]{8}$/.test(local))throw Error('Windows validation must use one named G13 child directory');
  return resolve(output);
}
export function validateWindowsRenderReport(job,report,revision){
  if(report?.revision!==revision||report.dirty!==false)throw Error(job.id+': report must bind the frozen clean candidate');
  if(report.plan?.length!==job.captures&&report.plan?.jobs?.length!==job.captures)throw Error(job.id+': incomplete registered population');
  if(report.entries?.length!==job.captures||report.entries.some(e=>['running','invalid','failed'].includes(e.status)))throw Error(job.id+': missing or invalid capture');
  if(['rooms','instances','forward'].includes(job.id)){
    if(!['passed','failed'].includes(report.status)||report.suite!==job.id||report.tier!=='local-full')throw Error(job.id+': full G05 report required');
  }else if(report.status!=='passed'||report.tier!==(job.id==='correctness'?'full':job.id==='production'?'production-local':'local-full'))throw Error(job.id+': full passing report required');
}
/** Early rejection only. The final independent raw audit is still mandatory. */
export function validateWindowsG05BudgetSummary(job,report){
  if(!['rooms','instances','forward'].includes(job.id))throw Error('A G05 summary is required');
  if(report.assessment?.status!==report.status)throw Error(job.id+': original summary status differs');
  return assessEngine021G05Audit(job.id,report.assessment,'0.2.2');
}
export function windowsFinalPlan(){return {version:'0.2.2',scope:'Windows qualification only; Apple device requirements remain pending',jobs:WINDOWS_RENDER_JOBS,captures:WINDOWS_RENDER_JOBS.reduce((n,j)=>n+j.captures,0),
  hyaProduction:{captures:30,originalGpuRegressionLimit:.05},
  hyaFollowups:[{id:'layout',cohorts:27,entry:'scripts/hya-corpus/qualify-layout.mjs'},{id:'corpus',rounds:3,denominator:23,entry:'scripts/hya-corpus/qualify-corpus.mjs'}],
  following:['independent seven-report raw audit and four rebuilt runtimes','complete global release gate','no-publication release rehearsal and independent bundle audit','exact rebuilt tarball comparison'],
  sourceIsolation:'fresh local clone with its own locked dependencies; historical protocol paths stay inside that clone',automaticRetry:false,macQualified:false,iPhoneQualified:false,externalPublishPerformed:false,baselinePromotion:false};}
