const pixels=['small-initial','small-warm','large-first','large-settled','large-warm','large-GUI-first-update','readmit-first','readmit-warm','shrink-first','shrink-warm','wake'];
const warm=['small-warm','large-warm','readmit-warm','shrink-warm','wake'];
const check=(value,message)=>{if(!value)throw Error('G04 cache admission: '+message);};
function bounded(bytes,regions) {check(Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=67108864&&Number.isSafeInteger(regions)&&regions>=0&&regions<=8,'cache budget exceeded or missing');}
export function validateAdmissionReport(report) {
  check(report?.status==='passed'&&report.caseCount===30&&report.cases?.length===30,'requires all30 cases');
  check(new Set(report.cases.map(row=>row.id)).size===30,'duplicate case');
  check(Array.isArray(report.errors)&&!report.errors.length,'GPU error channel');
  let channels=0;
  for(const samples of [1,4]) {
    const get=mode=>{const row=report.cases.find(row=>row.id===`${mode}-msaa${samples}`);check(row?.samples===samples,'missing case '+mode);return row;};
    for(const mode of pixels) {
      const row=get(mode),large=mode.startsWith('large-')||mode.startsWith('readmit-');
      check(row.width===(large?1024:384)&&row.height===(large?720:216),'output dimensions');
      check(row.channelsCompared===row.width*row.height*4,'not all pixels compared');
      check(Number.isInteger(row.maxChannelDifference)&&row.maxChannelDifference>=0&&row.maxChannelDifference<=2,'pixel tolerance exceeded');
      check([row.sha256,row.referenceSha256].every(h=>/^[0-9a-f]{64}$/.test(h)),'pixel hash missing');
      check(Number.isFinite(row.queueAndReadbackWaitMs)&&row.queueAndReadbackWaitMs>=0,'queue/readback wait missing');
      const a=row.regional,s=a?.stats;bounded(s?.retainedColorBytes,s?.cachedRegions);
      check(Number.isFinite(a?.cpuMs)&&a.cpuMs>=0&&a.passes>0&&a.frameDiagnostics?.counters?.draws>0,'CPU/pass/draw cost missing');
      check(a.records?.scene===1&&a.visibleMeshes===2&&row.ordinary?.visibleMeshes===2,'actual3D missing');
      if(warm.includes(mode))check(a.records.gui===0&&a.solves===0&&a.guiUploads===0,'warm GUI repeated work');
      if(mode==='large-GUI-first-update')check(a.records.gui===1,'first GUI mutation frame missed');
      if(['small-initial','readmit-first','readmit-warm','shrink-warm'].includes(mode))check(s.cachedRegions===2&&s.fallbacks?.length===0,'full caching/re-admission not restored');
      if(['large-settled','large-warm','large-GUI-first-update'].includes(mode))check(s.cachedRegions===2&&s.retainedColorBytes===62914560+96*720*8*(samples===4?5:1)&&s.fallbacks?.includes('scene:color-bytes'),'partial admission failed to preserve sidebar/external owner');
      if(mode==='large-first')check(s.fallbacks?.length>0,'no pressure transition exercised');
      if(mode==='shrink-warm')check(s.retainedColorBytes===384*216*8*(samples===4?5:1),'old large targets remain retained');
      channels+=row.channelsCompared;
    }
    const pressure=get('pressure-allocated');check(pressure.bytes===62914560&&pressure.sharedBudgetVerified===true,'real shared60MiB pressure missing');bounded(pressure.budget?.retainedBytes,pressure.budget?.retainedRegions);
    check(pressure.budget.retainedBytes===62914560+384*216*8*(samples===4?5:1)&&pressure.budget.retainedRegions===3,'pressure does not share product budget');
    const retired=get('pressure-retired');bounded(retired.before?.retainedBytes,retired.before?.retainedRegions);bounded(retired.after?.retainedBytes,retired.after?.retainedRegions);check(retired.before.retainedBytes-retired.after.retainedBytes===62914560,'other-owner retirement did not release exact pressure');
    const idle=get('all-idle').regional;check(idle?.submitted===false&&['encoders','submits','acquired','uploads','passes','solves','guiUploads','textureUploads'].every(k=>idle[k]===0)&&idle.records?.gui===0&&idle.records.scene===0,'idle rendering work');
    const cleanup=get('cache-cleanup').budget;check(cleanup?.retainedBytes===0&&cleanup.retainedRegions===0,'cache reservation residue');
  }
  check(report.residue?.buffer?.current===0&&report.residue?.texture?.current===0,'GPU resource residue');
  return {cases:30,pixelComparisons:22,channelsCompared:channels,cacheLimitBytes:67108864,cacheLimitRegions:8};
}
export function validateCompleteAdmissionReport(report) {
  check(report?.status==='passed'&&report.caseCount===90&&report.cases?.length===90,'requires all3 complete clear-mode matrices');
  check(new Set(report.cases.map(row=>row.id)).size===90,'duplicate cross-clear case');
  const groups={};let channels=0;
  for(const clearMode of ['on-update','once','never-after-initialization']) {
    const suffix=clearMode==='on-update'?'':'-'+clearMode;
    const cases=report.cases.filter(row=>row.clearMode===clearMode).map(row=>({...row,id:suffix?row.id.endsWith(suffix)?row.id.slice(0,-suffix.length):'invalid-clear-suffix':row.id}));
    groups[clearMode]=validateAdmissionReport({...report,caseCount:30,cases});channels+=groups[clearMode].channelsCompared;
    for(const row of cases)if(row.channelsCompared) {
      const phase=row.id.replace(/-msaa[14]$/,''),history=row.ordinary?.referenceHistory,direct=phase.startsWith('large-');
      const load=clearMode!=='on-update'&&['small-warm','readmit-warm','shrink-warm','wake'].includes(phase);
      check(history?.space==='display-linear'&&history.nativeSamples===row.samples&&history.presentationSamples===1&&history.initialized===true,'ordinary reference must preserve native linear history before final single-sample composition');
      check(history.direct===direct&&history.load===load,'reference history must follow clear/storage generation semantics');
    }
  }
  return {cases:90,pixelComparisons:66,channelsCompared:channels,clearModes:Object.keys(groups),cacheLimitBytes:67108864,cacheLimitRegions:8,groups};
}
