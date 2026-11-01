export const profile=Object.freeze({warmupFrames:12,logicalItems:[1000,10000],mutationPercent:[0,1,10],offsets:[0,280,2800,14000],rowHeight:28,height:560,overscan:2});
export const requiredChecks=Object.freeze(['window-matrix','static-work','anchor','offscreen-navigation','ime-retirement','tree-expansion','resource-teardown']);
export function validateCollectionBrowserResult(r){
 const errors=[];
 if(r?.schemaVersion!==1||!Array.isArray(r?.cases)||r.cases.length!==24)errors.push('Complete versioned matrix required.');
 if(r?.status!=='passed'||r?.adapter?.isFallbackAdapter!==false||/swiftshader|software|llvmpipe/i.test(JSON.stringify(r?.adapter)))errors.push('Native execution required.');
 if(JSON.stringify(r?.profile)!==JSON.stringify(profile))errors.push('Frozen workload changed.');
 for(const check of requiredChecks)if(!r?.checks?.includes(check))errors.push('Missing '+check);
 for(const count of profile.logicalItems)for(const mutation of profile.mutationPercent)for(const offset of profile.offsets){const cases=Array.isArray(r?.cases)?r.cases.filter(c=>c?.count===count&&c?.mutation===mutation&&c?.offset===offset):[];if(cases.length!==1||!Number.isSafeInteger(cases[0].rows)||cases[0].rows>24||cases[0].rows<1||cases[0].bound!==cases[0].rows||cases[0].live!==cases[0].rows||cases[0].treeLogical!==count||!Number.isSafeInteger(cases[0].treeRows)||cases[0].treeRows<1||cases[0].treeRows>24||cases[0].treeBound!==cases[0].treeRows||!Number.isFinite(cases[0].textVertices)||cases[0].textVertices<=0)errors.push('Missing/unbounded window '+[count,mutation,offset]);}
 if(r?.staticWork?.bindings!==0||r?.staticWork?.created!==0||r?.staticWork?.layouts!==0||r?.staticWork?.measurements!==0)errors.push('Static work repeated.');
 if(!Number.isSafeInteger(r?.lifecycle?.created)||!(r.lifecycle.created>=22)||!Number.isSafeInteger(r?.lifecycle?.bindings)||r.lifecycle.bindings<r.lifecycle.created||r?.lifecycle?.created!==r?.lifecycle?.disposed||r?.lifecycle?.bindings!==r?.lifecycle?.unbound||r?.finalGpu?.resources!==0||r?.finalGpu?.estimatedBytes!==0||!Array.isArray(r?.gpuErrors)||r.gpuErrors.length)errors.push('Lifetime failed.');
 if(r?.qualification!==false||r?.physicalInputQualification!==false)errors.push('Cannot claim physical/release qualification.');
 return {status:errors.length?'failed':'passed',errors};
}
