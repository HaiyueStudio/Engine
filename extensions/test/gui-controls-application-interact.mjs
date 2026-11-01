import assert from'node:assert/strict';
/** Trusted CDP browser actions against the actual installed example, not direct controller calls. */
export async function interactWithGuiControls(cdp,{screenshot}={}){
 const actions=[],evaluate=async expression=>{const reply=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(reply.result?.exceptionDetails)throw Error(JSON.stringify(reply.result.exceptionDetails));return reply.result?.result?.value;},pause=()=>new Promise(r=>setTimeout(r,100));
 for(let i=0;i<450;i++){if(await evaluate("document.getElementById('result').dataset.status==='failed'"))return actions;if(await evaluate('!!window.g10Application?.ready'))break;if(i===449)throw Error('Actual example did not prepare.');await pause();}
 if(screenshot){const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});if(shot.result?.data)screenshot(shot.result.data);}
 const state=()=>evaluate('window.g10Application.state()'),point=key=>evaluate('window.g10Application.point('+JSON.stringify(key)+')');
 const move=async key=>{const p=await point(key);await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await pause();return p;};
 const click=async key=>{const p=await move(key);await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,clickCount:1});await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',buttons:0,clickCount:1});await pause();actions.push({type:'click',key,state:await state()});};
 const key=async(value,code,keyCode,modifiers=0)=>{await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode,modifiers});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode,modifiers});await pause();actions.push({type:'key',key:value,state:await state()});};
 try{
 await move('input');assert.equal((await state()).cursor,'text');actions.push({type:'cursor',expected:'text'});await move('badge');assert.equal((await state()).cursor,'pointer');actions.push({type:'cursor',expected:'pointer'});
 await click('badge');assert.equal((await state()).badgeClicks,1);
 await click('tab1');assert.equal((await state()).active,'tab-1');await key('ArrowLeft','ArrowLeft',37);assert.equal((await state()).active,'tab-0');
 await click('breadcrumb');assert.equal((await state()).status,'Navigate: path-0');await click('menu');assert.equal((await state()).modal,true);await key('Escape','Escape',27);assert.equal((await state()).modal,false);
 await click('input');await key('a','KeyA',65,2);await cdp.call('Input.insertText',{text:'Updated'});await pause();assert.equal((await state()).value,'Updated');actions.push({type:'native-text',value:'Updated'});
 await click('arrow');assert.deepEqual((await state()).expanded,[]);await click('header');assert.deepEqual((await state()).expanded,['panel-0']);assert.equal((await state()).value,'Updated');await click('close');assert.equal((await state()).tabs,11);
 await evaluate('window.g10Application.finish('+JSON.stringify(actions)+')');return actions;
 }catch(error){throw new Error(error.message+'; GUI state: '+JSON.stringify(await state())+'; prior actions: '+JSON.stringify(actions),{cause:error});}
}
