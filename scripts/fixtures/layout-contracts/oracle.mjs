import {cases} from './cases.mjs';
const node=document.querySelector('#result');
try {
  const results=[];
  for(const c of cases){
    const parent=document.createElement('div');
    Object.assign(parent.style,{position:'absolute',left:'0px',top:'0px',width:`${c.width}px`,height:`${c.height}px`,boxSizing:'border-box',padding:'0',border:'0',...c.css});
    const children=c.childCss.map(style=>{const child=document.createElement('div');Object.assign(child.style,{minWidth:'0',minHeight:'0',boxSizing:'border-box',margin:'0',...style});parent.append(child);return child;});
    document.body.append(parent);const p=parent.getBoundingClientRect();
    const rectangles=children.map(child=>{const r=child.getBoundingClientRect();return {x:r.x-p.x,y:r.y-p.y,width:r.width,height:r.height};});
    const matches=rectangles.every((r,i)=>Object.keys(r).every(k=>Math.abs(r[k]-c.expected[i][k])<=0.02));
    results.push({id:c.id,rectangles,expected:c.expected,matches});parent.remove();
  }
  if(results.some(r=>!r.matches))throw Error(JSON.stringify(results));
  node.textContent=JSON.stringify({status:'passed',purpose:'CSS-subset-reference-not-product-layout',userAgent:navigator.userAgent,dpr:devicePixelRatio,font:'no text; empty border-box fixtures',tolerance:0.02,results});node.dataset.status='passed';
}catch(error){node.textContent=JSON.stringify({status:'failed',error:String(error.stack??error)});node.dataset.status='failed';}
