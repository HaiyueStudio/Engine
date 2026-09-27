import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseTiledCohortOptions,tiledCohortPlan,evaluateTiledCohorts} from './deferred-tiled-cohort-policy.mjs';
import {sha256} from './deferred-fixture-policy.mjs';
const options=parseTiledCohortOptions(process.argv.slice(2));
const plan=tiledCohortPlan(options.idleMs);
if(options.mode==='--plan')console.log(JSON.stringify(plan,null,2));
else {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),stamp=new Date().toISOString().replaceAll(':','-');
  const output=resolve(root,`artifacts/engine-0.2.1/g03/cohorts-${stamp}`);await mkdir(output,{recursive:true});
  const contract=JSON.parse(await readFile(resolve(root,'config/lighting-performance-021.json'),'utf8'));
  const captures=[],index=[];
  await writeFile(resolve(output,'plan.json'),JSON.stringify(plan,null,2)+'\n');
  for(const [i,run] of plan.entries()){
    const flags=['--full',`--count=${run.count}`,`--idle-ms=${run.idleMs}`];
    if(run.overlap)flags.push('--overlap');if(run.preference==='low-power')flags.push('--integrated');if(run.algorithm==='reference')flags.push('--reference');
    console.log(`Capture ${i+1}/${plan.length}: cohort ${run.cohort+1}, ${run.preference}, ${run.count} ${run.overlap?'overlap':'sparse'}, ${run.algorithm}`);
    let log='';
    const code=await new Promise((done,reject)=>{const child=spawn(process.execPath,['scripts/webgpu-gate/run-deferred-tiled-room.mjs',...flags],{cwd:root,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>{log+=chunk;});child.stderr.on('data',chunk=>{log+=chunk;});child.on('error',reject);child.on('close',done);});
    await writeFile(resolve(output,`${i+1}.log`),log);
    if(code!==0)throw Error(`Capture ${i+1} failed (${code}); see ${output}/${i+1}.log`);
    const summary=JSON.parse(log.trim().split('\n').at(-1)),bytes=await readFile(summary.path),evidence=JSON.parse(bytes);
    captures.push({cohort:run.cohort,evidence});index.push({cohort:run.cohort,path:relative(root,summary.path),sha256:sha256(bytes)});
    await writeFile(resolve(output,'captures.json'),JSON.stringify(index,null,2)+'\n');
    console.log(JSON.stringify({capture:i+1,p95:summary.p95}));
  }
  const report={...evaluateTiledCohorts(captures,contract),generatedAt:new Date().toISOString(),captures:index};
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:resolve(output,'report.json'),relativeBudgetsPassed:report.relativeBudgetsPassed,absoluteBudgetsPassed:report.absoluteBudgetsPassed}));
  if(!report.relativeBudgetsPassed||!report.absoluteBudgetsPassed||!report.stabilityPassed)process.exitCode=1;
}
