import {guiContentBox} from '/artifacts/engine-0.2.3/g01/gui-content-reference.mjs';
const output=document.querySelector('#result'),cases=[];
try {
  for(const dpr of [1,2])for(const iconPosition of ['left','right'])for(const hasIcon of [false,true]){
    const host=document.createElement('div');
    host.style.cssText=`position:absolute;left:10px;top:20px;width:180px;height:40px;box-sizing:border-box;padding:8px;display:flex;align-items:center;gap:${hasIcon?6:0}px`;
    const icon=document.createElement('div'),text=document.createElement('div');
    icon.style.cssText='width:16px;height:8px;flex:none';text.style.cssText='flex:1;height:24px;min-width:0';
    if(iconPosition==='left'){if(hasIcon)host.append(icon);host.append(text);}else{host.append(text);if(hasIcon)host.append(icon);}
    document.querySelector('#fixtures').append(host);
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const target={icon:hasIcon?rect(icon):null,text:rect(text)};
    const source=guiContentBox({rect:{x:10,y:20,width:180,height:40},getResolvedStyle:()=>({padding:8,...(hasIcon?{icon:{width:16,height:8},iconSize:16,iconGap:6}:{})})},8,16);
    if(iconPosition==='left')for(const key of ['icon','text']){
      if(target[key]===null){if(source[key]!==null)throw Error('unexpected icon');continue;}
      for(const dimension of ['x','y','width','height'])if(Math.abs(target[key][dimension]-source[key][dimension])>.02)throw Error(key+'.'+dimension);
    }
    cases.push({dpr,iconPosition,hasIcon,cssPixels:target,devicePixels:Object.fromEntries(Object.entries(target).map(([k,v])=>[k,v&&Object.fromEntries(Object.entries(v).map(([p,n])=>[p,n*dpr]))])),currentSourceCompared:iconPosition==='left',targetOnly:iconPosition==='right'});host.remove();
  }
  output.textContent=JSON.stringify({status:'passed',qualification:false,cases,dprMethod:'CSS oracle measured once per case, deterministic device-pixel conversion at 1/2; not physical DPR/device qualification',toleranceCssPixels:.02});output.dataset.status='passed';
}catch(error){output.textContent=JSON.stringify({status:'failed',cases,error:String(error.stack??error)});output.dataset.status='failed';}
