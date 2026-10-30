import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
const result=document.querySelector('#result'),cases=[],errors=[];
// Keep the product's own setup validation. Publish G12 only after that result.
const wait=async(predicate,message)=>{const start=performance.now();while(!predicate()){if(performance.now()-start>45000)throw Error(message);await new Promise(resolve=>setTimeout(resolve,16));}};
const check=(value,message)=>{if(!value)throw Error(message);};
try{
 await wait(()=>globalThis.__g12Product&&result.dataset.productStatus==='passed','Actual product never initialized');
 const product=globalThis.__g12Product,{engine,hud,game,physics,tilt,ballBody}=product;
 const original=JSON.parse(result.textContent);check(original.status==='passed','Original product validation failed');result.removeAttribute('data-status');
 engine.device.addEventListener('uncapturederror',event=>errors.push(event.error.message));engine.device.pushErrorScope('validation');
 const lazy=performance.getEntriesByType('resource').filter(entry=>/\/extensions\/dist\/hya-player\.js|hya-victory\.(?:json|otf)/.test(entry.name));check(lazy.length===0,'HYA/font loaded before the actual victory flow');cases.push({id:'real-product-playing-keeps-hya-and-font-lazy',original});
 for(let cycle=0;cycle<3;cycle++){
  const before=engine.updates,goal=game.layout.goal,position=[(goal.column-(game.layout.columns-1)/2)*1.48,.5,(goal.row-(game.layout.rows-1)/2)*1.48];
  check(physics.teleportBody(ballBody,tilt.boardToWorld(position),[0,0,0,1]),'Real physics body did not accept deterministic goal replay');
  await wait(()=>document.body.dataset.gameState==='won','Real maze rules did not recognize the goal');
  await wait(()=>hud.hyaVictory.player?.lastFrame?.ready,'Actual lazy HYA victory never became ready');
  const player=hud.hyaVictory.player,label=player.data.read({part:'data',id:'root'},['label']);check(label==='LEVEL '+game.level+' COMPLETE','Product level data did not reach HYA');
  check(hud.victory.visible&&hud.next.visible&&engine.updates>before,'Original GUI controls or continuous 3D updates were lost');
  cases.push({id:'real-product-victory-'+cycle,level:game.level,label,updates:engine.updates-before,frame:player.lastFrame,resources:getEngineDiagnosticsSnapshot(engine).gpuResources});
  game.loadLevel(game.level+1);check(!hud.hyaVictory.player&&!hud.victory.visible,'Next level retained old victory owner');
 }
 for(let rapid=0;rapid<8;rapid++){hud.showVictory(true);hud.showVictory(false);}
 await new Promise(resolve=>setTimeout(resolve,50));check(!hud.hyaVictory.player,'An aborted artwork request published a late player');cases.push({id:'real-product-rapid-show-hide-aborts-late-owners',cycles:8});
 const finalGoal=game.layout.goal,finalPosition=[(finalGoal.column-(game.layout.columns-1)/2)*1.48,.5,(finalGoal.row-(game.layout.rows-1)/2)*1.48];check(physics.teleportBody(ballBody,tilt.boardToWorld(finalPosition),[0,0,0,1]),'Final goal replay failed');await wait(()=>document.body.dataset.gameState==='won'&&hud.hyaVictory.player?.lastFrame?.ready,'Final actual victory did not become ready');await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));engine.stop();globalThis.__g12ProductScreenshotReady=true;await wait(()=>globalThis.__g12ProductProceed,'Product screenshot was not captured');
 const validation=await engine.device.popErrorScope();if(validation)errors.push(validation.message);check(!errors.length,errors.join(';'));
 game.dispose();engine.destroy();const residue=getEngineDiagnosticsSnapshot(engine).gpuResources;check(residue.totals.resources===0,'Product destruction left GPU resources');cases.push({id:'real-product-destroy-zero-owned-gpu-residue',residue});
 result.textContent=JSON.stringify({status:'passed',caseCount:cases.length,cases,errors,physicalInputAccepted:false,scope:'Actual Gravity Maze rules/physics/GUI with qualified public HYA tarballs; deterministic goal replay, not physical input or production pacing'});result.dataset.status='passed';
}catch(error){const setup={body:{...document.body.dataset},originalResult:result.textContent,productAvailable:!!globalThis.__g12Product};result.textContent=JSON.stringify({status:'failed',cases,errors,setup,error:String(error.stack??error)});result.dataset.status='failed';}
