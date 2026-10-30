import {GuiSystem,GuiInput,GuiRoot} from '/engine/dist/gui.js';
import {GuiTextBatch,GuiTextRenderer} from '/engine/dist/experimental.js';
const result=document.querySelector('#result'),cases=[],errors=[],owned=[];
let device,system,renderer,scoped=false;
const check=(condition,message)=>{if(!condition)throw Error(message);};
try{
 const adapter=await navigator.gpu.requestAdapter();check(adapter&&!adapter.info.isFallbackAdapter,'Native GPU required');
 device=await adapter.requestDevice();device.pushErrorScope('validation');scoped=true;device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const width=256,height=64,engine={device,format:'rgba8unorm',displayWidth:width,displayHeight:height,getDepthFormat:()=> 'depth24plus'};
 system=new GuiSystem(engine,{font:{chars:'?Aé👩🏽‍💻😀',fontSize:24,atlasSize:256,fontFamily:'sans-serif'}});system.renderer.prepare(engine);
 const root=new GuiRoot(),dynamic=root.add(new GuiInput({value:'A我',maxLength:4}));
 system.renderer.measureTextWidth(dynamic.value,24,root);
 let font=system.renderer.fontOwner.forRoot(root);check(font.chars.has('我'.codePointAt(0)),'Unseeded Chinese glyph must be rasterized');
 dynamic.beginComposition();dynamic.updateComposition('啊');system.renderer.measureTextWidth(dynamic.displayValue,24,root);check(system.renderer.fontOwner.forRoot(root).chars.has('啊'.codePointAt(0)),'IME preview glyph must be rasterized');dynamic.cancelComposition();font=system.renderer.fontOwner.forRoot(root);
 cases.push({id:'dynamic-Chinese-input-and-IME-atlas'});
 const text='é👩🏽‍💻😀😀',batch=new GuiTextBatch();batch.addText({text,x:0,y:0,width,height,fontSize:24,color:[.2,.6,.9,1]});batch.rebuild(font);
 check(batch.vertexCount===24,'Expected four grapheme quads');
 const measure=s=>system.renderer.measureTextWidth(s,24),input=new GuiInput({value:text});
 for(const index of [0,2,9,11,13])check(input.getCaretIndexAt(measure(text.slice(0,index)),measure,0)===index,`Caret boundary ${index}`);
 input.setCaret(11);input.deleteBackward();check(input.value==='é👩🏽‍💻😀','Independent emoji deletion');cases.push({id:'cluster-layout-caret-delete',vertices:batch.vertexCount,width:measure(text)});
 const atlas=font.pageImages[0],ctx=atlas.getContext('2d'),original=ctx.getImageData(0,0,atlas.width,atlas.height).data;
 let actualColorPixels=0;for(let i=0;i<original.length;i+=4)if(original[i+3]&&Math.max(original[i],original[i+1],original[i+2])-Math.min(original[i],original[i+1],original[i+2])>20)actualColorPixels++;
 check(actualColorPixels>0,'System emoji rasterization must contain color');cases.push({id:'system-emoji-atlas',actualColorPixels});
 // Render the complete input twice: adornments must survive text clipping and eye taps.
 const decoratedRoot=new GuiRoot({theme:{fontSize:20}}),password=decoratedRoot.add(new GuiInput({value:'A😀我',maxLength:4,inputType:'password',width:240,height:56}));decoratedRoot.layout(width,height);system.roots.add(decoratedRoot);
 const frames=[];
 for(let frame=0;frame<2;frame++){
  if(frame){for(const type of ['pointerdown','pointerup'])system.dispatchPointerEvent(null,{type,x:222,y:28,native:{pointerId:7,pointerType:'touch',button:0,buttons:type==='pointerdown'?1:0,preventDefault(){}}});check(password.displayValue==='A😀我','Eye must reveal complete Unicode value');check(password.inputType==='password','Secure host type must remain password');}
  const color=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),depth=device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT}),buffer=device.createBuffer({size:width*height*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});owned.push(color,depth,buffer);
  const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}});
  system.renderer.render(pass,[decoratedRoot],engine,false,1,{width,height,format:'rgba8unorm'});pass.end();encoder.copyTextureToBuffer({texture:color},{buffer,bytesPerRow:width*4},[width,height]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);frames.push(new Uint8ClampedArray(buffer.getMappedRange().slice(0)));buffer.unmap();
 }
 const different=(a,b,rect)=>{let n=0;for(let y=rect[1];y<rect[3];y++)for(let x=rect[0];x<rect[2];x++){const i=(y*width+x)*4;if(a.slice(i,i+3).some((v,k)=>Math.abs(v-b[i+k])>10))n++;}return n;};
 const eyeChanged=different(frames[0],frames[1],[212,18,232,38]),textChanged=different(frames[0],frames[1],[8,8,100,48]);check(eyeChanged>10,'Eye slash must visibly toggle');check(textChanged>20,'Password text must visibly toggle');
 const frame=frames[0],surface=frame.slice((40*width+120)*4,(40*width+120)*4+4);let counterPixels=0;for(let y=40;y<54;y++)for(let x=160;x<200;x++){const i=(y*width+x)*4;if(frame.slice(i,i+3).some((v,k)=>Math.abs(v-surface[k])>30))counterPixels++;}check(counterPixels>10,'Counter must produce visible pixels in bottom-right gutter');
 const preview=document.createElement('canvas');preview.width=width;preview.height=height*2;const context=preview.getContext('2d');frames.forEach((pixels,i)=>context.putImageData(new ImageData(pixels,width,height),0,i*height));
 cases.push({id:'input-eye-and-counter-gpu',eyeChanged,textChanged,counterPixels,preview:preview.toDataURL()});system.roots.delete(decoratedRoot);decoratedRoot.destroy();
 // Replace only glyph pixels with deterministic colors to test GPU output separately from OS font shape.
 for(let glyph=0;glyph<4;glyph++){
  const base=glyph*6*12,u=batch.vertexData[base+2],v=batch.vertexData[base+3],u1=batch.vertexData[base+12+2],v1=batch.vertexData[base+24+3];
  ctx.fillStyle=glyph===0?'black':'rgb(240,120,30)';ctx.fillRect(Math.round(u*atlas.width),Math.round(v*atlas.height),Math.round((u1-u)*atlas.width),Math.round((v1-v)*atlas.height));
 }
 renderer=new GuiTextRenderer();renderer.prepare(engine);
 for(const format of ['rgba8unorm','rgba8unorm-srgb']){
  renderer.surface={width,height,format};
  const color=device.createTexture({size:[width,height],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),depth=device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});owned.push(color,depth);
  const buffer=device.createBuffer({size:width*height*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});owned.push(buffer);
  const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}});
  renderer.render(pass,batch,font);pass.end();encoder.copyTextureToBuffer({texture:color},{buffer,bytesPerRow:width*4},[width,height]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const pixels=new Uint8Array(buffer.getMappedRange());
  const samples=[];for(let g=0;g<4;g++){const b=g*6*12,x=Math.floor((batch.vertexData[b]+batch.vertexData[b+12])/2),y=Math.floor((batch.vertexData[b+1]+batch.vertexData[b+25])/2),sample=[...pixels.slice((y*width+x)*4,(y*width+x)*4+4)],expected=g===0?[51,153,230,255]:[240,120,30,255];check(sample.every((n,i)=>Math.abs(n-expected[i])<=2),`${format} glyph ${g}: ${sample} vs ${expected}`);samples.push(sample);}buffer.unmap();cases.push({id:`gpu-color-and-black-alpha-mask-${format}`,samples});
 }
 await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope();scoped=false;if(validation)errors.push(validation.message);check(!errors.length,errors.join(';'));
 result.textContent=JSON.stringify({status:'passed',caseCount:cases.length,cases,errors,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture}});result.dataset.status='passed';
}catch(error){result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),cases,errors});result.dataset.status='failed';}
finally{renderer?.destroy();system?.destroy();for(const resource of owned)resource.destroy();if(scoped)await device.popErrorScope();device?.destroy();}
