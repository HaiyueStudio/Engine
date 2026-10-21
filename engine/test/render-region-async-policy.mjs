import assert from 'node:assert/strict';
import {validateRegionMemory} from '../../scripts/fixtures/layout-contracts/working-set-policy.mjs';

export const ASYNC_GUI_STAGES=Object.freeze(['initial','static-initial','image-first-ready','static-image','font-first-ready','static-font','scroll-first','scroll-middle','scroll-rest','static-rest','image-source-replace-unready','image-old-source-late','image-new-source-ready','static-new-image','remove-image','detached-image-late','switch-start','switch-middle','switch-end','static-switch','listener-teardown']);
export function asyncGuiFixtureSpec(args=[]){
 if(args.length)throw Error('The asynchronous GUI diagnostic accepts no arguments.');
 return {id:'async',fixture:'async',mounted:true,count:84,query:{},workload:{width:384,height:216,dpr:1,msaa:[1,4],formats:['rgba8unorm','rgba16float'],pixelTolerance:2,deviceClass:'native-desktop',cacheModes:['retained-regions','ordinary-full-output-GUI'],fontSource:'local Courier New via actual FontFaceSet loadingdone',imageSource:'asynchronously decoded canvas PNG blob URLs',pixelComparisons:80,lifecycleChecks:4,qualification:'First-presented-frame and static skip correctness/resource diagnostic; G05 input and G13 performance remain separate'}};
}
export function validateAsyncGuiResult(result){
 assert.equal(result.status,'passed');assert.equal(result.caseCount,84);assert.equal(result.cases.length,84);
 const seen=new Set();
 for(const format of ['rgba8unorm','rgba16float'])for(const samples of [1,4])for(const stage of ASYNC_GUI_STAGES){
  const id=`${stage}-${format}-${samples}`,rows=result.cases.filter(c=>c.id===id);assert.equal(rows.length,1,`Missing or duplicate ${id}`);const c=rows[0];seen.add(c);
  if(stage==='listener-teardown'){assert.equal(c.fontListeners,0);assert.equal(c.imageListeners,0);continue;}
  assert.equal(c.channelsCompared,384*216*4);assert.ok(Number.isFinite(c.maxRawChannelDifference)&&c.maxRawChannelDifference<=2/255);
  assert.equal(c.regional.records.scene,1);validateRegionMemory(c.regional.stats,c.regional.gpuResourceSnapshot);
  for(const key of ['bufferUploadBytes','textureUploads','textureUploadTexels','passes','draws'])assert.ok(Number.isSafeInteger(c.regional[key])&&c.regional[key]>=0,`${id}: ${key}`);
  if(stage.startsWith('static-')||['image-old-source-late','detached-image-late'].includes(stage)){
   assert.equal(c.regional.records.gui,0);assert.equal(c.regional.solves,0);assert.equal(c.regional.guiUploads,0);
  }
  if(['image-first-ready','font-first-ready','scroll-first','scroll-middle','image-source-replace-unready','image-new-source-ready','remove-image','switch-start','switch-middle','switch-end'].includes(stage))assert.equal(c.regional.records.gui,1,`${id}: first presentation`);
  if(stage.startsWith('switch-')||stage==='static-switch'){
   assert.equal(c.regional.solves,0,'Switch must be visual-only');
   for(const side of ['candidate','ordinary']){const v=c.switch?.[side];assert.ok(v);for(const key of ['thumb','color']){assert.ok(Number.isFinite(v[key]));if(stage==='switch-start')assert.equal(v[key],0);else if(stage==='switch-middle')assert.ok(v[key]>0&&v[key]<1);else assert.equal(v[key],1);}assert.equal(v.animating,['switch-start','switch-middle'].includes(stage));}
   assert.deepEqual(c.switch.candidate,c.switch.ordinary);
   if(stage==='switch-middle')assert.notEqual(c.sha256,result.cases.find(row=>row.id===`switch-start-${format}-${samples}`).sha256,'Mid-transition pixels must change');
   if(stage==='switch-end')assert.notEqual(c.sha256,result.cases.find(row=>row.id===`switch-middle-${format}-${samples}`).sha256,'Final pixels must change');
   if(stage==='static-switch')assert.equal(c.sha256,result.cases.find(row=>row.id===`switch-end-${format}-${samples}`).sha256,'Static switch pixels must stay frozen');
  }
  if(stage==='scroll-rest'){assert.ok(c.inertia.frames>10&&c.inertia.frames<120);assert.ok(c.inertia.offset>0);assert.equal(c.inertia.offset,c.inertia.referenceOffset);}
 }
 assert.equal(seen.size,84);return result;
}
