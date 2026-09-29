export const G05_LOW_LIMIT_CASES=Object.freeze([
 {key:'maxStorageBuffersPerShaderStage',requested:4,required:5,algorithms:['reference','tiled']},
 {key:'maxColorAttachments',requested:2,required:3,algorithms:['reference','tiled']},
 {key:'maxStorageBufferBindingSize',requested:65536,required:16+64*(1024+8),algorithms:['reference','tiled']},
 {key:'maxComputeWorkgroupSizeX',requested:32,required:64,algorithms:['tiled']},
]);
export function validateG05LowLimits(r){
 if(r.schemaVersion!==1||!['passed','unavailable'].includes(r.status)||r.suite!=='g05-native-low-limits')throw Error('Low-limit capture failed');
 if(r.adapter?.isFallbackAdapter!==false||!r.adapter.vendor||!r.adapter.architecture)throw Error('Native adapter required');
 if(r.validationErrors?.length!==0||r.cases?.length!==7)throw Error('Missing low-limit cases or validation errors');
 let index=0;
 for(const c of G05_LOW_LIMIT_CASES)for(const algorithm of c.algorithms){
  const row=r.cases[index++],reason=`device-limit:${c.key}`;
  if(row.key!==c.key||row.algorithm!==algorithm||row.requested!==c.requested||!Number.isSafeInteger(row.actual)||row.actual<c.requested||row.limitSource!=='native-device.limits')throw Error('Invalid native limit evidence');
  if(row.status==='unavailable'){
   if(row.actual<c.required||row.reason!=='native-limit-at-or-above-engine-requirement'||row.strict!==undefined||row.forward!==undefined||row.deferredCreated?.length!==0||row.deviceDestroyed!==true)throw Error('Invalid unavailable classification');
   continue;
  }
  if(row.status!=='passed'||row.actual>=c.required)throw Error('Native limit does not exercise rejection');
  if(row.strict?.reason!==reason||row.strict.observed!==row.actual||row.strict.supported!==c.required||row.strict.code!=='E_DEFERRED_LIGHTING_CAPABILITY')throw Error('Wrong strict capability rejection');
  if(row.forward?.requested!==`deferred-${algorithm}`||row.forward.effective!=='forward'||row.forward.completeCoverage!==false||row.forward.reason!==reason||row.forward.recordResult!==false)throw Error('Missing explicit restricted Forward fallback');
  if(row.deferredCreated?.length!==0||row.deviceDestroyed!==true||row.systemDestroyed!==true)throw Error('Low-limit resource lifecycle failure');
 }
 const unavailable=r.cases.some(row=>row.status==='unavailable');
 if(r.status!==(unavailable?'unavailable':'passed')||r.physicalLowLimitQualified!==!unavailable)throw Error('Incorrect physical coverage claim');
}
