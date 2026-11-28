import {createGuiLibraryExample} from '../../examples/gui-library/application.ts';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
const output=document.querySelector('#result'),frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const finish=value=>{output.dataset.status=value.status;output.textContent=JSON.stringify(value);};
try{
  await document.fonts.ready;const query=new URLSearchParams(location.search),app=await createGuiLibraryExample(document.querySelector('canvas'),query.get('theme')==='light'?'light':'dark'),errors=[],cases=[];
  const device=app.engine.device;device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation');
  addEventListener('error',event=>{const path=[];for(let node=app.root.findById(event.error?.nodeId);node;node=node.parent)path.unshift(node.themeControlType);console.error('GUI layout node:',event.error?.nodeId,path.join(' / '));});
  const wait=async(count=3)=>{for(let i=0;i<count;i++)await frame();};await wait(16);
  const check=(value,message)=>{if(!value)throw Error(message);};
  const state=()=>({focus:app.gui.focus.focused?.text??app.gui.focus.focused?.id??null,modal:!!app.gui.focus.modal,menu:app.menu.isOpen,context:app.context.isOpen,status:app.status.text,range:app.root.root.children.find(n=>n.id==='library-slider')?.range});
  const rect=node=>({...node.rect});
  const snapshot=()=>({card:rect(app.card.element),cardBody:rect(app.card.body),name:rect(app.name),alert:rect(app.warning.element),segmented:rect(app.selected.element),avatar:rect(app.avatar.element),image:rect(app.image.image),spin:rect(app.spin.element),collapse:rect(app.collapse.element),list:app.list.stats,tree:app.tree.stats});
  window.probe={state,snapshot,point(id){const pending=[app.root.root];while(pending.length){const node=pending.pop();if(node.id===id)return{x:node.rect.x+node.rect.width/2,y:node.rect.y+node.rect.height/2};pending.push(...node.children);}throw Error('Missing node '+id);},focus(id){const pending=[app.root.root];while(pending.length){const node=pending.pop();if(node.id===id){app.gui.focus.focus(node);return;}pending.push(...node.children);}throw Error('Missing focus '+id);},async mode(mode){
    for(const overlay of [app.menu,app.popover,app.confirm,app.dialog,app.drawer,app.context])overlay.close();app.notices.closeAll();
    if(mode==='menu'){app.menu.open();app.menu.menu.buttons[1].handleAction({action:'right',source:'gamepad',consumed:false,consume(){this.consumed=true;}});}
    else if(mode==='dialog')app.dialog.open();else if(mode==='drawer')app.drawer.open();else if(mode==='popover')app.popover.open();else if(mode==='confirm')app.confirm.open();else if(mode==='notice')app.notices.open({key:'test',title:'Changes saved',description:'A keyed, bounded notification without a focus trap.',status:'success',durationMs:0});
    await wait();return state();
  },async finish(mode){
    const bounds=snapshot();check(bounds.card.width===368&&bounds.card.height===230,'Card geometry');check(bounds.name.width>100&&bounds.name.height>=28&&bounds.name.y>=bounds.cardBody.y,'Borrowed editor layout');check(bounds.list.rowInstances<20&&bounds.list.logicalItems===1000,'Virtual list window');check(bounds.alert.height>=60&&bounds.image.width>0&&bounds.spin.width>0,'Display geometry');cases.push({id:'public-gallery-layout',bounds});
    app.stopAnimations();app.gui.focus.blur();await wait(6);const frames=[];for(let i=0;i<12;i++){await frame();const snapshot=getEngineDiagnosticsSnapshot(app.engine);frames.push({frame:snapshot.frame.frame,uploads:snapshot.frame.counters.bufferUploads});}await device.queue.onSubmittedWorkDone();const scoped=await device.popErrorScope();if(scoped)errors.push(scoped.message);check(new Set(frames.map(item=>item.frame)).size===12,'Static frame diagnostics must advance');check(frames.every(item=>item.uploads===0),'Static GUI uploaded buffers: '+JSON.stringify(frames));check(errors.length===0,errors.join('\n'));
    const diagnostics=getEngineDiagnosticsSnapshot(app.engine);finish({status:'passed',mode,cases,staticFrames:frames,errors,diagnostics,scope:'P1 native visuals, original input routing, static uploads and public-package composition; no formal performance baseline'});
  },fail(error){finish({status:'failed',error,errors,cases});}};
  window.addEventListener('pagehide',()=>app.dispose(),{once:true});document.querySelector('canvas').dataset.ready='true';
}catch(error){finish({status:'failed',error:String(error.stack??error)});}
