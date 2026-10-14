import { sha256 } from './deferred-fixture-policy.mjs';
import { frameGraphStudyPlan, assessResourceStudy, assessAblationStudy, compareStudyPixels } from './framegraph-study-policy.mjs';
import { validateProductionScreenshot } from './framegraph-production-policy.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function auditFrameGraphStudy(report,readBound) {
  const plan=frameGraphStudyPlan(report.config,report.mode);
  if(report.schemaVersion!==1||report.tier!=='local-full'||!same(report.plan,plan)||!same(report.inputs,report.inputsAfter)||
    report.entries?.length!==plan.jobs.length||!/^[a-f0-9]{64}$/.test(report.inputs?.runtime?.sha256??'')||
    !/^[a-f0-9]{40}$/.test(report.revision??'')||typeof report.dirty!=='boolean')throw Error('Incomplete/unbound study report');
  const registration=await readBound(report.registration.file);
  if(sha256(registration)!==report.registration.sha256)throw Error('Study registration changed');
  const registered=JSON.parse(registration);
  for(const key of ['plan','config','inputs','build','revision','dirty','host'])if(!same(registered[key],report[key]))throw Error(`Study registration ${key} differs`);
  if(!Number.isFinite(Date.parse(registered.registeredAt)))throw Error('Missing study registration time');
  if(!report.build?.some(b=>b.file==='fixture.js'))throw Error('Missing study runtime entry');
  for(const b of report.build)if(sha256(await readBound(`runtime/${b.file}`))!==b.sha256)throw Error('Study runtime changed');
  const entries=[],pictures=new Map();
  for(const [i,entry]of report.entries.entries()){
    const job=plan.jobs[i];if(!same(entry.job,job))throw Error('Reordered study capture');
    if(!entry.raw){entries.push({job,status:'invalid',error:entry.error});continue;}
    const bytes=await readBound(entry.raw.file);if(sha256(bytes)!==entry.raw.sha256)throw Error('Raw study capture changed');
    const raw=JSON.parse(bytes);
    if(!Number.isFinite(Date.parse(raw.startedAt))||Date.parse(raw.startedAt)<Date.parse(registered.registeredAt))throw Error('Study capture predates registration');
    for(const b of report.build){const served=raw.httpProvenance?.files?.find(f=>f.sourcePath===`probe-runtime/${b.file}`);
      if((!served&&b.file==='fixture.js')||served&&served.sha256!==b.sha256)throw Error('Served study runtime differs');}
    try{
      const assessment=report.mode==='resources'?assessResourceStudy(raw,job,report.config,plan):assessAblationStudy(raw,job,report.config,plan);
      const image=await readBound(entry.image.file);if(sha256(image)!==entry.image.sha256)throw Error('Study image changed');validateProductionScreenshot(image);
      if(report.mode==='ablation'){
        const key=`${job.browserId}/${job.caseId}`,previous=pictures.get(key);
        if(previous){assessment.pixelParity={reference:previous.variant,...compareStudyPixels(image,previous.image)};if(!assessment.pixelParity.passed)assessment.status='failed';}
        else pictures.set(key,{variant:job.variant,image});
      }
      entries.push({job,...assessment});
    }catch(error){entries.push({job,status:'invalid',error:error.message});}
  }
  const benefits=[];
  if(report.mode==='ablation')for(const e of entries.filter(e=>e.job.variant==='B2'&&e.status==='passed')){
    const before=entries.find(b=>b.job.browserId===e.job.browserId&&b.job.caseId===e.job.caseId&&b.job.variant==='B1');
    if(before?.status!=='passed')continue;
    for(const [pool,stats]of Object.entries(e.metrics.pools)){
      const previous=before.metrics.pools[pool];
      if(previous&&previous.physicalBytes>stats.physicalBytes)benefits.push({browserId:e.job.browserId,caseId:e.job.caseId,pool,
        beforeBytes:previous.physicalBytes,afterBytes:stats.physicalBytes,savedBytes:previous.physicalBytes-stats.physicalBytes,
        reductionRatio:1-stats.physicalBytes/previous.physicalBytes,scope:'Measured physical texture allocation estimate with display pixel parity; not VRAM residency or FPS gain'});
    }
  }
  const status=entries.some(e=>e.status==='invalid')?'invalid':entries.some(e=>e.status==='inconclusive')?'inconclusive':entries.some(e=>e.status!=='passed')||report.mode==='ablation'&&!benefits.length?'failed':'passed';
  return {status,entries,benefits,releaseQualified:false,cleanCandidate:!report.dirty,scope:'This registered study only; complete G09/G05/G07 require independent same-candidate evidence'};
}
