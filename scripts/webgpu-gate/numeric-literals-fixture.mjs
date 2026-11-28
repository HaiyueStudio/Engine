const result=document.querySelector('#result'),query=new URLSearchParams(location.search),cases=[],oldSyntax=[],validationErrors=[],uncapturedErrors=[],glResources={shaders:0,programs:0};let device,gl;
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
function shader(type,source){const object=gl.createShader(type);glResources.shaders++;gl.shaderSource(object,source);gl.compileShader(object);return{object,error:gl.getShaderParameter(object,gl.COMPILE_STATUS)?null:gl.getShaderInfoLog(object)};}
function releaseShader(object){gl.deleteShader(object);glResources.shaders--;}
try{
 const response=await fetch(query.get('cases'));if(!response.ok)throw Error('Shader payload request failed');const bytes=await response.arrayBuffer();if(bytes.byteLength!==Number(query.get('length'))||await hash(bytes)!==query.get('sha256'))throw Error('Shader payload fingerprint mismatch');const payload=JSON.parse(new TextDecoder().decode(bytes));
 const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('WebGPU adapter unavailable');device=await adapter.requestDevice();device.addEventListener('uncapturederror',event=>uncapturedErrors.push(event.error.message));gl=document.createElement('canvas').getContext('webgl2');if(!gl)throw Error('WebGL2 compiler unavailable');
 for(const entry of payload.cases){
  device.pushErrorScope('validation');const module=device.createShaderModule({label:entry.id,code:entry.wgsl}),info=await module.getCompilationInfo();const errors=info.messages.filter(message=>message.type==='error').map(message=>message.message);
  if(!errors.length)device.createRenderPipeline({label:entry.id,layout:'auto',vertex:{module,entryPoint:'vertexMain',buffers:[{arrayStride:16,attributes:[{offset:0,shaderLocation:0,format:'float32x4'}]}]},fragment:{module,entryPoint:'fragmentMain',targets:[{format:'rgba8unorm'}]}});
  const validation=await device.popErrorScope();if(validation)validationErrors.push({id:entry.id,message:validation.message});
  const shaders=[];let program,compileErrors=0,linkErrors=0;try{for(const source of entry.glsl){const compiled=shader(source.stage==='vertex'?gl.VERTEX_SHADER:gl.FRAGMENT_SHADER,source.code);shaders.push(compiled.object);if(compiled.error)compileErrors++;}if(!compileErrors){program=gl.createProgram();glResources.programs++;for(const object of shaders)gl.attachShader(program,object);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))linkErrors++;}}
  finally{if(program){gl.deleteProgram(program);glResources.programs--;}for(const object of shaders)releaseShader(object);}
  cases.push({id:entry.id,wgslErrors:errors.length,wgslValidationErrors:validation?1:0,glslCompileErrors:compileErrors,glslLinkErrors:linkErrors,messages:errors});
 }
 for(const literal of ['1e+21.0','-1e+21.0','1e+30.0']){
  device.pushErrorScope('validation');const module=device.createShaderModule({code:`@compute @workgroup_size(1) fn main(){let value=${literal}f;}`}),info=await module.getCompilationInfo();await device.popErrorScope();
  const compiled=shader(gl.FRAGMENT_SHADER,`#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(${literal});}`);releaseShader(compiled.object);oldSyntax.push({literal,wgslErrors:info.messages.filter(message=>message.type==='error').length,glslErrors:compiled.error?1:0});
 }
 await device.queue.onSubmittedWorkDone();device.destroy();gl.getExtension('WEBGL_lose_context')?.loseContext();
 const passed=cases.every(row=>!row.wgslErrors&&!row.wgslValidationErrors&&!row.glslCompileErrors&&!row.glslLinkErrors)&&oldSyntax.every(row=>row.wgslErrors>0&&row.glslErrors>0)&&!validationErrors.length&&!uncapturedErrors.length;
 result.textContent=JSON.stringify({schemaVersion:1,status:passed?'passed':'failed',cases,oldSyntax,validationErrors,uncapturedErrors,glResources,sourceVerified:true});result.dataset.status=passed?'passed':'failed';
}catch(error){device?.destroy();gl?.getExtension('WEBGL_lose_context')?.loseContext();result.textContent=JSON.stringify({status:'failed',error:error.stack??String(error),cases,oldSyntax,validationErrors,uncapturedErrors,glResources});result.dataset.status='failed';}
