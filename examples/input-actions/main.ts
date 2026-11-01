import {createInputExample} from './application.js';
void createInputExample(document.querySelector<HTMLCanvasElement>('canvas')!).then(app=>{
  addEventListener('pagehide',()=>{void app.dispose();},{once:true});
  const state=document.querySelector<HTMLElement>('#state')!;app.engine.on('after-update',()=>{state.textContent=app.stats().status;});
  if(new URLSearchParams(location.search).has('verify')){const check=()=>{if(app.stats().tick<30)return;app.engine.off('after-update',check);const result=document.querySelector<HTMLElement>('#result')!;result.textContent=JSON.stringify({status:'passed',stats:app.stats(),qualification:false});result.dataset.status='passed';};app.engine.on('after-update',check);}
}).catch(error=>{const result=document.querySelector<HTMLElement>('#result')!;result.textContent=JSON.stringify({status:'failed',error:String(error)});result.dataset.status='failed';});
