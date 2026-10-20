import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {sha256} from './deferred-fixture-policy.mjs';
export function parseTiledFixtureOptions(args){
  for(const arg of args)if(!['--integrated','--render'].includes(arg))throw Error(`Unknown tiled fixture option: ${arg}`);
  return {mode:args.includes('--render')?'render':'compute-smoke',preference:args.includes('--integrated')?'low-power':'high-performance'};
}
export async function tiledHarnessFingerprint(root){
  const names=['deferred-tile-fixture.html','deferred-tile-fixture.mjs','deferred-tiled-render-fixture.html','deferred-tiled-render-fixture.mjs',
    'deferred-tile-oracle.mjs','deferred-tiled-views.mjs','deferred-tiled-boundaries.mjs','deferred-tiled-policy.mjs','run-deferred-tile-fixture.mjs','float-texture-readback.mjs','chrome-runner.mjs'];
  const files=await Promise.all(names.sort().map(async name=>({path:`scripts/webgpu-gate/${name}`,sha256:sha256(await readFile(resolve(root,'scripts/webgpu-gate',name)))})));
  return {sha256:sha256(JSON.stringify(files)),files};
}
export function validateTiledFixtureResult(result,mode){
  if(result.status!=='passed'||result.schemaVersion!==1)throw Error('Tiled fixture failed');
  if(result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw Error('Native adapter identity missing');
  if(!Array.isArray(result.validationErrors)||result.validationErrors.length)throw Error('GPU validation errors missing or nonzero');
  if(mode==='compute-smoke'){
    if(result.overflowTiles!==4||result.acceptedPerTile!==256||result.storedPrefix!==128)throw Error('Incomplete compute overflow smoke');
    return;
  }
  const ids=[];for(const count of [0,1,128,256])for(const overlap of [false,true])for(const mode of ['normal','local-overflow','total-overflow','no-storage'])ids.push(`${count}:${overlap}:${mode}`);
  if(JSON.stringify(result.cases?.map(c=>`${c.count}:${c.overlap}:${c.mode}`))!==JSON.stringify(ids))throw Error('Missing tiled render cases');
  for(const c of result.cases){
    if(c.count>=128&&!(c.litPixels>=1024))throw Error('Missing visibly lit reference');
    if(c.coverage!==true||!Number.isFinite(c.maxHdrDelta)||!Number.isFinite(c.maxLdrDelta)||c.maxLdrDelta>2.001
      ||c.membership?.falseNegatives!==0||c.membership.heatmap?.length!==16)throw Error('Invalid tiled parity/membership evidence');
    if(!c.passes?.some(p=>p.name==='deferred-tile-cull')||!c.passes.some(p=>p.name==='deferred-tiled-light-resolve'))throw Error('Tiled production passes missing');
    if(c.mode==='no-storage'&&c.membership.overflowTiles!==16)throw Error('Total exhaustion fallback missing');
    if(c.mode==='total-overflow'&&c.membership.overflowTiles<14)throw Error('Partial exhaustion fallback missing');
  }
  const expectedBoundaries=['cull-near-plane','cull-inside-light','cull-all-in-one-tile','cull-empty-tile','cull-empty-background','cull-extreme-range','cull-tangent-boundary','cull-source-mutation','cull-source-add-remove'];
  for(const type of ['perspective','orthographic'])for(const z of ['reverse','standard'])for(const range of ['remapped','default'])expectedBoundaries.push(`cull-${type}-${z}-${range}-jitter`);
  for(const roughness of [0,.001,.05,.6,1])for(const metallic of [0,.5,1])for(const mode of ['compact','full-list'])expectedBoundaries.push(`point-brdf-${roughness}-${metallic}-${mode}`);
  if(result.boundaryCases?.length!==expectedBoundaries.length||expectedBoundaries.some(id=>!result.boundaryCases.some(c=>c.id===id&&c.membership.falseNegatives===0&&Number.isFinite(c.maxHdrDelta)&&c.maxLdrDelta<=2.001)))throw Error('Incomplete tiled boundary matrix');
  if(result.viewCases?.views?.length!==4||result.viewCases.sourceUploadsAcrossFourViews!==1||result.viewCases.views.some(v=>v.membership.falseNegatives!==0)||result.viewCases.resize?.membership?.falseNegatives!==0)throw Error('Tiled multiview/resize evidence incomplete');
  if(result.viewCases.transitions?.length!==3||result.viewCases.transitions.some((entry,i)=>entry.paths.length!==4||entry.paths.some(path=>path.effective!=='deferred-tiled'||path.completeCoverage!==true||path.reason!==(i===1?null:'all-lights-cover-near-plane'))||entry.cullPasses?.length!==4||entry.cullPasses.some(count=>count!==(i===1?1:0))))throw Error('Automatic full-list transitions missing');
  const reuse=result.viewCases.reuse;
  if(reuse?.frames!==8||['buffers','bindGroups','pipelines','computePipelines'].some(key=>!Number.isFinite(reuse.baseline?.[key])||reuse.baseline[key]!==reuse.dynamic?.[key]))throw Error('Tiled resource reuse failed');
  validateSourceCapacityCases(result.capacityCases);
  if(result.cleanup?.ownerResidual!==0||result.cleanup?.liveGpuResources!==0)throw Error('Tiled cleanup incomplete');
}

export function validateSourceCapacityCases(cases){
  if(cases?.length!==2||['strict','forward'].some(policy=>!cases.some(c=>c.failurePolicy===policy&&c.requested===1025&&c.recovered===1024&&c.diagnostics?.reason==='point-capacity'&&c.diagnostics.completeCoverage===false&&(policy==='strict'?c.thrown?.reason==='point-capacity'&&c.thrown.observed===1025&&c.thrown.supported===1024:c.thrown===null))))throw Error('Source capacity rejection/recovery evidence missing');
}
