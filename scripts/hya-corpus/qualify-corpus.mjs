import {mkdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {rollup} from 'rollup';
import ts from 'typescript';
import {runChromeWebGpuFixture} from '../webgpu-gate/chrome-runner.mjs';
import {ROOT,ASSET_ROOT,RESULT_PATH,MANIFEST_PATH,readCorpusManifest,syncCorpus} from './corpus.mjs';
import {measureNodeCorpus} from './measure-node.mjs';
import {mergeBrowserMetrics,summarize,cohort,validateReport,MIN_MEDIAN_PARSE_SPEEDUP} from './report-policy.mjs';
import {stageQualifiedPackages,verifyServedBytes,sha256} from './packed-browser.mjs';
import {createQualificationOutput} from './qualification-output.mjs';
import {snapshotSourceInputs,changedSourceInputs} from './source-snapshot.mjs';
const arg=(name,fallback)=>{const at=process.argv.indexOf(name);return at<0?fallback:process.argv[at+1];},root=ROOT;
const output=createQualificationOutput(root,arg('--output','artifacts/engine-0.2.2/g12/corpus-'+Date.now()));mkdirSync(output.directory,{recursive:true});
const manifest=readCorpusManifest(),contract=JSON.parse(readFileSync(resolve(root,'config/hya-022-contract.json'),'utf8'));
if(sha256(readFileSync(MANIFEST_PATH))!==contract.qualification.manifestSha256||manifest.entries.length!==contract.qualification.unchangedDenominator)throw Error('Frozen licensed corpus identity/denominator changed.');
const sync=await syncCorpus(manifest,{offline:true}),originalLatest=sha256(readFileSync(RESULT_PATH)),baseline=JSON.parse(readFileSync(RESULT_PATH,'utf8'));
const sourceInputs=snapshotSourceInputs(root,['scripts/hya-corpus','scripts/fixtures/hya-production','scripts/webgpu-gate','examples/hya-lottie-corpus-dashboard/browserBenchmark.ts','animation-spec/corpus/manifest.json']);
const packageReport=resolve(root,arg('--packages','artifacts/engine-0.2.2/g12/packed-20261026/public-packages.json')),staged=stageQualifiedPackages(root,packageReport,output.directory);
const original=resolve(root,'examples/hya-lottie-corpus-dashboard/browserBenchmark.ts'),measurement=resolve(output.directory,'measurement.js');
const bundle=await rollup({input:original,external:id=>id.startsWith('@haiyue/'),plugins:[{name:'reuse-original-corpus-measurement',transform(source,id){if(resolve(id)!==original)return null;return {code:ts.transpileModule(source+'\nexport {measureSample};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,map:null};}}]});
await bundle.write({file:measurement,format:'es'});await bundle.close();const rounds=[];
for(let round=0;round<contract.qualification.repetitions;round++){
 const directory=resolve(output.directory,'round-'+(round+1));mkdirSync(directory);symlinkSync(ASSET_ROOT,resolve(directory,'assets'),'junction');
 const ordered=round===1?{...manifest,entries:[...manifest.entries].reverse()}:manifest;
 const samples=measureNodeCorpus(ordered,{outputDirectory:directory,iterations:100,batchSize:50,largeIterations:20,largeBatchSize:1});
 const input=JSON.parse(readFileSync(resolve(directory,'browser-input.json'),'utf8'));input.warmup=input.samples.find(sample=>sample.id===manifest.entries[0].id);writeFileSync(resolve(directory,'browser-input.json'),JSON.stringify(input,null,2)+'\n');
 writeFileSync(resolve(directory,'node.json'),JSON.stringify({samples},null,2)+'\n');
 const html=resolve(directory,'fixture.html');writeFileSync(html,'<!doctype html><meta charset="utf-8"><title>G12 full licensed corpus</title><pre id="progress"></pre><canvas id="canvas"></canvas><pre id="result"></pre><script type="importmap">'+JSON.stringify({imports:staged.imports})+'</script><script type="module" src="/scripts/fixtures/hya-production/corpus-browser.mjs"></script>');
 const mounts=[staged.mount,{prefix:'/g12-corpus',directory:output.directory},{prefix:'/animation-spec/corpus/.cache',directory}];let browser;
 try{browser=await runChromeWebGpuFixture({root,fixture:html.slice(root.length+1).replaceAll('\\','/'),mounts,timeoutMs:180000,acceptedStatuses:['passed','failed'],chunkedResult:true});}catch(error){browser={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
 const servedBytes=verifyServedBytes(root,mounts,browser),errors=[];
 try{
  if(browser.samples?.length!==manifest.entries.length||new Set(browser.samples.map(s=>s.id)).size!==manifest.entries.length||browser.samples.some(s=>!manifest.entries.some(e=>e.id===s.id)))throw Error('Complete original corpus denominator is missing.');
  mergeBrowserMetrics(samples,browser.samples);
 }catch(error){errors.push(String(error));}
 const report={schemaVersion:3,round:round+1,source:manifest.source,sources:manifest.sources,referenceRenderer:manifest.referenceRenderer,environment:{browser:browser.environment,node:process.version},summary:summarize(samples),cohorts:{small:summarize(cohort(samples,'small')),large:summarize(cohort(samples,'large'))},samples};
 try{if(browser.status!=='passed'||servedBytes.status!=='passed')throw Error(browser.error??'Native corpus or served bytes failed');validateReport(report,baseline);if(report.cohorts.small.medianParseSpeedup<MIN_MEDIAN_PARSE_SPEEDUP)throw Error('Original small-cohort 1.25x parse threshold failed');}catch(error){errors.push(String(error));}
 const result={...report,status:errors.length?'failed':'passed',errors,browser,servedBytes};writeFileSync(resolve(directory,'result.json'),JSON.stringify(result,null,2)+'\n');rounds.push(result);console.log(JSON.stringify({round:round+1,status:result.status,small:report.cohorts.small,large:report.cohorts.large,errors}));
}
if(sha256(readFileSync(RESULT_PATH))!==originalLatest)throw Error('Original corpus latest changed during qualification.');
const changed=changedSourceInputs(root,sourceInputs);
const result={schemaVersion:1,status:!changed.length&&rounds.every(r=>r.status==='passed')?'passed':'failed',sourceInputs,changed,generatedAt:new Date().toISOString(),manifestSha256:sha256(readFileSync(MANIFEST_PATH)),unchangedDenominator:manifest.entries.length,latestUnchanged:true,originalLatestSha256:originalLatest,sync,tarballs:staged.tarballs,measurementSourceSha256:sha256(readFileSync(original)),measurementBuildSha256:sha256(readFileSync(measurement)),rounds:rounds.map(({round,status,summary,cohorts,errors})=>({round,status,summary,cohorts,errors})),fullG12Complete:false};
writeFileSync(resolve(output.directory,'result.json'),JSON.stringify(result,null,2)+'\n');if(result.status!=='passed')process.exitCode=1;
