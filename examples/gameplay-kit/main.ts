import {createGameplayKit} from './application.js';
const result=document.querySelector<HTMLElement>('#result')!;
void createGameplayKit(document.querySelector<HTMLCanvasElement>('canvas')!).then(app=>{
 addEventListener('pagehide',()=>{void app.dispose();},{once:true});
 if(new URLSearchParams(location.search).has('verify')){const done=()=>{if(app.coldStart.completedFrames.length<2)return;app.engine.off('after-update',done);result.textContent=JSON.stringify({status:'passed',ready:true,qualification:false,workload:{tabs:app.tabs.pages.length,badges:app.badges.length,list:app.list.stats.logicalItems}});result.dataset.status='passed';};app.engine.on('after-update',done);}
}).catch(error=>{result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error)});result.dataset.status='failed';});
