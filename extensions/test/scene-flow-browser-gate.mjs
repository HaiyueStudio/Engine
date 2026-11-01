import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve,relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runChromeWebGpuFixture } from '../../scripts/webgpu-gate/chrome-runner.mjs';
import { verifyServedBytes } from '../../scripts/hya-corpus/packed-browser.mjs';
import { sha,root } from './scene-flow-candidate.mjs';

const candidatePath=resolve(root,process.argv[2]??''),output=resolve(root,process.argv[3]??'');
if(process.argv.length!==4||candidatePath===root||output===root)throw Error('Usage: scene-flow-browser-gate.mjs CANDIDATE_JSON NEW_OUTPUT');
const candidate=JSON.parse(readFileSync(candidatePath));if(candidate.status!=='passed'||!candidate.strictInstalledTypecheck||!candidate.installedEsm)throw Error('A passing installed public package candidate is required.');
for(const p of candidate.packages)if(sha(readFileSync(p.file))!==p.sha256)throw Error('Candidate tarball changed: '+p.name);
if(sha(readFileSync(resolve(candidate.consumer,'browser/application.js')))!==candidate.compiledApplicationSha256)throw Error('Compiled application changed.');
mkdirSync(output,{recursive:true});
const html='<!doctype html><meta charset="utf-8"><title>G03 packed scene flow</title><style>body{margin:0}canvas{display:block;width:960px;height:640px}#result{display:none}</style><canvas id="canvas" width="960" height="640"></canvas><pre id="result"></pre><script>addEventListener("error",e=>{const n=document.querySelector("#result");n.textContent=JSON.stringify({status:"failed",error:e.message});n.dataset.status="failed"})</script><script type="importmap">'+JSON.stringify({imports:candidate.imports})+'</script><script type="module" src="/extensions/test/scene-flow-browser.mjs"></script>';
const fixture=resolve(output,'fixture.html');writeFileSync(fixture,html,{flag:'wx'});
const paths=['extensions/src/scene-flow.ts','extensions/src/scene-flow/SceneFlow.ts','extensions/src/scene-flow/types.ts','engine/src/assets/AssetManager.ts','engine/src/core/EngineError.ts','examples/scene-flow/application.ts','examples/scene-flow/level.json','extensions/test/scene-flow-browser.mjs','extensions/test/scene-flow-browser-gate.mjs','extensions/test/scene-flow-candidate.mjs'];
const inputs=Object.fromEntries(paths.map(path=>[path,sha(readFileSync(resolve(root,path)))]));
let report;
try{report=await runChromeWebGpuFixture({root,fixture:relative(root,fixture).replaceAll('\\','/'),mounts:candidate.mounts,timeoutMs:180000,acceptedStatuses:['passed','failed'],chunkedResult:true});}
catch(error){report={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const provenance=verifyServedBytes(root,candidate.mounts,report,{requiredPackages:[]});
const served=report.httpProvenance?.files??[],required=['engine','extensions'].filter(name=>!served.some(f=>f.sourcePath?.startsWith('g03-packages/'+name+'/dist/')));
const forbidden=served.filter(f=>/^(?:engine|extensions)\/src\//.test(f.sourcePath??''));
const changed=paths.filter(path=>sha(readFileSync(resolve(root,path)))!==inputs[path]);
if(provenance.status!=='passed'||required.length||forbidden.length||changed.length)Object.assign(report,{status:'failed',provenance,required,forbidden,changed});
const result={schemaVersion:1,role:'G03 feature correctness/resource diagnostic; not G11 release qualification',revision:execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:true,inputs,candidate:relative(root,candidatePath).replaceAll('\\','/'),candidateSha256:sha(readFileSync(candidatePath)),packages:candidate.packages,servedBytes:provenance,...report};
writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,output,checks:result.checks?.length,provenance:provenance.status,error:result.error,failures:result.failures}));
if(result.status!=='passed')process.exitCode=1;
