export const profile=Object.freeze({warmupFrames:12,actions:128,rebindCycles:100,heldFrames:30});
export const requiredChecks=Object.freeze(['original-class','keyboard-axis-signs','boolean-long-hold','pointer-press-release','gui-consumption','hot-rebind-quarantine','conflict-atomic','storage-roundtrip','gamepad-hold-once','blur-release','disconnect-neutral','128x100-workload','source-host-polls-once','resource-teardown']);
export function validateInputBrowserResult(result){
 const errors=[];if(result?.status!=='passed')errors.push('Feature execution did not pass.');
 if(result?.adapter?.isFallbackAdapter!==false||/swiftshader|software|llvmpipe/i.test(JSON.stringify(result?.adapter)))errors.push('Native hardware adapter required.');
 for(const check of requiredChecks)if(!result?.checks?.includes(check))errors.push('Missing check: '+check);
 if(result?.profile?.actions!==128||result?.profile?.rebindCycles!==100||result?.profile?.warmupFrames!==12||result?.profile?.heldFrames!==30)errors.push('Frozen workload changed.');
 if(result?.workload?.actions!==128||result?.workload?.roundTrips!==100||result?.workload?.originalSnapshotRetained!==true)errors.push('Complete rebind workload required.');
 if(result?.lifecycle?.polls!==result?.lifecycle?.ticks||!(result?.lifecycle?.ticks>=30)||result?.lifecycle?.remainingListeners!==0||result?.lifecycle?.inputDisposed!==true||result?.lifecycle?.borrowedBackendRetained!==true)errors.push('Original input/storage lifetime failed.');
 if(result?.lifecycle?.storageBackend!=='local-storage'||result?.lifecycle?.persistent!==true)errors.push('Actual existing browser storage backend required.');
 if(result?.finalGpu?.resources!==0||result?.finalGpu?.estimatedBytes!==0||!Array.isArray(result?.gpuErrors)||result.gpuErrors.length)errors.push('GPU resources/errors failed.');
 if(result?.physicalInputQualification!==false||result?.qualification!==false)errors.push('Synthetic execution cannot claim physical/release qualification.');
 return{status:errors.length?'failed':'passed',errors};
}
