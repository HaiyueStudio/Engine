import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {beginRegionComposition,markRegionReplacement,regionReplacesParent}=await importEngineSource('core/RegionComposition.ts');
const {createDeferredRenderFrameContext}=await importEngineSource('core/RenderCommandContext.ts');
function setup(){const device=createAuditGpuDevice(),engine={device,width:32,height:16,format:'rgba16float',getRenderPassDescriptor:()=>({colorAttachments:[]})},target={width:32,height:16},view={target,loadOp:'clear',viewport:null,scissor:null};return{target,view,context:()=>createDeferredRenderFrameContext(engine)}};
test('complete scene coverage commits only on submission; cancelled clears preserve committed replacement meaning',()=>{
 const f=setup(),a=f.context();beginRegionComposition(f.target,a,true);assert.equal(regionReplacesParent(f.target,a),false);markRegionReplacement(f.view,a);assert.equal(regionReplacesParent(f.target,a),true);a.submit();
 const b=f.context();beginRegionComposition(f.target,b,true);assert.equal(regionReplacesParent(f.target,b),false);b.cancel();assert.equal(regionReplacesParent(f.target,b),true);
 const c=f.context();beginRegionComposition(f.target,c,false);assert.equal(regionReplacesParent(f.target,c),true);c.cancel();
 const d=f.context();beginRegionComposition(f.target,d,true);d.submit();assert.equal(regionReplacesParent(f.target,d),false);
});
test('pending coverage snapshots stay independent and follow actual submission order',()=>{
 const f=setup(),a=f.context(),b=f.context();beginRegionComposition(f.target,a,true);beginRegionComposition(f.target,b,true);markRegionReplacement(f.view,b);assert.equal(regionReplacesParent(f.target,a),false);assert.equal(regionReplacesParent(f.target,b),true);b.submit();assert.equal(regionReplacesParent(f.target,a),false);a.submit();assert.equal(regionReplacesParent(f.target,f.context()),false);
});
test('partial outputs and blended scene outputs do not turn foreground-only caches into replacement bitmaps',()=>{
 const f=setup(),a=f.context();beginRegionComposition(f.target,a,true);for(const view of [{...f.view,loadOp:'load'},{...f.view,viewport:{x:0,y:0,width:16,height:16}},{...f.view,scissor:{x:1,y:0,width:31,height:16}}])markRegionReplacement(view,a);assert.equal(regionReplacesParent(f.target,a),false);a.cancel();const b=f.context();markRegionReplacement(f.view,b);assert.equal(regionReplacesParent(f.target,b),false);b.cancel();
});
