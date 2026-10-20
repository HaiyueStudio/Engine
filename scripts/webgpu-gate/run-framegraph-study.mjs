import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {cpus,hostname,release} from 'node:os';
import {buildDeferredFixture} from './deferred-fixture-builder.mjs';
import {sha256} from './deferred-fixture-policy.mjs';
import {runChromeWebGpuFixture} from './chrome-runner.mjs';
import {frameGraphBrowserPath} from './framegraph-qualification.mjs';
import {validateProductionScreenshot} from './framegraph-production-policy.mjs';
import {frameGraphStudyPlan,assessResourceStudy,assessAblationStudy,compareStudyPixels} from './framegraph-study-policy.mjs';
import {auditFrameGraphStudy} from './framegraph-study-artifact.mjs';
import {requireFrameGraphPresentation,readFrameGraphPresentation} from './framegraph-presentation.mjs';
import {studyEvidenceInputs} from './framegraph-evidence-inputs.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url)),args=process.argv.slice(2);
const reader=directory=>name=>{const path=resolve(directory,name),local=relative(directory,path);if(!local||local==='..'||local.startsWith(`..${sep}`)||/^[A-Za-z]:/.test(local))throw Error('Study path escapes artifact directory');return readFile(path);};
if(args.length===1&&args[0].startsWith('--audit=')){
  const path=resolve(root,args[0].slice(8)),result=await auditFrameGraphStudy(JSON.parse(await readFile(path)),reader(resolve(path,'..')));
  console.log(JSON.stringify(result,null,2));process.exit(result.status==='passed'?0:1);
}
if(args.length!==2||!/^--mode=(resources|ablation)$/.test(args[0])||!['--plan','--smoke','--full'].includes(args[1]))throw Error('Use --mode=resources|ablation --plan|--smoke|--full, or --audit=<report>');
const mode=args[0].slice(7),smoke=args[1]==='--smoke',config=JSON.parse(await readFile(resolve(root,'config/framegraph-production-021.json'))),plan=frameGraphStudyPlan(config,mode,smoke);
if(args[1]==='--plan'){console.log(JSON.stringify({config,plan},null,2));process.exit(0);}
const directory=resolve(root,'artifacts/engine-0.2.1/g09',`study-${mode}-${smoke?'smoke-':''}${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(directory,{recursive:true});console.log(directory);
const save=async(name,value)=>{const bytes=JSON.stringify(value,null,2)+'\n';await writeFile(resolve(directory,name),bytes);return {file:name,sha256:sha256(bytes)};};
const fixture=mode==='resources'?'framegraph-resource-study-fixture.mjs':'framegraph-ablation-study-fixture.mjs';
const fingerprint=()=>studyEvidenceInputs(root,mode);
const report={schemaVersion:1,mode,tier:smoke?'smoke':'local-full',config,plan,status:'running',generatedAt:new Date().toISOString(),
  host:{hostname:hostname(),os:release(),cpu:cpus()[0]?.model,platform:process.platform},
  revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),entries:[]};
try{
  if(report.host.platform!==config.device.platform||!report.host.cpu.includes('i7-7700'))throw Error('Unregistered study host');
  report.inputs=await fingerprint();report.build=await buildDeferredFixture({sourceRoot:root,outputDirectory:resolve(directory,'runtime'),entry:resolve(root,'scripts/webgpu-gate',fixture)});
  if(JSON.stringify(report.inputs)!==JSON.stringify(await fingerprint()))throw Error('Study inputs changed during build');
  report.registration=await save('registration.json',{...report,entries:undefined,registeredAt:new Date().toISOString()});
  await save('report.json',report);process.env.WEBGPU_REQUIRE_NATIVE='1';const pictures=new Map();
  for(const [i,job]of plan.jobs.entries()){
    const entry={job,status:'running'};report.entries.push(entry);await save('report.json',report);
    try{
      const spec=config.workloads.find(w=>w.id===job.caseId),isResource=mode==='resources',start=isResource?'startSoak':'startAblation',ready=isResource?'soakReady':'ablationReady',finish=isResource?'finishSoak':'finishAblation';
      let png;
      const raw=await runChromeWebGpuFixture({root,browserPath:frameGraphBrowserPath(job.browserId),fixture:'scripts/webgpu-gate/framegraph-study-fixture.html',timeoutMs:isResource?380000:200000,
        presentation:{mode:'visible',width:1320,height:960},acceptedStatuses:['captured','failed'],chunkedResult:true,mounts:[{prefix:'/probe-runtime',directory:resolve(directory,'runtime')}],
        interact:async cdp=>{
          const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true});if(r.result?.exceptionDetails)throw Error(r.result.exceptionDetails.exception?.description??r.result.exceptionDetails.text);return r.result?.result?.value;};
          const deadline=Date.now()+(isResource?370000:190000);
          while(!await evaluate(`!!window.${start}`)){if(Date.now()>deadline)throw Error('Study runtime initialization timeout');await new Promise(r=>setTimeout(r,100));}
          await requireFrameGraphPresentation(cdp);
          const parameters=isResource?[spec,plan]:[spec,job.variant,plan.sampling];
          await evaluate(`void window.${start}(${parameters.map(x=>JSON.stringify(x)).join(',')})`);
          let invisibleTicks=0;
          while(!await evaluate(`window.${ready}`)){
            const state=await readFrameGraphPresentation(cdp);
            invisibleTicks=state?.visible==='visible'&&state.focused===true?0:invisibleTicks+1;
            if(Date.now()>deadline||invisibleTicks>=3){
              entry.partial=await save(`${i}-partial.json`,await evaluate('window.studySnapshot?.()'));
              entry.presentation=state;
              const error=Error(invisibleTicks>=3?'Study presentation lost; partial capture retained':'Study capture timeout; partial capture retained');
              if(invisibleTicks>=3)error.code='G09_PRESENTATION_UNAVAILABLE';throw error;
            }
            await new Promise(r=>setTimeout(r,1000));
          }
          png=Buffer.from((await cdp.call('Page.captureScreenshot',{format:'png',fromSurface:true})).result.data,'base64');await evaluate(`window.${finish}()`);
        }});
      entry.raw=await save(`${i}.json`,raw);const file=`${i}.png`;await writeFile(resolve(directory,file),png);entry.image={file,sha256:sha256(png),validation:validateProductionScreenshot(png)};
      entry.assessment=isResource?assessResourceStudy(raw,job,config,plan):assessAblationStudy(raw,job,config,plan);
      if(!isResource){const key=`${job.browserId}/${job.caseId}`,previous=pictures.get(key);if(previous){entry.assessment.pixelParity={reference:previous.variant,...compareStudyPixels(png,previous.image)};if(!entry.assessment.pixelParity.passed)entry.assessment.status='failed';}else pictures.set(key,{variant:job.variant,image:png});}
      entry.status=entry.assessment.status;
    }catch(error){entry.status='invalid';entry.error=error.stack;entry.browserFailure=error.browserFailure;entry.presentationUnavailable=error.code==='G09_PRESENTATION_UNAVAILABLE';entry.presentation??=error.presentation;}
    await save('report.json',report);console.log(JSON.stringify({capture:i+1,total:plan.jobs.length,job,status:entry.status,error:entry.error?.split('\n')[0]}));
    if(entry.presentationUnavailable)throw Error('Visible sampling stopped; remaining registered jobs were not attempted. Restore presentation before a new attempt.');
    if(JSON.stringify(report.inputs)!==JSON.stringify(await fingerprint()))throw Error('Study inputs changed during capture');
  }
  report.inputsAfter=await fingerprint();
  if(smoke)report.status=report.entries.every(e=>e.status==='passed')?'smoke-complete':'invalid';
  else{report.audit=await auditFrameGraphStudy(report,reader(directory));report.status=report.audit.status;}
}catch(error){report.status='invalid';report.error=error.stack;}
finally{report.finishedAt=new Date().toISOString();await save('report.json',report);console.log(JSON.stringify({directory,status:report.status,error:report.error}));}
if(!['passed','smoke-complete'].includes(report.status))process.exitCode=1;
