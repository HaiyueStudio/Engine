// Creation calls are observed only in the separately labelled cost diagnostic.
// CPU timings are API-call/async-completion costs, never claimed as driver compiler time.
export function observeG05CreationCosts(device){
 let stage='scenario';const records=[],modules=new WeakMap();
 for(const method of ['createShaderModule','createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync']){
  const original=device[method].bind(device);
  device[method]=descriptor=>{
   const start=performance.now(),row={method,stage,label:descriptor.label??'',callMs:0,settleMs:null,status:'pending'};
   if(method==='createShaderModule'){row.code=descriptor.code;row.bytes=new TextEncoder().encode(descriptor.code).length;}
   else row.shaderIds=[descriptor.vertex?.module,descriptor.fragment?.module,descriptor.compute?.module].filter(Boolean).map(module=>modules.get(module));
   const id=records.length;records.push(row);
   try{
    const value=original(descriptor);row.callMs=performance.now()-start;
    if(method.endsWith('Async'))return value.then(pipeline=>{row.settleMs=performance.now()-start;row.status='passed';return pipeline;},error=>{row.settleMs=performance.now()-start;row.status='failed';throw error;});
    row.status='passed';if(method==='createShaderModule')modules.set(value,id);return value;
   }catch(error){row.callMs=performance.now()-start;row.status='failed';throw error;}
  };
 }
 return {stage(value){stage=value;},count:()=>records.length,async report(){return Promise.all(records.map(async row=>{if(!Object.hasOwn(row,'code'))return {...row};const {code,...rest}=row;const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code));return {...rest,sha256:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')};}));}};
}
