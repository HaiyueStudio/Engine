const modes=['baseline-initial','baseline-warm','fallback-initial','fallback-popup-first','fallback-popup-static','fallback-modal-first','fallback-modal-static','fallback-toast-fresh','fallback-toast-enter','fallback-toast-expire','fallback-close-restore','readmit-first','readmit-warm','readmit-popup-first','readmit-popup-static','readmit-close-restore','wake'];
const check=(v,m)=>{if(!v)throw Error('G04 overlay admission: '+m);};
const cap=b=>check(Number.isSafeInteger(b?.retainedRegions)&&b.retainedRegions>=0&&b.retainedRegions<=8&&Number.isSafeInteger(b?.retainedBytes)&&b.retainedBytes>=0&&b.retainedBytes<=67108864,'shared cache cap');
export function validateOverlayAdmissionReport(report) {
  check(report?.status==='passed'&&report.caseCount===84&&report.cases?.length===84,'requires all84 cases');
  check(new Set(report.cases.map(c=>c.id)).size===84,'duplicate case');
  check(Array.isArray(report.errors)&&report.errors.length===0,'GPU error channel');let channels=0;
  for(const samples of [1,4])for(const dpr of [1,2]) {
    const get=id=>{const row=report.cases.find(c=>c.id===`${id}-${samples}-${dpr}`);check(row?.samples===samples&&row.dpr===dpr,'missing case '+id);return row;};
    for(const mode of modes) {
      const row=get(mode),fallback=mode.startsWith('fallback-'),initial=mode==='baseline-initial'||mode==='readmit-first',gui=fallback||initial?1:0,overlay=fallback||initial||mode==='readmit-popup-first'||mode==='readmit-close-restore'?1:0,a=row.regional;
      check(row.channelsCompared===384*240*dpr*dpr*4,'incomplete output pixels');
      check(Number.isFinite(row.maxRawChannelDifference)&&row.maxRawChannelDifference>=0&&row.maxRawChannelDifference<=2/255,'raw HDR tolerance');
      check([row.sha256,row.referenceSha256].every(h=>/^[0-9a-f]{64}$/.test(h)),'missing raw pixel hashes');
      check(a?.records?.gui===gui&&a.records.overlay===overlay&&a.records.scene===1,'producer record count');
      check(a.visibleMeshes===1&&row.ordinary?.visibleMeshes===1,'actual3D missing');
      check(gui!==0||a.layouts.gui===0&&a.guiUploads.gui===0,'static sidebar work');
      check(overlay!==0||a.layouts.overlay===0&&a.guiUploads.overlay===0,'static overlay work');
      check(Number.isFinite(a.cpuMs)&&a.cpuMs>=0&&a.passes>0&&a.frameDiagnostics?.counters?.draws>0,'CPU/pass/draw costs');
      check(Number.isFinite(row.queueAndReadbackWaitMs)&&row.queueAndReadbackWaitMs>=0,'separate readback wait');
      cap({retainedBytes:a.stats?.retainedColorBytes,retainedRegions:a.stats?.cachedRegions});
      if(fallback)check(a.stats.cachedRegions===6&&a.stats.fallbacks?.length===3&&a.stats.fallbacks.every(s=>s.endsWith(':region-count')),'ordered count fallback missing');
      else check(a.stats.cachedRegions===(mode.startsWith('baseline')?3:8)&&a.stats.fallbacks?.length===0,'complete re-admission missing');
      if(['fallback-popup-first','fallback-popup-static','fallback-modal-first','fallback-modal-static','fallback-toast-enter','readmit-popup-first','readmit-popup-static'].includes(mode))check(row.changedChannelsAcrossBoundary?.left>100&&row.changedChannelsAcrossBoundary.right>100,'overlay did not cross region boundary');
      if(['fallback-initial','fallback-close-restore','readmit-first','readmit-warm','readmit-close-restore','wake'].includes(mode))check(row.restoresUncoveredBaseline===true&&row.changedChannelsAcrossBoundary?.left===0&&row.changedChannelsAcrossBoundary.right===0,'baseline not restored');
      check(a.toast?.visible===row.ordinary.toast?.visible&&a.toast?.progress===row.ordinary.toast?.progress,'Toast clock mismatch');
      if(mode==='fallback-toast-fresh')check(a.toast.progress===0,'Toast consumed prior idle delta');
      if(mode==='fallback-toast-expire')check(a.toast.visible===false&&a.toast.animating===false,'Toast expiry did not stop animation');
      channels+=row.channelsCompared;
    }
    const pressure=get('pressure-installed');cap(pressure.budget);check(pressure.otherRegions===6&&pressure.sharedBudgetVerified===true&&pressure.budget.retainedRegions===6,'six shared owner slots missing');
    const freed=get('one-slot-released');cap(freed.budget);check(freed.budget.retainedRegions===5,'slot not retired');
    const idle=get('all-idle').regional;check(idle?.submitted===false&&['encoders','submits','uploads','acquisitions','passes'].every(k=>idle[k]===0)&&idle.records?.gui===0&&idle.records.overlay===0&&idle.records.scene===0,'idle work');
    const cleanup=get('cache-cleanup').budget;check(cleanup?.retainedRegions===0&&cleanup.retainedBytes===0,'cache reservation residue');
  }
  check(report.residue?.buffer?.current===0&&report.residue?.texture?.current===0,'GPU resource residue');
  return {cases:84,pixelComparisons:68,channelsCompared:channels,otherRegions:6,productRegions:3,cacheLimitRegions:8,cacheLimitBytes:67108864};
}
