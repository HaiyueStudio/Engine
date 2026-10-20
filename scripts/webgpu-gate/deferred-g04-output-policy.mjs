export const G04_OUTPUT_CASES=['hdr-rtt','opaque-proxy-hdr','taa-hdr','exposure-once','transmission-linear-copy','basic-fallback','helper-fallback','reflection-child'];
export function validateG04Output(result){
 if(result.schemaVersion!==1||result.status!=='passed')throw Error('G04 output failed');
 if(result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw Error('Native adapter required');
 if(!Array.isArray(result.validationErrors)||result.validationErrors.length)throw Error('Validation errors');
 if(JSON.stringify(result.cases?.map(c=>`${c.algorithm}/${c.id}`))!==JSON.stringify(['reference','tiled'].flatMap(a=>G04_OUTPUT_CASES.map(id=>`${a}/${id}`))))throw Error('Incomplete output matrix');
 for(const c of result.cases){if(c.cleanup?.ownerResidual!==0||c.cleanup?.liveGpuResources!==0)throw Error('Resource residue');
 if(c.id.includes('fallback')){if(c.views?.length!==1||c.views[0].completeCoverage!==false||c.views[0].effective!=='forward'||!c.views[0].reason)throw Error('False fallback coverage');}
 else if(c.id==='reflection-child'){if(c.reflectionFormat!=='rgba16float'||!c.views?.some(v=>v.key==='display'&&!v.completeCoverage)||!c.views.some(v=>v.key!=='display'&&v.completeCoverage))throw Error('Invalid reflection');}
 else if(c.color?.length!==4||c.linear?.length!==4||[...c.color,...c.linear].some(v=>!Number.isFinite(v))||c.views?.length!==2||c.views.some(v=>!v.completeCoverage))throw Error('Invalid output pixels');
 }
}
