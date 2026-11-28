/** Exact same-device correctness comparisons, not a portable screenshot or performance budget. */
export const F30_F32_CASE_IDS=Object.freeze([
  ...[1,4].flatMap(samples=>[
    ...['legacy-morph','opacity-effect','compact-expansion','stack-expansion'].flatMap(id=>[0,.5,.25,0].map((time,step)=>`hya-${id}-t${time}-step${step}-msaa${samples}`)),`hya-static-msaa${samples}`,
    ...['initial','old-recording','next-recording','reverse-new-first','reverse-old-last','after-cancel-eviction','destroy-before-submit'].map(id=>`toon-${id}-msaa${samples}`),
  ]), 'warmup-render-new-device','warmup-compute-new-device',
]);
export function validateF30F32Pixels(report) {
  const check=(condition,message)=>{if(!condition)throw Error('F30-F32 pixels: '+message);};
  check(report?.schemaVersion===1&&report.status==='passed','fixture did not pass');
  check(report.role==='native-correctness-regression'&&report.adapter?.isFallbackAdapter===false,'native GPU identity is required');
  check(Array.isArray(report.cases)&&report.cases.length===50,'expected all 50 comparisons');
  check(new Set(report.cases.map(value=>value.id)).size===50,'duplicate comparison identities');
  const identities=new Set(report.cases.map(value=>value.id));check(F30_F32_CASE_IDS.every(id=>identities.has(id)),'missing a named workload or MSAA variant');
  for(const[prefix,count]of [['hya-',34],['toon-',14],['warmup-',2]])check(report.cases.filter(value=>value.id.startsWith(prefix)).length===count,'missing '+prefix+' comparisons');
  for(const value of report.cases){
    check(value.width===128&&value.height===128,'full 128x128 images are required');
    check(value.maximumChannelDifference===0&&value.changedChannels===0,'pixel difference in '+value.id);
    check(value.visibleChannels>16,'blank reference in '+value.id);
    check(/^[a-f0-9]{64}$/.test(value.candidateSha256)&&value.candidateSha256===value.referenceSha256,'missing or unequal pixel hashes in '+value.id);
  }
  check(report.maximumAllowedChannelDifference===0,'pixel threshold changed');
  check(Array.isArray(report.failures)&&report.failures.length===0,'fixture failure recorded');
  check(Array.isArray(report.validationErrors)&&report.validationErrors.length===0,'GPU validation failed');
  check(Array.isArray(report.resourceResidue)&&report.resourceResidue.length>0&&report.resourceResidue.every(value=>value.buffers===0&&value.textures===0&&value.querySets===0&&value.estimatedBytes===0),'live buffers or textures remain');
  return {status:'passed',comparisons:report.cases.length,maximumChannelDifference:0};
}
