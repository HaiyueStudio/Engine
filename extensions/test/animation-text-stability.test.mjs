import test from 'node:test';
import assert from 'node:assert/strict';
import {AnimationTextRasterizer} from '../dist-test/animation/AnimationTextRasterizer.js';

async function fixture(component,run){
 const oldDocument=globalThis.document,oldBitmap=globalThis.createImageBitmap;let bitmaps=0,draws=0,closed=0;
 const context={setTransform(){},clearRect(){},fillRect(){},save(){},restore(){},rotate(){},scale(){},translate(){},measureText(){return{width:10};},fillText(){draws++;}};
 globalThis.document={createElement(){return{width:0,height:0,getContext(){return context;}};}};
 globalThis.createImageBitmap=async canvas=>{bitmaps++;return{width:canvas.width,height:canvas.height,close(){closed++;}};};
 let rasterizer;
 try{rasterizer=new AnimationTextRasterizer({type:'text2d',text:'A',size:[100,40],color:[1,1,1,1],...component});await rasterizer.whenReady();await run(rasterizer,()=>({bitmaps,draws,closed}));}
 finally{rasterizer?.destroy();if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;if(oldBitmap===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=oldBitmap;}
}
test('discrete documents retain immutable bitmap generation between content changes and when seeking backwards',async()=>fixture({documents:[{time:0,text:'A'},{time:10,text:'B'}]},async(r,stats)=>{
 const snapshot=r.acquireTextureSnapshot(),initial=r.textureVersion;
 for(let i=1;i<=60;i++){r.setTime(i/60);await r.whenReady();}
 assert.equal(stats().bitmaps,1);assert.equal(r.textureVersion,initial);assert.equal(snapshot.value,r.texture);
 r.setTime(10);await r.whenReady();assert.equal(stats().bitmaps,2);assert.equal(stats().closed,0,'retained previous bitmap stays alive');snapshot.release();assert.equal(stats().closed,1);
 r.setTime(0);await r.whenReady();assert.equal(stats().bitmaps,3);
}));
test('identical adjacent documents reuse pixels; font and size changes invalidate',async()=>fixture({documents:[{time:0,text:'A'},{time:1,text:'A'}]},async(r,stats)=>{
 r.setTime(1);await r.whenReady();assert.equal(stats().bitmaps,1);
 r.invalidateFont();await r.whenReady();assert.equal(stats().bitmaps,2);
 r.component.size[0]=120;r.setTime(2);await r.whenReady();assert.equal(stats().bitmaps,3);
}));
test('stable expression output reuses pixels while changed resolved data redraws once',async()=>fixture({expression:{version:1,result:'text',localCount:0,instructions:[{op:'data',resource:'data',path:['label']},{op:'return'}]}},async(r,stats)=>{
 r.setExpressionData('data',{label:'B'});await r.whenReady();const count=stats().bitmaps;
 for(let i=1;i<=10;i++){r.setTime(i/10);await r.whenReady();}assert.equal(stats().bitmaps,count);
 r.setExpressionData('data',{label:'C'});await r.whenReady();assert.equal(stats().bitmaps,count+1);
}));
test('font invalidation during an in-flight bitmap cannot be swallowed by the previous generation',async()=>{
 const previousDocument=globalThis.document,previousBitmap=globalThis.createImageBitmap;let finish,bitmaps=0;
 globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>null})};
 globalThis.createImageBitmap=async canvas=>{const value={width:canvas.width,height:canvas.height,close(){}};bitmaps++;if(bitmaps===1)await new Promise(resolve=>{finish=resolve;});return value;};
 let r;try{r=new AnimationTextRasterizer({type:'text2d',text:'A',size:[20,20],color:[1,1,1,1]});r.invalidateFont();finish();await r.whenReady();assert.equal(bitmaps,2);}finally{r?.destroy();if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;if(previousBitmap===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=previousBitmap;}
});
test('continuous text animators continue rasterizing at distinct sample times',async()=>fixture({animators:[{selector:{start:0,end:1,units:'index',shape:'square',basedOn:'characters'},positionTrack:{times:[0,1],values:[[0,0],[10,0]],interpolation:'linear'}}]},async(r,stats)=>{
 r.setTime(.25);await r.whenReady();r.setTime(.5);await r.whenReady();assert.equal(stats().bitmaps,3);
}));
