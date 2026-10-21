import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateOverlayAdmissionReport} from './render-region-overlay-admission-policy.mjs';
function report() {
 const cases=[],modes=['baseline-initial','baseline-warm','fallback-initial','fallback-popup-first','fallback-popup-static','fallback-modal-first','fallback-modal-static','fallback-toast-fresh','fallback-toast-enter','fallback-toast-expire','fallback-close-restore','readmit-first','readmit-warm','readmit-popup-first','readmit-popup-static','readmit-close-restore','wake'];
 for(const samples of [1,4])for(const dpr of [1,2]) {
  const row=(id,data)=>({id:`${id}-${samples}-${dpr}`,samples,dpr,...data});
  for(const mode of modes) {
   const fallback=mode.startsWith('fallback-'),initial=mode==='baseline-initial'||mode==='readmit-first',gui=fallback||initial?1:0,overlay=fallback||initial||mode==='readmit-popup-first'||mode==='readmit-close-restore'?1:0;
   const restores=['fallback-initial','fallback-close-restore','readmit-first','readmit-warm','readmit-close-restore','wake'].includes(mode),toast={visible:false,animating:false,progress:0};
   cases.push(row(mode,{channelsCompared:384*240*dpr*dpr*4,maxRawChannelDifference:0,sha256:'a'.repeat(64),referenceSha256:'a'.repeat(64),queueAndReadbackWaitMs:.1,restoresUncoveredBaseline:restores,changedChannelsAcrossBoundary:restores?{left:0,right:0}:{left:200,right:200},ordinary:{visibleMeshes:1,toast:{...toast}},regional:{cpuMs:.1,passes:4,frameDiagnostics:{counters:{draws:5}},visibleMeshes:1,records:{gui,overlay,scene:1},layouts:{gui:0,overlay:0},guiUploads:{gui:0,overlay:0},toast,stats:{retainedColorBytes:1000,cachedRegions:fallback?6:mode.startsWith('baseline')?3:8,fallbacks:fallback?['sidebar:region-count','scene:region-count','global-overlay:region-count']:[]}}}));
  }
  cases.push(row('pressure-installed',{otherRegions:6,sharedBudgetVerified:true,budget:{retainedBytes:1000,retainedRegions:6}}));
  cases.push(row('one-slot-released',{budget:{retainedBytes:500,retainedRegions:5}}));
  cases.push(row('all-idle',{regional:{submitted:false,encoders:0,submits:0,uploads:0,acquisitions:0,passes:0,records:{gui:0,overlay:0,scene:0}}}));
  cases.push(row('cache-cleanup',{budget:{retainedBytes:0,retainedRegions:0}}));
 }
 return {status:'passed',caseCount:84,cases,errors:[],residue:{buffer:{current:0},texture:{current:0}}};
}
test('count-pressure matrix includes all68 full HDR pixel comparisons and unchanged caps',()=>assert.deepEqual(validateOverlayAdmissionReport(report()),{cases:84,pixelComparisons:68,channelsCompared:62668800,otherRegions:6,productRegions:3,cacheLimitRegions:8,cacheLimitBytes:67108864}));
for(const [name,mutate] of [
 ['missing case',r=>r.cases.pop()],
 ['partial pixels',r=>r.cases[0].channelsCompared--],
 ['wrong DPR',r=>r.cases[0].dpr=2],
 ['raw tolerance exceeded',r=>r.cases[0].maxRawChannelDifference=.008],
 ['fallback producer omitted',r=>r.cases.find(c=>c.id==='fallback-popup-first-1-1').regional.records.gui=0],
 ['count fallback not recorded',r=>r.cases.find(c=>c.id==='fallback-initial-1-1').regional.stats.fallbacks=[]],
 ['failed re-admission',r=>r.cases.find(c=>c.id==='readmit-first-1-1').regional.stats.cachedRegions=6],
 ['independent pressure instance',r=>r.cases.find(c=>c.id==='pressure-installed-1-1').sharedBudgetVerified=false],
 ['slot not retired',r=>r.cases.find(c=>c.id==='one-slot-released-1-1').budget.retainedRegions=6],
 ['overlay clipped to one region',r=>r.cases.find(c=>c.id==='fallback-popup-first-1-1').changedChannelsAcrossBoundary.right=0],
 ['uncovered baseline not restored',r=>r.cases.find(c=>c.id==='fallback-close-restore-1-1').changedChannelsAcrossBoundary.left=1],
 ['expired Toast still animates',r=>r.cases.find(c=>c.id==='fallback-toast-expire-1-1').regional.toast.animating=true],
 ['GPU resource residue',r=>r.residue.texture.current=1],
]) test(`rejects ${name}`,()=>{const r=report();mutate(r);assert.throws(()=>validateOverlayAdmissionReport(r),/G04 overlay admission/);});
