export const COMPATIBILITY_MATERIALS=Object.freeze(['standard','clearcoat','specular-sheen','transmission','transmission-clearcoat','opaque-clearcoat','opaque-specular-sheen','opaque-clearcoat-coplanar-standard','opaque-clearcoat-coplanar-proxy','opaque-clearcoat-mask']);
export const COMPATIBILITY_LIGHT_COUNTS=Object.freeze([0,1,8,9,128]);
export function parseCompatibilityOptions(args){
  if(args.length>1||args.some(arg=>arg!=='--integrated'))throw Error('Only one optional --integrated is supported');
  return {preference:args.includes('--integrated')?'low-power':'high-performance'};
}
export function validateCompatibilityEvidence(result){
  if(result.schemaVersion!==2||result.status!=='passed')throw Error('G04 compatibility diagnostic failed');
  if(result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw Error('Native adapter identity required');
  if(!Array.isArray(result.validationErrors)||result.validationErrors.length)throw Error('Missing or nonempty validation errors');
  if(result.cleanup?.ownerResidual!==0||result.cleanup?.liveGpuResources!==0)throw Error('Resource residue or missing cleanup');
  const expected=COMPATIBILITY_MATERIALS.flatMap(materialCase=>['reference','tiled'].flatMap(algorithm=>COMPATIBILITY_LIGHT_COUNTS.map(count=>`${materialCase}/${algorithm}/${count}`)));
  if(JSON.stringify(result.cases?.map(c=>`${c.materialCase}/${c.algorithm}/${c.count}`))!==JSON.stringify(expected))throw Error('Incomplete named compatibility matrix');
  for(const c of result.cases){
    if(c.completeCoverage!==true||!Number.isFinite(c.maxDelta)||c.maxDelta<0||(c.count>0&&c.litPixels<1024))throw Error('Invalid pixel or coverage evidence');
    if(c.materialCase.startsWith('opaque-')&&!c.passes?.some(p=>p.name==='deferred-full-light-opaque'&&p.reads.includes('gbuffer')&&p.dependsOn.length))throw Error('Missing opaque proxy lighting pass');
    const transparent=c.passes?.find(p=>p.name==='deferred-full-light-transparent');
    if(!transparent?.dependsOn?.length||transparent.reads.some(r=>transparent.writes.includes(r)))throw Error('Missing versioned transparent dependency');
  }
  if(result.contributions?.length!==COMPATIBILITY_MATERIALS.length*128)throw Error('Missing independent light contributions');
  for(const materialCase of COMPATIBILITY_MATERIALS){
    const contributions=result.contributions.filter(c=>c.materialCase===materialCase);
    if(contributions.length!==128||new Set(contributions.map(c=>c.entityId)).size!==128||contributions.some(c=>c.pixel?.length!==3||c.pixel.some(v=>!Number.isFinite(v)||v<=0)))throw Error('Invalid independent light contributions');
  }
}
