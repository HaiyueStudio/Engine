import {readFile,writeFile,realpath} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseG05AuditOptions,evaluateG05Stability} from './deferred-g05-stability-policy.mjs';
import {evaluateG05InstanceBudgets} from './deferred-g05-instance-cohort-policy.mjs';
import {evaluateG05RoomBudgets} from './deferred-g05-cohort-policy.mjs';
import {sha256} from './deferred-fixture-policy.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=await realpath(resolve(root,'artifacts/engine-0.2.1/g05'));
const options=parseG05AuditOptions(process.argv.slice(2)),manifestPath=await realpath(resolve(root,options.manifest));
if(!manifestPath.startsWith(directory+sep))throw Error('G05 manifest must be inside its artifact directory');
const bytes=await readFile(manifestPath),manifest=JSON.parse(bytes);
if(manifest.schemaVersion!==1||manifest.tier!==`diagnostic-g05-${options.scope==='instances'?'instance':'room'}-cohorts`||!['passed','failed'].includes(manifest.status)||!manifest.finishedAt)throw Error('Finished G05 cohort manifest required');
const configPath='config/lighting-performance-021.json',configBytes=await readFile(resolve(root,configPath));
if(manifest.policyFiles?.find(f=>f.path===configPath)?.sha256!==sha256(configBytes))throw Error('Capture config differs from current frozen budgets');
const artifacts=[];
for(const entry of manifest.entries){
 if(entry.exitCode!==0||!entry.artifact||!entry.evidence)throw Error('Failed or missing capture cannot be qualified');
 const path=await realpath(resolve(root,entry.artifact));if(!path.startsWith(directory+sep))throw Error('Unexpected raw artifact path');
 const raw=await readFile(path);if(JSON.stringify(JSON.parse(raw))!==JSON.stringify(entry.evidence))throw Error('Raw evidence and manifest differ');
 artifacts.push({path,sha256:sha256(raw)});
}
const config=JSON.parse(configBytes),budgets=(options.scope==='instances'?evaluateG05InstanceBudgets:evaluateG05RoomBudgets)(manifest.entries,config),stability=evaluateG05Stability(manifest.entries,options.scope);
const paths=['scripts/webgpu-gate/audit-deferred-g05-cohorts.mjs','scripts/webgpu-gate/deferred-g05-stability-policy.mjs','scripts/webgpu-gate/deferred-g05-instance-cohort-policy.mjs','scripts/webgpu-gate/deferred-g05-instance-policy.mjs','scripts/webgpu-gate/deferred-g05-cohort-policy.mjs','scripts/webgpu-gate/deferred-g05-policy.mjs','scripts/webgpu-gate/deferred-g05-memory-policy.mjs','scripts/benchmark/lighting-g01-policy.mjs','scripts/benchmark/timing-cohorts.mjs',configPath];
const policies=await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(resolve(root,path)))})));
const generatedAt=new Date().toISOString(),report={schemaVersion:1,tier:'diagnostic-g05-cohort-final-audit',generatedAt,scope:options.scope,status:budgets.status==='passed'&&stability.status==='passed'?'passed':'failed',manifest:{path:manifestPath,sha256:sha256(bytes)},policies,artifacts,budgets,stability,releaseQualified:false,note:'Only this scope timing/host/correctness; other G05 obligations and clean-release G07 remain separate'};
const path=resolve(directory,`${options.scope}-audit-${generatedAt.replaceAll(':','-')}.json`);await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({path,status:report.status,budgets:budgets.status,stability:stability.status}));if(report.status!=='passed')process.exitCode=1;
