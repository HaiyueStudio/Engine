export function validateG04Device(result){
 if(result.schemaVersion!==1||result.status!=='passed'||result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw Error('Native device fixture failed');
 for(const errors of [result.validationErrors,result.secondaryValidationErrors])if(!Array.isArray(errors)||errors.length)throw Error('GPU errors');
 if(result.cases?.length!==6)throw Error('Incomplete device matrix');
 for(const algorithm of ['reference','tiled']){const c=result.cases.find(c=>c.algorithm===algorithm&&c.id==='injected-device-generation');if(c?.diagnostics?.reason!=='device-generation'||c.diagnostics.completeCoverage!==false||c.kind!=='injected-reference-mismatch')throw Error('Stale device admitted');if(result.cases.find(c=>c.algorithm===algorithm&&c.id==='initialization-cancellation')?.cancelled!==true)throw Error('Cancellation failed');}
 const lost=result.cases.find(c=>c.id==='native-device-lost'),fresh=result.cases.find(c=>c.id==='fresh-device-reinitialize');
 if(lost?.kind!=='native-destroy'||lost.reason!=='destroyed'||lost.ownerDestroyed!==true||fresh?.kind!=='explicit-reconstruction'||fresh.initialized!==true)throw Error('Loss/reinitialization missing');
}
