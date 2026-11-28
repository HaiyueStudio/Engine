import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runRollupOnce} from './shared-rollup-runner.mjs';
import {runChromeWebGpuFixture} from './webgpu-gate/chrome-runner.mjs';
import {validateF30F32Pixels} from './webgpu-gate/f30-f32-policy.mjs';
const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2);let output=resolve(root,'artifacts/tech-debt-f30-f32',new Date().toISOString().replace(/[:.]/g,'-')),before=null;
for(let i=0;i<args.length;i++){if(args[i]==='--output'&&args[i+1])output=resolve(root,args[++i]);else if(args[i]==='--before'&&args[i+1])before=resolve(root,args[++i]);else throw Error('Use --output <artifacts path> [--before <preserved before source root>]');}
if(!output.startsWith(resolve(root,'artifacts')+sep)||before&&!before.startsWith(resolve(root,'artifacts')+sep))throw Error('Evidence and preserved sources must be under Engine/artifacts');
mkdirSync(output,{recursive:true});const bundle=resolve(output,'browser'),expected=relative(root,bundle).replaceAll('\\','/');
await runRollupOnce({cwd:root,config:'scripts/webgpu-gate/f30-f32-rollup.config.mjs',expectedOutputs:[expected],environment:{F30_F32_OUTPUT:bundle,...(before?{F30_F32_BEFORE:before}:{})},timeoutMs:180000});
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(resolve(dir,entry.name)):[resolve(dir,entry.name)]);
const sourceManifest=JSON.parse(readFileSync(resolve(bundle,'sources.json')));
const consumedSources=sourceManifest.sources.map(entry=>resolve(entry.beforeOverride?before:root,entry.path));
const fixtureSources=['scripts/verify-tech-debt-f30-f32.mjs','scripts/webgpu-gate/f30-f32-fixture.mjs','scripts/webgpu-gate/f30-f32-fixture.html','scripts/webgpu-gate/f30-f32-policy.mjs','scripts/webgpu-gate/f30-f32-rollup.config.mjs'].map(path=>resolve(root,path));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=Object.fromEntries([...files(bundle),...fixtureSources,...consumedSources].map(path=>[relative(root,path).replaceAll('\\','/'),sha(readFileSync(path))]));
let report;
try{report=await runChromeWebGpuFixture({root,fixture:'scripts/webgpu-gate/f30-f32-fixture.html',query:{bundle:'/'+expected+'/bundle.js'},timeoutMs:180000,acceptedStatuses:['passed','failed']});}
catch(error){report={status:'failed',error:error.stack??String(error),browserFailure:error.browserFailure};}
const unchanged=Object.entries(inputs).every(([path,hash])=>sha(readFileSync(resolve(root,path)))===hash);
report.provenance={head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),dirty:execFileSync('git',['status','--porcelain=v1','--untracked-files=normal'],{cwd:root,encoding:'utf8',windowsHide:true}).trim().length>0,role:'correctness-regression, not formal performance',at:new Date().toISOString(),before,inputs,inputsUnchanged:unchanged,sourceManifest:relative(root,resolve(bundle,'sources.json')).replaceAll('\\','/')};
for(const preview of report.previews??[])for(const key of ['candidate','reference'])if(preview[key]?.startsWith('data:image/png;base64,')){writeFileSync(resolve(output,preview.id+'-'+key+'.png'),Buffer.from(preview[key].slice(22),'base64'));delete preview[key];}
writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2)+'\n');
const expectedStatus=before?'failed':'passed',groups=new Set((report.failures??[]).map(value=>value.group));
let valid=report.status===expectedStatus&&unchanged&&(!before||['hya','toon','warmup'].every(group=>groups.has(group)));
if(!before)try{validateF30F32Pixels(report);}catch(error){valid=false;report.policyError=error.message;writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,expectedStatus,cases:report.cases?.length,failures:report.failures,errors:report.validationErrors,residue:report.resourceResidue,error:report.error,inputsUnchanged:unchanged,output},null,2));if(!valid)process.exitCode=1;
