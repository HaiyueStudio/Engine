import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {cpus,hostname,release} from 'node:os';
import {rollup} from 'rollup';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runChromeWebGpuFixture} from '../webgpu-gate/chrome-runner.mjs';
import {createQualificationOutput} from './qualification-output.mjs';
import {stageQualifiedPackages,verifyServedBytes,sha256} from './packed-browser.mjs';
import {snapshotSourceInputs,changedSourceInputs} from './source-snapshot.mjs';
import {productionLayoutWorkload} from '../fixtures/hya-production/workloads.mjs';
import {productionWorkloads,assessHyaPacing} from './production-policy.mjs';
import {compareProductionGpuCohorts} from './production-cohort-policy.mjs';
import {waitForProductionResult} from './production-observer.mjs';
const root=process.cwd(),arg=(key,fallback)=>{const at=process.argv.indexOf(key);return at<0?fallback:process.argv[at+1];};
const output=createQualificationOutput(root,arg('--output','artifacts/engine-0.2.2/g12/production-'+Date.now())).directory;mkdirSync(output,{recursive:true});
const packageReport=resolve(root,arg('--packages','artifacts/engine-0.2.2/g12/packed-final-20261026/public-packages.json')),baseline=resolve(root,arg('--baseline','artifacts/engine-0.2.2/g12/incremental-20261026/haiyue-extensions-0.2.2.tgz'));
const budget=JSON.parse(readFileSync(resolve(root,'config/framegraph-production-021.json'),'utf8')),lighting=JSON.parse(readFileSync(resolve(root,'config/lighting-performance-021.json'),'utf8'));
const diagnostic=process.argv.includes('--diagnostic'),gpuLimit=lighting.relativeBudgets?.smallSceneGpuP95RegressionRatio;
if(gpuLimit!==.05)throw Error('The frozen small-scene GPU regression budget changed');
if(process.platform!==budget.device.platform||!cpus()[0]?.model.includes('i7-7700'))throw Error('Registered native production CPU/platform required');
const hardware=JSON.parse(execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; [pscustomobject]@{gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,CurrentRefreshRate);power=(powercfg /getactivescheme | Out-String)} | ConvertTo-Json -Depth 4 -Compress'],{encoding:'utf8',windowsHide:true}));
if(!hardware.gpu.some(g=>g.Name===budget.device.gpu&&g.CurrentRefreshRate===budget.device.refreshHz))throw Error('Registered native GPU/display required');
const baselineRecord=JSON.parse(readFileSync(resolve(root,'artifacts/engine-0.2.2/g12/incremental-20261026/baseline-pack.json'),'utf8'))[0];
if(createHash('sha1').update(readFileSync(baseline)).digest('hex')!==baselineRecord.shasum)throw Error('Original measured baseline tarball changed');
const original=resolve(root,'scripts/webgpu-gate/framegraph-production-scene.mjs'),sceneBuild=resolve(output,'production-scene.mjs');
const sceneBundle=await rollup({input:original,external:id=>id.startsWith('@haiyue/')||id==='wgpu-matrix',plugins:[{name:'reuse-frozen-production-scene',transform(source,id){if(resolve(id)!==original)return null;const adapter='requestAdapter: () => navigator.gpu.requestAdapter({ powerPreference: \'high-performance\' })';if(!source.includes(adapter))throw Error('Frozen native adapter assembly changed');return {code:source.replaceAll(/\.\.\/\.\.\/engine\/dist\/([^']+)\.js/g,(_match,path)=>'@haiyue/engine'+(path==='index'?'':'/'+path)).replace('timestampQuery: false','timestampQuery: diagnostics.gpuTiming === true').replace(adapter,`requestAdapter: async () => {const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter||!diagnostics.gpuTiming)return adapter;return new Proxy(adapter,{get(target,name){if(name==='requestDevice')return descriptor=>target.requestDevice({...descriptor,requiredFeatures:[...new Set([...(descriptor?.requiredFeatures??[]),'timestamp-query'])]});const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});}`).replace('return { engine, update, snapshot','return { engine, scene, update, snapshot'),map:null};}}]});await sceneBundle.write({file:sceneBuild,format:'es'});await sceneBundle.close();
const originalComposition=JSON.parse(readFileSync(resolve(root,'examples/hya-production/scene.json'),'utf8')),fontDocument=originalComposition.parts.find(p=>p.id==='layout').document,fontManifest=JSON.parse(readFileSync(resolve(root,'examples/hya-production/assets.json'),'utf8'));
const inputs=snapshotSourceInputs(root,["scripts/hya-corpus","scripts/fixtures/hya-production","scripts/webgpu-gate",'scripts/hya-corpus/qualify-production.mjs','scripts/hya-corpus/production-policy.mjs','scripts/fixtures/hya-production/production-browser.mjs','scripts/fixtures/hya-production/workloads.mjs','scripts/benchmark/real-renderer-gpu-timestamp.mjs','scripts/webgpu-gate/framegraph-production-scene.mjs','scripts/webgpu-gate/deferred-room-fixture.mjs','config/framegraph-production-021.json','config/lighting-performance-021.json','examples/hya-production/scene.json','examples/hya-production/assets.json','examples/hya-production/scene-sans.otf']);
const captures=[],failures=[],plan=[];
for(let round=1;round<=3;round++)for(const workload of round===2?[...productionWorkloads].reverse():productionWorkloads)for(const candidate of round===2?['candidate','baseline']:['baseline','candidate'])plan.push({round,workload,candidate,regional:false});
for(let round=1;round<=3;round++)for(const workload of productionWorkloads.filter(w=>w.class==='normal'))plan.push({round,workload,candidate:'candidate',regional:true});
if(diagnostic)plan.splice(0,plan.length,{round:1,workload:productionWorkloads[0],candidate:'candidate',regional:false});
for(const [index,job]of plan.entries()){
 const directory=resolve(output,String(index+1).padStart(2,'0')+'-'+job.candidate+'-'+job.workload.id+(job.regional?'-regional':''));mkdirSync(directory);
 const staged=stageQualifiedPackages(root,packageReport,directory,job.candidate==='baseline'?{baselineExtensions:baseline}:{}),document=productionLayoutWorkload(job.workload.nodes,fontDocument);
 document.assets=document.assets.filter(asset=>asset.id==='font');if(job.workload.instances===4)document.instances=Array.from({length:4},(_,i)=>({id:'stage-'+i,artboard:'main',fit:'fill',alignment:[0,0],transform:[.5,0,0,.5,i%2*640,Math.floor(i/2)*360]}));
 const composition={format:'haiyue-composition',version:1,parts:[{id:'layout',extension:'org.haiyue.layout-2d@1',required:true,requires:[],dependencies:[],document}],targets:[]};
 writeFileSync(resolve(directory,'source.json'),JSON.stringify(composition));writeFileSync(resolve(directory,'config.json'),JSON.stringify({budget,job,font:fontManifest.assets.font,scene:budget.workloads.find(w=>w.id==='f0-forward-1')}));
 const html=resolve(directory,'fixture.html');writeFileSync(html,'<!doctype html><meta charset="utf-8"><style>html,body{margin:0}canvas{width:1280px;height:720px}#progress,#result{display:none}</style><canvas id="canvas" width="1280" height="720"></canvas><pre id="progress"></pre><pre id="result"></pre><script type="importmap">'+JSON.stringify({imports:staged.imports})+'</script><script type="module" src="/scripts/fixtures/hya-production/production-browser.mjs"></script>');
 const mounts=[staged.mount,{prefix:'/g12-case',directory},{prefix:'/g12-production',directory:output},{prefix:'/g12-font',directory:resolve(root,'examples/hya-production')}];let raw;
 try{raw=await runChromeWebGpuFixture({root,fixture:html.slice(root.length+1).replaceAll('\\','/'),mounts,timeoutMs:240000,acceptedStatuses:['passed','failed'],chunkedResult:true,interact:cdp=>waitForProductionResult(cdp,240000),presentation:{mode:'visible',width:1320,height:820}});}catch(error){raw={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
 const servedBytes=verifyServedBytes(root,mounts,raw);let pacing;
 try{if(raw.status!=='passed'||servedBytes.status!=='passed')throw Error(raw.error??'Native sample or HTTP identity failed');if(raw.adapter?.vendor!==budget.device.vendor||raw.adapter?.architecture!==budget.device.architecture)throw Error('Browser selected a different native GPU');pacing=assessHyaPacing(raw,budget);}catch(error){failures.push({index,job,reason:String(error)});}
 if(job.candidate==='candidate'&&job.workload.class==='normal'&&pacing?.status!=='passed')failures.push({index,job,pacing});
 const capture={job,tarballs:staged.tarballs,servedBytes,pacing,...raw};writeFileSync(resolve(directory,'result.json'),JSON.stringify(capture,null,2)+'\n');captures.push({directory,job,status:raw.status,pacing,gpu:raw.gpuSamples});
 writeFileSync(resolve(output,'partial.json'),JSON.stringify({plan,captures,failures},null,2)+'\n');console.log(JSON.stringify({capture:index+1,total:plan.length,...job,status:raw.status,pacing:pacing?.status,error:raw.error}));
}
// The checked-in numeric budget is recorded below; never derive a new limit from a failing run.
const gpu=[];if(!diagnostic)for(const workload of productionWorkloads){
 const cohorts=candidate=>[1,2,3].map(round=>captures.find(c=>c.job.round===round&&c.job.workload.id===workload.id&&!c.job.regional&&c.job.candidate===candidate)?.gpu);
 try{const comparison=compareProductionGpuCohorts(cohorts('baseline'),cohorts('candidate'),lighting.sampling,gpuLimit);gpu.push({workload:workload.id,...comparison});if(comparison.status!=='passed')failures.push({workload:workload.id,gpu:comparison});}
 catch(error){failures.push({workload:workload.id,reason:String(error)});}
}
const changed=changedSourceInputs(root,inputs);if(changed.length)failures.push({reason:'Measurement inputs changed',changed});
const result={schemaVersion:1,status:failures.length?'failed':'passed',scope:diagnostic?'One-case harness diagnosis only; not G12 qualification':'Local native production qualification; baseline retained; no release promotion or physical input claim',diagnostic,host:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,hostname:hostname(),os:release(),hardware},packageReport:{path:packageReport,sha256:sha256(readFileSync(packageReport))},baseline:{path:baseline,sha256:sha256(readFileSync(baseline)),packRecord:baselineRecord.shasum},inputs,budget,originalGpuBudget:lighting.relativeBudgets,gpuLimit,plan,captures,gpu,failures,fullG12Complete:false};writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');if(failures.length)process.exitCode=1;
