import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateAdmissionReport,validateCompleteAdmissionReport} from './render-region-admission-policy.mjs';
function report() {
  const cases=[];
  for(const samples of [1,4]) {
    const factor=samples===4?5:1,small=384*216*8*factor,large=1024*720*8*factor,side=96*720*8*factor;
    for(const mode of ['small-initial','small-warm','large-first','large-settled','large-warm','large-GUI-first-update','readmit-first','readmit-warm','shrink-first','shrink-warm','wake']) {
      const isLarge=mode.startsWith('large-')||mode.startsWith('readmit-'),pressure=mode.startsWith('large-'),width=isLarge?1024:384,height=isLarge?720:216,gui=['small-initial','large-GUI-first-update','shrink-first'].includes(mode)?1:0;
      cases.push({id:`${mode}-msaa${samples}`,samples,width,height,channelsCompared:width*height*4,maxChannelDifference:0,sha256:'a'.repeat(64),referenceSha256:'a'.repeat(64),queueAndReadbackWaitMs:.1,ordinary:{visibleMeshes:2},regional:{cpuMs:.1,passes:2,frameDiagnostics:{counters:{draws:4}},records:{gui,scene:1},visibleMeshes:2,solves:0,guiUploads:0,stats:{cachedRegions:2,retainedColorBytes:pressure?62914560+side:isLarge?large:small,fallbacks:pressure?['scene:color-bytes']:[]}}});
    }
    cases.push({id:`pressure-allocated-msaa${samples}`,samples,bytes:62914560,sharedBudgetVerified:true,budget:{retainedBytes:62914560+small,retainedRegions:3}});
    cases.push({id:`pressure-retired-msaa${samples}`,samples,before:{retainedBytes:62914560+side,retainedRegions:2},after:{retainedBytes:side,retainedRegions:1}});
    cases.push({id:`all-idle-msaa${samples}`,samples,regional:{submitted:false,encoders:0,submits:0,acquired:0,uploads:0,passes:0,solves:0,guiUploads:0,textureUploads:0,records:{gui:0,scene:0}}});
    cases.push({id:`cache-cleanup-msaa${samples}`,samples,budget:{retainedBytes:0,retainedRegions:0}});
  }
  return {status:'passed',caseCount:30,cases,errors:[],residue:{buffer:{current:0},texture:{current:0}}};
}
test('full admission matrix covers22 complete pixel comparisons and original cache caps',()=>assert.deepEqual(validateAdmissionReport(report()),{cases:30,pixelComparisons:22,channelsCompared:38707200,cacheLimitBytes:67108864,cacheLimitRegions:8}));
for(const [name,mutate] of [
 ['missing case',r=>r.cases.pop()],
 ['partial output',r=>r.cases[0].channelsCompared--],
 ['isolated pressure budget',r=>r.cases.find(c=>c.id==='pressure-allocated-msaa1').sharedBudgetVerified=false],
 ['pressure outside product accounting',r=>r.cases.find(c=>c.id==='pressure-allocated-msaa1').budget.retainedBytes=62914560],
 ['cache limit exceeded',r=>r.cases[0].regional.stats.retainedColorBytes=67108865],
 ['no fallback recorded',r=>r.cases.find(c=>c.id==='large-warm-msaa1').regional.stats.fallbacks=[]],
 ['warm GUI redraw',r=>r.cases.find(c=>c.id==='large-warm-msaa1').regional.records.gui=1],
 ['first GUI update missing',r=>r.cases.find(c=>c.id==='large-GUI-first-update-msaa1').regional.records.gui=0],
 ['failed re-admission',r=>r.cases.find(c=>c.id==='readmit-first-msaa1').regional.stats.fallbacks=['scene:color-bytes']],
 ['large allocation still retained',r=>r.cases.find(c=>c.id==='shrink-warm-msaa1').regional.stats.retainedColorBytes=5898240],
 ['wrong retirement bytes',r=>r.cases.find(c=>c.id==='pressure-retired-msaa1').after.retainedBytes++],
 ['GPU resource residue',r=>r.residue.texture.current=1],
 ['GPU error',r=>r.errors.push('validation')],
]) test(`rejects ${name}`,()=>{const r=report();mutate(r);assert.throws(()=>validateAdmissionReport(r),/G04 cache admission/);});

function completeReport() {
 const cases=[];
 for(const clearMode of ['on-update','once','never-after-initialization'])for(const row of report().cases) {
  const phase=row.id.replace(/-msaa[14]$/,''),id=row.id+(clearMode==='on-update'?'':'-'+clearMode);
  if(row.channelsCompared)row.ordinary.referenceHistory={space:'display-linear',nativeSamples:row.samples,presentationSamples:1,initialized:true,direct:phase.startsWith('large-'),load:clearMode!=='on-update'&&['small-warm','readmit-warm','shrink-warm','wake'].includes(phase)};
  cases.push({...row,id,clearMode});
 }
 return {...report(),caseCount:90,cases};
}
test('all three clear modes retain independent history and complete66 output comparisons',()=>{
 const v=validateCompleteAdmissionReport(completeReport());assert.equal(v.cases,90);assert.equal(v.pixelComparisons,66);assert.equal(v.channelsCompared,116121600);assert.deepEqual(v.clearModes,['on-update','once','never-after-initialization']);
});
for(const [name,mutate] of [
 ['missing clear cohort',r=>r.cases=r.cases.filter(c=>c.clearMode!=='once')],
 ['wrong clear mode',r=>r.cases[0].clearMode='auto'],
 ['duplicate matrix identifiers',r=>r.cases[30].id=r.cases[0].id],
 ['once history cleared each frame',r=>r.cases.find(c=>c.id==='small-warm-msaa4-once').ordinary.referenceHistory.load=false],
 ['old MSAA output resolved again',r=>r.cases[0].ordinary.referenceHistory.presentationSamples=4],
 ['history blended in encoded space',r=>r.cases[0].ordinary.referenceHistory.space='srgb'],
 ['fallback preserves incompatible history',r=>r.cases.find(c=>c.id==='large-warm-msaa4-once').ordinary.referenceHistory.load=true],
 ['native sample history collapsed',r=>r.cases.find(c=>c.id==='small-warm-msaa4-once').ordinary.referenceHistory.nativeSamples=1],
 ['once warm GUI uploads',r=>r.cases.find(c=>c.id==='small-warm-msaa4-once').regional.guiUploads=1],
 ['private pressure budget',r=>r.cases.find(c=>c.id==='pressure-allocated-msaa4-once').sharedBudgetVerified=false],
 ['clear-never cleanup leaks',r=>r.cases.find(c=>c.id==='cache-cleanup-msaa4-never-after-initialization').budget.retainedBytes=1],
]) test(`complete report rejects ${name}`,()=>{const r=completeReport();mutate(r);assert.throws(()=>validateCompleteAdmissionReport(r),/G04 cache admission/);});
