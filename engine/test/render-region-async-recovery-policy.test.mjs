import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateAsyncRecoveryReport} from './render-region-async-recovery-policy.mjs';
const phases=['initial','warm','loss-ready-timing','restore-first','visible-ready-first','warm-ready','font-confirmed','font-warm','modal-close','modal-reopen','loss-disabled','disabled-restore-first','disabled-image-ready','reenable-first','reenable-warm','all-idle','wake','cleanup'];
const zero=Object.fromEntries(['encoders','submits','uploads','bufferUploadBytes','textureUploads','textureUploadTexels','acquired','passes','guiRecords','sceneRecords','layouts','guiUploads','overlayRecords','overlayLayouts','overlayUploads'].map(k=>[k,0]));
function report(){
 const cases=[];
 for(const scenario of ['during','after'])for(const samples of [1,4])for(const phase of phases){
  const row={id:`${phase}-${scenario}-msaa${samples}`,scenario,samples};cases.push(row);
  if(phase==='cleanup'){
   const owner=n=>({devices:n,adapters:Array.from({length:n},()=>({isFallbackAdapter:false})),imageListeners:0,canvasListeners:0,remaining:[],byType:{buffer:{current:0},texture:{current:0}}});
   Object.assign(row,{candidate:owner(3),control:owner(1),fontListeners:0});continue;
  }
  if(phase.startsWith('loss-')){
   const generation=phase==='loss-disabled'?3:2;
   Object.assign(row,{generation,adapter:{isFallbackAdapter:false},events:[{event:'device-lost',detail:{reason:'destroyed'}},{event:'device-restored',detail:{generation}}],controlHistoryReinitialized:true,duringEvidence:{stateBefore:'recovering',stateAfter:'recovering',images:Array.from({length:2},()=>({width:8,height:8,complete:true,dataUrlSha256:'a'.repeat(64)})),fonts:Array.from({length:2},()=>({status:'loaded',events:1}))}});continue;
  }
  const records=['initial','visible-ready-first','modal-close','modal-reopen','reenable-first'].includes(phase)||scenario==='after'&&['restore-first','font-confirmed'].includes(phase)?1:0;
  const owner=control=>({...zero,sceneRecords:phase==='all-idle'?0:1,overlayRecords:control&&phase==='restore-first'?0:records,allocations:{texture:0},cpuRecordMs:1,queueAndReadbackWaitMs:2,regions:{cachedRegions:3,retainedColorBytes:393216},readiness:{fontStatus:'loaded',fontEvents:1},overlayState:{pendingOnce:phase.startsWith('disabled-')||phase==='restore-first'&&scenario==='during',visible:!(phase==='restore-first'&&scenario==='during'),updateMode:phase.startsWith('disabled-')?'disabled':'demand'}});
  Object.assign(row,{candidate:owner(false),control:owner(true)});
  if(phase==='all-idle')continue;
  const purple=['reenable-first','reenable-warm','wake'].includes(phase),source=purple?[128,48,208,255]:[32,192,80,255],expected=phase==='modal-close'?source:purple?[93,41,155,255]:[25,142,66,255];
  const image=()=>({sourceExpected:source,pixels:[[...expected],[...expected]]});
  Object.assign(row,{channelsCompared:98304,maxChannelDifference:0,sha256:'a'.repeat(64),controlSha256:'a'.repeat(64),fontBandSha256:(phase==='font-confirmed'?'b':'a').repeat(64),controlFontBandSha256:(phase==='font-confirmed'?'b':'a').repeat(64),overlayImage:image(),controlOverlayImage:image()});
 }
 return {status:'passed',caseCount:72,cases,errors:[]};
}
test('requires independent complete asynchronous recovery cohorts and eight native replacements',()=>assert.deepEqual(validateAsyncRecoveryReport(report()),{cases:72,pixelComparisons:56,channelsCompared:5505024,deviceReplacements:8}));
const get=(r,phase,scenario='during')=>r.cases.find(x=>x.id===`${phase}-${scenario}-msaa1`);
for(const [name,mutate] of [
 ['missing case',r=>r.cases.pop()],['duplicate case',r=>r.cases[1]=r.cases[0]],['wrong scenario',r=>r.cases[0].scenario='after'],
 ['partial canvas',r=>r.cases[0].channelsCompared--],['pixel mismatch',r=>r.cases[0].maxChannelDifference=3],['no font hash',r=>delete r.cases[0].fontBandSha256],
 ['frozen continuous scene',r=>r.cases[0].candidate.sceneRecords=0],['control spuriously redraws after loss',r=>get(r,'restore-first','after').control.overlayRecords=1],
 ['warm uploads',r=>get(r,'warm').candidate.guiUploads=1],['merged timing',r=>delete r.cases[0].candidate.queueAndReadbackWaitMs],
 ['cache byte excess',r=>r.cases[0].candidate.regions.retainedColorBytes=67108865],['cache count excess',r=>r.cases[0].control.regions.cachedRegions=9],
 ['hidden once consumed',r=>get(r,'restore-first').candidate.overlayState.pendingOnce=false],['disabled pulse lost',r=>get(r,'disabled-image-ready').control.overlayState.pendingOnce=false],
 ['wrong visible state',r=>get(r,'restore-first').candidate.overlayState.visible=true],['disabled region enabled',r=>get(r,'disabled-restore-first').candidate.overlayState.updateMode='demand'],
 ['wrong decoded source',r=>get(r,'reenable-first').overlayImage.sourceExpected=[32,192,80,255]],['missing cross-boundary probe',r=>get(r,'visible-ready-first').controlOverlayImage.pixels.pop()],
 ['blank decoded image',r=>get(r,'reenable-first').overlayImage.pixels[0]=[0,0,0,255]],['font never ready',r=>get(r,'font-confirmed').candidate.readiness.fontStatus='unloaded'],
 ['font event absent',r=>get(r,'font-confirmed').control.readiness.fontEvents=0],['glyphs unchanged',r=>get(r,'font-confirmed').fontBandSha256='a'.repeat(64)],
 ['wrong replacement generation',r=>get(r,'loss-disabled').generation=2],['software adapter',r=>get(r,'loss-ready-timing').adapter.isFallbackAdapter=true],
 ['no actual loss event',r=>get(r,'loss-ready-timing').events=[]],['different disabled history',r=>get(r,'loss-disabled').controlHistoryReinitialized=false],
 ['readiness after gate release',r=>get(r,'loss-ready-timing').duringEvidence.stateAfter='ready'],['image not decoded during loss',r=>get(r,'loss-ready-timing').duringEvidence.images[0].width=0],
 ['font not ready during loss',r=>get(r,'loss-ready-timing').duringEvidence.fonts[1].events=0],['idle presents',r=>get(r,'all-idle').candidate.acquired=1],
 ['idle allocates',r=>get(r,'all-idle').control.allocations.texture=1],['missing device cleanup',r=>get(r,'cleanup').candidate.devices=2],
 ['owned image listener leak',r=>get(r,'cleanup').candidate.imageListeners=1],['canvas listener leak',r=>get(r,'cleanup').control.canvasListeners=1],
 ['font listener leak',r=>get(r,'cleanup').fontListeners=1],['texture leak',r=>get(r,'cleanup').candidate.byType.texture.current=1],['GPU validation error',r=>r.errors.push('validation')],
])test(`rejects ${name}`,()=>{const r=report();mutate(r);assert.throws(()=>validateAsyncRecoveryReport(r),/G04 async recovery/)});
