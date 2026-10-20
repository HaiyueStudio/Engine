import {oracleCases,cssStyle} from './shared-layout-oracle-cases.mjs';
const resultNode=document.querySelector('#result');
try{
  const expectedDpr=Number(new URL(location.href).searchParams.get('dpr')??1),deadline=performance.now()+5000;
  while(devicePixelRatio!==expectedDpr){if(performance.now()>deadline)throw Error(`Expected DPR ${expectedDpr}, received ${devicePixelRatio}`);await new Promise(requestAnimationFrame);}
  const {createLayoutSession}=await import('/shared-layout-build/layout.js');
  const results=[],failures=[];
  for(const c of oracleCases){
    const frame=document.createElement('div');Object.assign(frame.style,{position:'absolute',left:'0',top:'0',width:`${c.width}px`,height:`${c.height}px`});document.body.append(frame);
    const elements=new Map();
    function build(node){const e=document.createElement('div');Object.assign(e.style,cssStyle(node.style));elements.set(node.id,e);for(const child of node.children??[])e.append(build(child));return e;}
    const root={id:'root',contentVersion:0,style:c.style,children:c.children},element=build(root);element.style.width=`${c.width}px`;element.style.height=`${c.height}px`;frame.append(element);
    const session=createLayoutSession();
    try{
      const solved=session.update(root,{width:{mode:'exact',value:c.width},height:{mode:'exact',value:c.height}},()=>({width:0,height:0,minWidth:0,minHeight:0}));
      const parent=element.getBoundingClientRect();let maximumError=0;
      const differences=[];
      for(const [id,rect]of solved.rects){const dom=elements.get(id).getBoundingClientRect(),expected={x:dom.x-parent.x,y:dom.y-parent.y,width:dom.width,height:dom.height};for(const key of Object.keys(expected)){const error=Math.abs(rect[key]-expected[key]);maximumError=Math.max(maximumError,error);if(error>0.02)differences.push({id,key,actual:rect[key],expected:expected[key],error});}}
      const observation={id:c.id,maximumError,...(differences.length?{differences}:{})};results.push(observation);if(differences.length)failures.push(observation);
    }catch(error){const observation={id:c.id,error:String(error.stack??error)};results.push(observation);failures.push(observation);}
    finally{session.dispose();frame.remove();}
  }
  resultNode.textContent=JSON.stringify({status:failures.length?'failed':'passed',suite:'g02-shared-layout-geometry',tolerance:0.02,dpr:devicePixelRatio,userAgent:navigator.userAgent,cases:results.length,failures,results});
  resultNode.dataset.status=failures.length?'failed':'passed';
}catch(error){resultNode.textContent=JSON.stringify({status:'failed',error:String(error.stack??error)});resultNode.dataset.status='failed';}
