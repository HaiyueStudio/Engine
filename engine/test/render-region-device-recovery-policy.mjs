const pixelModes = ['initial','static-GUI','mutation-first-frame','restore-first-frame','restore-static-GUI','resize-restore-first-frame','resize-restore-static-GUI','wake-after-two-losses'];
const idleModes = ['before-loss-idle','after-loss-idle','resize-loss-idle'];
const lostModes = ['device-loss-1','device-loss-2-with-resize-DPR'];
const zeroWork = ['encoders','submits','uploads','bufferUploadBytes','textureUploads','textureUploadTexels','acquired','passes','guiRecords','sceneRecords','layouts','guiUploads'];
const check = (value,message) => { if(!value) throw Error(`G04 native device recovery: ${message}`); };
function validateRecoveryMatrix(report,once=false) {
  const pixels=once?['initial','static-GUI','muted-invalidation','explicit-pulse','restore-pending','warm-pending','restore-consumed','warm-consumed']:pixelModes;
  const idle=once?['before-loss-idle','consumed-idle','after-loss-idle']:idleModes;
  const lost=once?['loss-pending','loss-consumed']:lostModes;
  check(report?.status==='passed' && report.caseCount===28 && report.cases?.length===28,'requires all 28 cases');
  check(Array.isArray(report.errors) && report.errors.length===0,'GPU/cleanup error channel is not clean');
  const ids=new Set(report.cases.map(row=>row.id)); check(ids.size===28,'duplicate case');
  let channels=0;
  for(const samples of [1,4]) {
    const get=mode=>{
      const row=report.cases.find(row=>row.id===`${once?'once-':''}${mode}-msaa${samples}`);
      check(row?.samples===samples,`missing ${mode}/MSAA${samples}`); return row;
    };
    for(const mode of pixels) {
      const row=get(mode), resized=!once&&(mode.startsWith('resize-')||mode==='wake-after-two-losses');
      check(row.width===(resized?312:192) && row.height===(resized?216:128),'wrong canvas/DPR dimensions');
      check(row.channelsCompared===row.width*row.height*4,'incomplete full canvas pixel comparison');
      check(Number.isInteger(row.maxChannelDifference) && row.maxChannelDifference>=0 && row.maxChannelDifference<=2,'pixel tolerance exceeded');
      check([row.sha256,row.controlSha256].every(value=>/^[0-9a-f]{64}$/.test(value)),'missing pixel hash');
      check(row.image?.expected?.length===4 && [row.image.candidate,row.image.control].every(pixel=>pixel?.length===4 && pixel.every((value,index)=>Number.isInteger(value)&&Math.abs(value-row.image.expected[index])<=2)),'image source was blank or not rebuilt');
      const gui=(once?['initial','explicit-pulse','restore-pending','restore-consumed'].includes(mode):mode==='initial'||mode==='mutation-first-frame'||mode.endsWith('first-frame'))?1:0;
      for(const metrics of [row.candidate,row.control]) {
        check(metrics?.guiRecords===gui && metrics.sceneRecords===1,'first/warm frame did not record expected producers');
        check(gui!==0 || (once&&mode==='muted-invalidation'||metrics.layouts===0) && metrics.guiUploads===0,'unchanged GUI layout or upload');
        check(Number.isFinite(metrics.cpuRecordMs)&&metrics.cpuRecordMs>=0 && Number.isFinite(metrics.queueAndReadbackWaitMs)&&metrics.queueAndReadbackWaitMs>=0,'missing separate CPU/readback costs');
      }
      channels+=row.channelsCompared;
    }
    for(const mode of idle) for(const metrics of [get(mode).candidate,get(mode).control]) {
      check(zeroWork.every(key=>metrics?.[key]===0),'all-static frame performed work');
      check(Object.values(metrics.allocations??{}).every(value=>value===0),'all-static frame allocated resources');
    }
    for(let index=0;index<lost.length;index++) {
      const row=get(lost[index]); check(row.generation===index+2,'device was not replaced exactly once');
      check(row.adapter?.isFallbackAdapter===false,'software/fallback adapter');
      check(row.events?.some(e=>e.event==='device-lost' && e.detail?.reason==='destroyed') && row.events.some(e=>e.event==='device-restored' && e.detail?.generation===row.generation),'missing actual lost/restored events');
      check(!row.events.some(e=>e.event==='recovery-failed'),'device recovery failed');
    }
    const row=get('engine-destroy');
    for(const [owner,generations] of [['candidate',3],['control',1]]) {
      const cleanup=row[owner]; check(cleanup?.devices===generations,'teardown device count mismatch');
      check(cleanup.byType?.buffer?.current===0 && cleanup.byType?.texture?.current===0,'buffer/texture residue');
      check(cleanup.adapters?.length===generations && cleanup.adapters.every(adapter=>adapter.isFallbackAdapter===false),'unqualified adapter generation');
    }
  }
  return {cases:28,pixelComparisons:16,channelsCompared:channels,deviceReplacements:4};
}
export function validateDeviceRecoveryReport(report) { return validateRecoveryMatrix(report); }
export function validateCompleteDeviceRecoveryReport(report) {
  check(report?.status==='passed' && report.caseCount===56 && report.cases?.length===56,'requires both complete demand and once matrices');
  check(report.onceWorkload?.guiMode==='once' && report.onceWorkload.clearMode==='once' && report.onceWorkload.dirtyContentDoesNotPulse===true && report.onceWorkload.pendingPulseSurvivesLoss===true && report.onceWorkload.consumedOnceStorageRebuildsWithoutCandidatePulse===true,'once workload contract missing');
  const original=validateRecoveryMatrix({...report,caseCount:28,cases:report.cases.filter(row=>!row.id.startsWith('once-'))});
  const once=validateRecoveryMatrix({...report,caseCount:28,cases:report.cases.filter(row=>row.id.startsWith('once-'))},true);
  for(const samples of [1,4]) {
    const pending=report.cases.find(row=>row.id===`once-loss-pending-msaa${samples}`);
    check(pending?.pulseDuringLoss===true && pending.controlHistoryReinitialized===true,'pending once pulse or matching history generation was not exercised');
    const consumed=report.cases.find(row=>row.id===`once-loss-consumed-msaa${samples}`);
    check(consumed?.candidatePulseDuringLoss===false && consumed.controlPulseForFreshReadback===true && consumed.controlHistoryReinitialized===true,'consumed-once recovery was hidden by a candidate pulse or unmatched history');
  }
  return {cases:56,pixelComparisons:32,channelsCompared:original.channelsCompared+once.channelsCompared,deviceReplacements:8,demand:original,once};
}
