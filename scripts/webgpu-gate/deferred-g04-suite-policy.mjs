export const G04_AO_MODES=Object.freeze(['direct','emission','ambient','ibl','transmission-direct','transmission-emission']);
export const G04_EFFECT_CASES=Object.freeze(['none','gtao','sao','ssao','fog','ibl','shadows','outline','taa-motion','deformed']);
export function validateG04Suite(result){
  if(result.schemaVersion!==1||result.status!=='passed')throw Error('G04 effects failed');
  if(result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw Error('Native adapter required');
  if(!Array.isArray(result.validationErrors)||result.validationErrors.length)throw Error('GPU validation errors');
  const expected=G04_EFFECT_CASES.flatMap(id=>['forward','reference','tiled'].map(algorithm=>`${id}/${algorithm}`));
  if(JSON.stringify(result.cases?.map(c=>`${c.id}/${c.algorithm}`))!==JSON.stringify(expected))throw Error('Incomplete effects matrix');
  const aoExpected=['gtao','sao','ssao'].flatMap(id=>['reference','tiled'].flatMap(algorithm=>G04_AO_MODES.map(mode=>`${id}/${algorithm}/${mode}`)));
  if(JSON.stringify(result.lightingAo?.map(c=>`${c.id}/${c.algorithm}/${c.mode}`))!==JSON.stringify(aoExpected))throw Error('Incomplete lighting AO matrix');
  for(const c of result.lightingAo){
    if(!Number.isFinite(c.minAo)||c.minAo<0||c.minAo>=.95)throw Error('AO oracle needs actual occlusion');
    if(!Number.isFinite(c.maxDelta)||c.maxDelta<0)throw Error('Invalid AO delta');
    if(['ambient','ibl'].includes(c.mode)){if(!(c.darkenedPixels>5)||c.brightenedPixels!==0)throw Error('Indirect AO semantics');}
    else if(c.maxDelta>1)throw Error('Direct/emission/transmission changed');
    for(const cleanup of [c.offCleanup,c.onCleanup])if(cleanup?.ownerResidual!==0||cleanup?.liveGpuResources!==0)throw Error('AO resource residue');
  }
  for(const c of result.cases){
    if(c.pixels?.length!==64*64*4||c.pixels.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error('Invalid pixels');
    if(!Number.isFinite(c.maxDelta)||c.maxDelta<0||c.maxDelta>3)throw Error('Pixel error');
    if(c.id!=='none'&&!(c.changedPixels>5))throw Error('Invisible effect');
    if(c.algorithm!=='forward'&&c.coverage?.completeCoverage!==true)throw Error('Incomplete coverage');
    if(c.cleanup?.ownerResidual!==0||c.cleanup?.liveGpuResources!==0)throw Error('Resource residue');
    if(['taa-motion','deformed'].includes(c.id)&&(!(c.temporal?.movingPixels>10)||c.temporal.historyCount!==1))throw Error('Temporal semantics');
    if(c.id==='shadows'&&c.shadowPasses!==3)throw Error('Three shadows required');
  }
}
