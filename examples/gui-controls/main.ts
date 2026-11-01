import{createGuiControlsExample}from'./application.js';
const output=document.querySelector<HTMLElement>('#result')!;
void createGuiControlsExample(document.querySelector<HTMLCanvasElement>('canvas')!).then(app=>{
 addEventListener('pagehide',()=>app.dispose(),{once:true});
 if(new URLSearchParams(location.search).has('verify')){let count=0;const ready=()=>{if(++count<30)return;app.engine.off('after-update',ready);output.textContent=JSON.stringify({status:'passed',tabs:app.tabs.pages.length,breadcrumbs:8,badges:app.badges.length,collapsePanels:16,qualification:false});output.dataset.status='passed';};app.engine.on('after-update',ready);}
}).catch(error=>{output.textContent=JSON.stringify({status:'failed',error:String(error)});output.dataset.status='failed';});
