import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDeviceRecoveryReport,validateCompleteDeviceRecoveryReport} from './render-region-device-recovery-policy.mjs';

function report() {
  const cases=[],metrics=gui=>({guiRecords:gui,sceneRecords:1,layouts:0,guiUploads:0,cpuRecordMs:.1,queueAndReadbackWaitMs:.1});
  for(const samples of [1,4]) {
    for(const mode of ['initial','static-GUI','mutation-first-frame','restore-first-frame','restore-static-GUI','resize-restore-first-frame','resize-restore-static-GUI','wake-after-two-losses']) {
      const resized=mode.startsWith('resize-')||mode==='wake-after-two-losses',width=resized?312:192,height=resized?216:128,gui=mode==='initial'||mode==='mutation-first-frame'||mode.endsWith('first-frame')?1:0;
      cases.push({id:`${mode}-msaa${samples}`,samples,width,height,channelsCompared:width*height*4,maxChannelDifference:0,sha256:'a'.repeat(64),controlSha256:'a'.repeat(64),image:{expected:[32,192,80,255],candidate:[32,192,80,255],control:[32,192,80,255]},candidate:metrics(gui),control:metrics(gui)});
    }
    for(const mode of ['before-loss-idle','after-loss-idle','resize-loss-idle']) {
      const zero=Object.fromEntries(['encoders','submits','uploads','bufferUploadBytes','textureUploads','textureUploadTexels','acquired','passes','guiRecords','sceneRecords','layouts','guiUploads'].map(key=>[key,0]));
      cases.push({id:`${mode}-msaa${samples}`,samples,candidate:{...zero,allocations:{texture:0}},control:{...zero,allocations:{texture:0}}});
    }
    for(const [index,mode] of ['device-loss-1','device-loss-2-with-resize-DPR'].entries()) cases.push({id:`${mode}-msaa${samples}`,samples,generation:index+2,adapter:{isFallbackAdapter:false},events:[{event:'device-lost',detail:{reason:'destroyed'}},{event:'device-restored',detail:{generation:index+2}}]});
    const cleanup=devices=>({devices,byType:{buffer:{current:0},texture:{current:0}},adapters:Array.from({length:devices},()=>({isFallbackAdapter:false}))});
    cases.push({id:`engine-destroy-msaa${samples}`,samples,candidate:cleanup(3),control:cleanup(1)});
  }
  return {status:'passed',caseCount:28,cases,errors:[]};
}
test('requires complete native recovery matrix, pixels and separate cost channels',()=>assert.equal(validateDeviceRecoveryReport(report()).deviceReplacements,4));
for(const [name,mutate] of [
  ['missing case',r=>r.cases.pop()],
  ['duplicate case',r=>r.cases[1]=r.cases[0]],
  ['partial pixels',r=>r.cases[0].channelsCompared--],
  ['over tolerance',r=>r.cases[0].maxChannelDifference=3],
  ['blank image source',r=>r.cases[0].image.candidate=[0,0,0,255]],
  ['GUI still draws',r=>r.cases[1].candidate.guiRecords=1],
  ['merged CPU/readback',r=>delete r.cases[0].candidate.queueAndReadbackWaitMs],
  ['idle presentation acquisition',r=>r.cases.find(row=>row.id==='before-loss-idle-msaa1').candidate.acquired=1],
  ['fake device replacement',r=>r.cases.find(row=>row.id==='device-loss-1-msaa1').generation=1],
  ['missing native loss event',r=>r.cases.find(row=>row.id==='device-loss-1-msaa1').events=[]],
  ['fallback device',r=>r.cases.find(row=>row.id==='device-loss-1-msaa1').adapter.isFallbackAdapter=true],
  ['leaked texture',r=>r.cases.find(row=>row.id==='engine-destroy-msaa1').candidate.byType.texture.current=1],
  ['GPU error',r=>r.errors.push('validation')],
]) test(`rejects ${name}`,()=>{const r=report();mutate(r);assert.throws(()=>validateDeviceRecoveryReport(r),/G04 native device recovery/);});

function completeReport() {
  const original=report(),once=structuredClone(original.cases),mapping={
    initial:'initial','static-GUI':'static-GUI','mutation-first-frame':'explicit-pulse','restore-first-frame':'restore-pending','restore-static-GUI':'warm-pending','resize-restore-first-frame':'restore-consumed','resize-restore-static-GUI':'warm-consumed','wake-after-two-losses':'muted-invalidation',
    'before-loss-idle':'before-loss-idle','after-loss-idle':'consumed-idle','resize-loss-idle':'after-loss-idle','device-loss-1':'loss-pending','device-loss-2-with-resize-DPR':'loss-consumed','engine-destroy':'engine-destroy',
  };
  for(const row of once) {
    const mode=row.id.replace(/-msaa[14]$/,''); row.id=`once-${mapping[mode]}-msaa${row.samples}`;
    if(row.width) { row.width=192;row.height=128;row.channelsCompared=192*128*4; }
    if(mode==='device-loss-1') { row.pulseDuringLoss=true;row.controlHistoryReinitialized=true; }
    if(mode==='device-loss-2-with-resize-DPR') { row.candidatePulseDuringLoss=false;row.controlPulseForFreshReadback=true;row.controlHistoryReinitialized=true; }
  }
  return {...original,caseCount:56,cases:[...original.cases,...once],onceWorkload:{guiMode:'once',clearMode:'once',dirtyContentDoesNotPulse:true,pendingPulseSurvivesLoss:true,consumedOnceStorageRebuildsWithoutCandidatePulse:true}};
}
test('complete recovery keeps demand and once evidence separate and requires eight native replacements',()=>assert.deepEqual(
  validateCompleteDeviceRecoveryReport(completeReport()),{cases:56,pixelComparisons:32,channelsCompared:4173312,deviceReplacements:8,demand:{cases:28,pixelComparisons:16,channelsCompared:2600448,deviceReplacements:4},once:{cases:28,pixelComparisons:16,channelsCompared:1572864,deviceReplacements:4}}));
for(const [name,mutate] of [
  ['missing once case',r=>r.cases.pop()],
  ['invalidations auto-pulse once',r=>r.cases.find(row=>row.id==='once-muted-invalidation-msaa1').candidate.guiRecords=1],
  ['consumed candidate gets a hidden pulse',r=>r.cases.find(row=>row.id==='once-loss-consumed-msaa1').candidatePulseDuringLoss=true],
  ['pending pulse not exercised',r=>r.cases.find(row=>row.id==='once-loss-pending-msaa1').pulseDuringLoss=false],
  ['history generations differ',r=>r.cases.find(row=>row.id==='once-loss-pending-msaa1').controlHistoryReinitialized=false],
  ['clear mode changed',r=>r.onceWorkload.clearMode='on-update'],
  ['once device not replaced',r=>r.cases.find(row=>row.id==='once-loss-consumed-msaa1').generation=2],
  ['once output partially checked',r=>r.cases.find(row=>row.id==='once-restore-pending-msaa1').channelsCompared=4],
  ['once image is empty',r=>r.cases.find(row=>row.id==='once-restore-pending-msaa1').image.candidate=[0,0,0,255]],
  ['once idle allocates',r=>r.cases.find(row=>row.id==='once-consumed-idle-msaa1').candidate.allocations.texture=1],
  ['once upload while GUI frozen',r=>r.cases.find(row=>row.id==='once-muted-invalidation-msaa1').candidate.guiUploads=1],
]) test(`complete report rejects ${name}`,()=>{const r=completeReport();mutate(r);assert.throws(()=>validateCompleteDeviceRecoveryReport(r),/G04 native device recovery/);});
