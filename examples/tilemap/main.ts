import{createTilemapExample}from'./application.js';
void createTilemapExample(document.querySelector<HTMLCanvasElement>('canvas')!).then(app=>{
  const bindings=[['edit',app.edit],['pan',app.pan],['toggle',app.toggle],['reset',app.reset]] as const;
  for(const[id,callback]of bindings)document.getElementById(id)!.addEventListener('click',callback);
  addEventListener('pagehide',()=>{for(const[id,callback]of bindings)document.getElementById(id)?.removeEventListener('click',callback);void app.dispose();},{once:true});
  if(new URLSearchParams(location.search).has('verify')){let frames=0;const check=()=>{if(++frames<30)return;app.engine.off('after-update',check);const result=document.getElementById('result')!;result.textContent=JSON.stringify({status:'passed',stats:app.stats(),qualification:false});result.dataset.status='passed';};app.engine.on('after-update',check);}
}).catch(error=>{const result=document.getElementById('result')!;result.textContent=JSON.stringify({status:'failed',error:String(error)});result.dataset.status='failed';});
