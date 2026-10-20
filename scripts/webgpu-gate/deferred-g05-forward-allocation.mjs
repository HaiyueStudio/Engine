// Setup-only observation. Stable frames do not allocate audit entries unless the device creates resources.
export function observeForwardAllocations(device){
 const methods=['createBuffer','createTexture','createShaderModule','createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync'];
 const allocations=[];
 for(const method of methods){
  const original=device[method].bind(device);
  device[method]=descriptor=>{allocations.push({method,label:descriptor.label??'',...(method==='createBuffer'?{bytes:descriptor.size}:{}),...(method==='createTexture'?{size:descriptor.size,format:descriptor.format}:{})});return original(descriptor);};
 }
 return {snapshot(){return {schemaVersion:1,observedMethods:methods,allocations:[...allocations],deferredCreated:allocations.filter(a=>/deferred|TransientMRT:/i.test(a.label))};}};
}
