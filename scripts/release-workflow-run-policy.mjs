import {createHash} from 'node:crypto';
const steps={
  diagnostic:[
    {id:'publication-contracts',kind:'node',args:['--test','scripts/publication-policy.test.mjs','scripts/publication-cli.test.mjs','scripts/publication-assets.test.mjs','scripts/publication-planar.test.mjs']},
    {id:'planar-protocol',kind:'node',args:['scripts/verify-webgpu-planar-reflection.mjs','--protocol']},
  ],
  ci:[
    {id:'engine-slow',kind:'npm',args:['run','check:engine:slow','--','--content-tier=full']},
    {id:'rehearsal',kind:'node',args:['scripts/release-rehearsal.mjs','--worker']},
    {id:'rehearsal-audit',kind:'node',args:['scripts/release-rehearsal-policy.mjs','--bundle','artifacts/release/rehearsal']},
  ],
  global:[
    {id:'global-gate',kind:'node',args:['scripts/release-gate.mjs','--global']},
    {id:'rehearsal',kind:'node',args:['scripts/release-rehearsal.mjs','--worker']},
    {id:'rehearsal-audit',kind:'node',args:['scripts/release-rehearsal-policy.mjs','--bundle','artifacts/release/rehearsal']},
  ],
};
export function releaseWorkflowSteps(profile) {if(!steps[profile])throw Error('Unknown no-publication workflow profile');return structuredClone(steps[profile]);}
export function workflowId(manifest) {validateWorkflowManifest(manifest);return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');}
export function validateWorkflowManifest(m) {
  if(m?.schemaVersion!==1||m.noPublication!==true||!m.root||!m.node||/[\r\n\x00"]/.test(m.root+m.node)||!/^[a-f0-9]{40}$/.test(m.source?.revision??'')||typeof m.source.dirty!=='boolean')throw Error('Invalid no-publication run manifest');
  if(JSON.stringify(m.steps)!==JSON.stringify(releaseWorkflowSteps(m.profile)))throw Error('Workflow commands differ from the selected no-publication profile');
  if(m.profile!=='diagnostic'&&m.source.dirty)throw Error('Formal validation requires clean source');
  if(!m.source.files||!Object.keys(m.source.files).length)throw Error('Missing frozen workflow input hashes');
  for(const [path,sha] of Object.entries(m.source.files))if(!path.startsWith('scripts/')||path.split('/').includes('..')||path.includes('\\')||!/^[a-f0-9]{64}$/.test(sha))throw Error('Invalid workflow source input');
}
export function assessWorkflowPreflight(m,host) {
  if(m.profile==='diagnostic')return {status:'ready',role:'diagnostic-only',administratorRequired:false};
  if(host.platform==='win32'&&host.administrator!==true)return {status:'permission-required',message:'Administrator permission was not confirmed. Validation did not start.'};
  if(!Array.isArray(host.blockers))return {status:'preflight-failed',message:'Background application metadata unavailable. Validation did not start.'};
  if(host.blockers.length)return {status:'background-apps',blockers:host.blockers,message:'Permission passed; close the listed background applications. Nothing was terminated; validation did not start.'};
  return {status:'ready',administratorRequired:host.platform==='win32'};
}

/** All commands are immutable and non-publishing. Failed/interrupted stages require named retry. */
export async function runReleaseWorkflow(manifest,previous,io,{retryStage}={}) {
  const id=workflowId(manifest);
  if(previous&&previous.manifestId!==id)throw Error('Workflow state belongs to another frozen manifest');
  const state=previous?structuredClone(previous):{schemaVersion:1,manifestId:id,status:'prepared',stages:{}};
  const save=async()=>io.save(structuredClone(state));
  if(retryStage&&!manifest.steps.some(s=>s.id===retryStage))throw Error('Unknown retry stage');
  await io.verifyInputs();
  const preflight=assessWorkflowPreflight(manifest,await io.host());state.preflight=preflight;
  if(preflight.status!=='ready'){state.status=preflight.status;await save();return state;}
  for(const step of manifest.steps){
    await io.verifyInputs();const before=state.stages[step.id];
    if(before?.status==='passed'){await io.verifyCompleted(step,before);continue;}
    if(before&&!['prepared'].includes(before.status)&&retryStage!==step.id){state.status='needs-explicit-retry';state.currentStage=step.id;await save();return state;}
    const attempt=(before?.attempt??0)+1,history=before?[...(before.history??[]),{...before,history:undefined}]:[];
    state.status='running';state.currentStage=step.id;state.stages[step.id]={status:'running',attempt,history,startedAt:io.now()};await save();
    let result;
    try{result=await io.execute(step,attempt);}catch(error){state.stages[step.id]={...state.stages[step.id],status:'interrupted',error:error.message,finishedAt:io.now()};state.status='failed';await save();throw error;}
    state.stages[step.id]={...state.stages[step.id],...result,status:result.exitCode===0?'passed':'failed',finishedAt:io.now()};
    if(result.exitCode!==0){state.status='failed';await save();return state;}
    await save();
  }
  state.status='passed';state.currentStage=null;state.finishedAt=io.now();state.published=false;state.baselinePromoted=false;
  state.releaseQualificationGranted=false; // Execution result alone never replaces G11 qualification.
  await save();return state;
}

const cmdQuote=s=>'"'+s.replaceAll('%','%%')+'"';
const shQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function workflowLauncher(m,runPath,platform) {
  validateWorkflowManifest(m);if(/[\r\n\x00"]/.test(runPath))throw Error('Invalid run path');
  if(platform==='win32')return `@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\ncd /d ${cmdQuote(m.root)}\r\n${cmdQuote(m.node)} scripts\\release-workflow.mjs run --run ${cmdQuote(runPath)} --no-publish\r\nset "workflow_exit=%errorlevel%"\r\necho No-publication validation exit code: %workflow_exit%\r\necho Status and logs: ${cmdQuote(runPath)}\r\npause\r\nexit /b %workflow_exit%\r\n`;
  return `#!/bin/sh\ncd ${shQuote(m.root)} || exit 1\n${shQuote(m.node)} scripts/release-workflow.mjs run --run ${shQuote(runPath)} --no-publish\ncode=$?\nprintf 'No-publication validation exit code: %s\\n' "$code"\nexit "$code"\n`;
}
