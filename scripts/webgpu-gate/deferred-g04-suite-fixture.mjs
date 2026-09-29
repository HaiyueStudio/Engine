import {runG04Effects} from './deferred-g04-effects.mjs';
const node=document.querySelector('#result');
let device;
try {
  const powerPreference=new URLSearchParams(location.search).get('powerPreference')??'high-performance';
  const adapter=await navigator.gpu.requestAdapter({powerPreference});
  if(!adapter||adapter.info.isFallbackAdapter)throw Error('Native adapter required');
  device=await adapter.requestDevice();const errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  const result=await runG04Effects(device);
  const validation=await device.popErrorScope();if(validation)errors.push(validation.message);
  if(errors.length)throw Error(errors.join('\n'));
  node.textContent=JSON.stringify({schemaVersion:1,status:'passed',adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},...result,validationErrors:errors});node.dataset.status='passed';
} catch(error){node.textContent=JSON.stringify({schemaVersion:1,status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
finally{device?.destroy();}
