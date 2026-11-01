import{createCollectionExample}from'/feature-consumer/browser/application.js';
import{getEngineDiagnosticsSnapshot}from'@haiyue/engine/diagnostics';
import{profile,validateCollectionBrowserResult}from'./gui-collections-browser-policy.mjs';
const output=document.querySelector('#result'),checks=[],cases=[],gpuErrors=[],assert=(condition,label)=>{if(!condition)throw Error(label);if(!checks.includes(label))checks.push(label);},frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
let app,device,scope=false;
try{
 app=await createCollectionExample(document.querySelector('canvas'));device=app.engine.device;device.addEventListener('uncapturederror',event=>gpuErrors.push(event.error.message));device.pushErrorScope('validation');scope=true;
 const info=app.engine.adapter.info,adapter={vendor:info.vendor,architecture:info.architecture,description:info.description,isFallbackAdapter:info.isFallbackAdapter};await frames(profile.warmupFrames);
 for(const count of profile.logicalItems){
  const items=Array.from({length:count},(_,i)=>({key:'item-'+i,value:'Item '+i})),nodes=Array.from({length:10},(_,i)=>({key:'group-'+i,value:'Group '+i,children:Array.from({length:count/10-1},(_,j)=>({key:'node-'+i+'-'+j,value:'Node '+i+' / '+j,disabled:j===2}))}));
  for(const mutation of profile.mutationPercent){
   app.list.setItems(items.map((item,i)=>i<count*mutation/100?{...item,value:'Edited '+i}:item));let index=0;
   const changed=nodes.map(node=>{const own=index++<count*mutation/100,children=node.children.map(child=>index++<count*mutation/100?{...child,value:'Edited '+child.value}:child);return own||children.some((child,i)=>child!==node.children[i])?{...node,value:own?'Edited '+node.value:node.value,children}:node;});
   app.tree.setNodes(changed);app.tree.setExpandedKeys(nodes.map(node=>node.key));
   for(const offset of profile.offsets){app.list.setScrollOffset(offset);app.tree.setScrollOffset(offset);await frames(2);const stats=app.list.stats,tree=app.tree.stats,cache=app.gui.renderer.rootCaches.get(app.root),frame=getEngineDiagnosticsSnapshot(app.engine).frame;cases.push({count,mutation,offset,rows:stats.rowInstances,bound:stats.boundRows,live:app.rowCounts.created-app.rowCounts.disposed,treeLogical:tree.logicalItems,treeRows:tree.rowInstances,treeBound:tree.boundRows,textVertices:cache.textBatch.vertexCount,shapeVertices:cache.batch.vertexCount,frame});}
  }
 }
 assert(cases.length===24&&cases.every(c=>c.rows<=24&&c.live===c.rows),'window-matrix');
 let layouts=0,measurements=0;const layout=app.root.root.layout,measure=app.gui.renderer.measureTextWidth;app.root.root.layout=function(...args){layouts++;return layout.apply(this,args);};app.gui.renderer.measureTextWidth=function(...args){measurements++;return measure.apply(this,args);};
 const before={...app.rowCounts};await frames(12);const staticWork={bindings:app.rowCounts.bind-before.bind,created:app.rowCounts.created-before.created,layouts,measurements};app.root.root.layout=layout;app.gui.renderer.measureTextWidth=measure;if(!Object.values(staticWork).every(v=>v===0))throw Error('static-work '+JSON.stringify(staticWork));assert(true,'static-work');
 app.list.setItems(app.items);app.list.setScrollOffset(2803);app.list.setItems([{key:'new',value:'New'},...app.items]);assert(app.list.element.scrollY===2831,'anchor');
 app.list.setSelection('item-500');app.gui.focus.focus(app.list.element);app.gui.dispatchAction('down','keyboard');assert(app.list.selectedKey==='item-501'&&app.list.element.scrollY>10000,'offscreen-navigation');
 app.list.setScrollOffset(0);await frames(2);const editor=app.list.element.children[0].children[0];app.gui.focus.focus(editor);editor.beginComposition();editor.updateComposition('nihao');app.list.setScrollOffset(14000);assert(!editor.isComposing&&app.gui.focus.focused!==editor,'ime-retirement');
 app.tree.scrollToKey('node-9-90');app.tree.setSelection('node-9-90');assert(app.tree.getExpandedKeys().includes('group-9')&&app.tree.stats.rowInstances<=25,'tree-expansion');await frames(2);
 await device.queue.onSubmittedWorkDone();const error=await device.popErrorScope();scope=false;if(error)gpuErrors.push(error.message);
 const coldStart=app.coldStart,lifecycle={created:app.rowCounts.created,disposed:0,bindings:app.rowCounts.bind,unbound:0};app.dispose();lifecycle.disposed=app.rowCounts.disposed;lifecycle.unbound=app.rowCounts.unbind;const finalGpu=getEngineDiagnosticsSnapshot(app.engine).gpuResources.totals;app=null;assert(finalGpu.resources===0&&finalGpu.estimatedBytes===0&&lifecycle.created===lifecycle.disposed&&lifecycle.bindings===lifecycle.unbound,'resource-teardown');
 const result={schemaVersion:1,status:'passed',qualification:false,physicalInputQualification:false,syntheticEvents:true,profile,checks,adapter,cases,staticWork,lifecycle,finalGpu,gpuErrors,coldStart};const validation=validateCollectionBrowserResult(result);if(validation.status!=='passed')throw Error(validation.errors.join('; '));output.textContent=JSON.stringify(result);output.dataset.status='passed';
}catch(error){output.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),checks,cases,gpuErrors});output.dataset.status='failed';}
finally{if(scope&&device)try{await device.popErrorScope();}catch{}if(app)try{app.dispose();}catch{}}
