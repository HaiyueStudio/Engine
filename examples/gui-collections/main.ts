import {createCollectionExample} from './application.js';
void createCollectionExample(document.querySelector<HTMLCanvasElement>('canvas')!).then(app=>{
  addEventListener('pagehide',()=>app.dispose(),{once:true});
  if(new URLSearchParams(location.search).has('verify')){let frames=0;const check=()=>{if(++frames<30)return;app.engine.off('after-update',check);const result=document.querySelector<HTMLElement>('#result')!;result.textContent=JSON.stringify({status:'passed',list:app.list.stats,tree:app.tree.stats,qualification:false});result.dataset.status='passed';};app.engine.on('after-update',check);}
}).catch(error=>{const result=document.querySelector<HTMLElement>('#result')!;result.textContent=JSON.stringify({status:'failed',error:String(error)});result.dataset.status='failed';});
