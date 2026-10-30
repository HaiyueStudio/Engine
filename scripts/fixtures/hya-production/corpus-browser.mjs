import {HaiyueEngine} from '@haiyue/engine';
import {measureSample} from '/g12-corpus/measurement.js';
const output=document.querySelector('#result'),progress=document.querySelector('#progress'),canvas=document.querySelector('#canvas');
let engine;const samples=[],errors=[],validationErrors=[];
try{
 const input=await(await fetch('/animation-spec/corpus/.cache/browser-input.json',{cache:'no-store'})).json();
 canvas.width=input.warmup.width;canvas.height=input.warmup.height;canvas.style.width=canvas.width+'px';canvas.style.height=canvas.height+'px';
 engine=new HaiyueEngine({canvas,clearColor:{r:0,g:0,b:0,a:0},alphaMode:'premultiplied',devicePixelRatio:1,timestampQuery:false,renderProfile:'simple'});await engine.init();
 engine.context.configure({device:engine.device,format:engine.format,alphaMode:'premultiplied',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});engine.device.addEventListener('uncapturederror',event=>validationErrors.push(event.error.message));
 const info=engine.adapter.info,environment={userAgent:navigator.userAgent,adapter:{vendor:info.vendor,architecture:info.architecture,description:info.description,isFallbackAdapter:info.isFallbackAdapter},format:engine.format};
 let warmup;try{warmup=await measureSample(engine,canvas,input.warmup);}catch(error){errors.push({id:'common-warmup',error:String(error.stack??error)});}
 for(const [index,sample]of input.samples.entries()){
  progress.textContent=`${index+1}/${input.samples.length} ${sample.id}`;
  try{samples.push(await measureSample(engine,canvas,sample));}catch(error){const failure={id:sample.id,error:String(error.stack??error)};samples.push(failure);errors.push(failure);}
  output.textContent=JSON.stringify({status:'running',samples,errors,validationErrors});
 }
 engine.destroy();output.textContent=JSON.stringify({status:errors.length||validationErrors.length?'failed':'passed',sampleCount:samples.length,samples,warmup,errors,validationErrors,environment});output.dataset.status=errors.length||validationErrors.length?'failed':'passed';
}catch(error){output.textContent=JSON.stringify({status:'failed',samples,errors,validationErrors,error:String(error.stack??error)});output.dataset.status='failed';}
finally{engine?.destroy();}
