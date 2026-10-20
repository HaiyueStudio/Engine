import { GuiBatch, GuiTextBatch, GuiImageBatch, GuiShapeRenderer, GuiTextRenderer, GuiImageRenderer, buildBitmapFont } from '/engine/dist/experimental.js';
const node = document.querySelector('#result');
try {
  const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
  const errors = []; device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  device.pushErrorScope('validation');
  const engine = {device, format:'rgba8unorm', displayWidth:128, displayHeight:128, getDepthFormat: () => 'depth24plus'};
  const textures = [[255,0,0,255],[0,255,0,255]].map(color => {
    const t=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture:t},new Uint8Array(color),{bytesPerRow:4},[1,1]); return t;
  });
  const font=buildBitmapFont({chars:'ABC?',fontSize:16,atlasSize:128}).data;
  const make = () => ({shape:new GuiBatch(),text:new GuiTextBatch(),image:new GuiImageBatch()});
  const cached=make(), renderers=[new GuiShapeRenderer(),new GuiTextRenderer(),new GuiImageRenderer()];
  renderers.forEach(r => r.prepare(engine));
  const fill = (b,i) => {
    b.shape.clear(); b.text.clear(); b.image.clear();
    b.shape.addShape({x:8,y:8,width:90,height:50,radius:12,strokeWidth:1,color:[.3,.4,1,.7],clip:{x:0,y:0,width:i<4?128:70,height:128}});
    b.text.addText({text:i%3?'ABC':'BCA',x:8,y:64,width:80,height:30,fontSize:16,color:[1,1,1,1]});
    b.image.addImage({source:textures[i%2],x:104,y:8,width:16,height:30,uv:[0,0,1,1],color:[1,1,1,1]});
    b.shape.rebuild(); b.text.rebuild(font); b.image.rebuild();
  };
  async function pixels(b,samples) {
    renderers.forEach(r => r.msaaSamples=samples);
    const output=device.createTexture({size:[128,128],format:engine.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
    const msaa=samples===4?device.createTexture({size:[128,128],format:engine.format,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT}):null;
    const depth=device.createTexture({size:[128,128],format:'depth24plus',sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT});
    const read=device.createBuffer({size:512*128,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder(); const pass=encoder.beginRenderPass({colorAttachments:[{view:(msaa??output).createView(),...(msaa?{resolveTarget:output.createView()}:{}),clearValue:[0,0,0,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:1}});
    renderers[0].render(pass,b.shape);renderers[1].render(pass,b.text,font);renderers[2].render(pass,b.image);pass.end();
    encoder.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:512},[128,128]);device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);const result=new Uint8Array(read.getMappedRange()).slice();read.unmap();read.destroy();output.destroy();msaa?.destroy();depth.destroy();return result;
  }
  let frames=0;
  for(const samples of [1,4]) for(let i=0;i<8;i++) {
    engine.displayWidth=i<6?128:256;
    fill(cached,i);const fresh=make();fill(fresh,i);
    const a=await pixels(cached,samples),b=await pixels(fresh,samples);
    if(!a.some((v,j)=>j%4!==3&&v>0)||a.some((v,j)=>v!==b[j])) throw Error('Cached/fresh pixels differ: '+samples+':'+i);
    renderers[0].releaseBatch(fresh.shape);renderers[1].releaseBatch(fresh.text);renderers[2].releaseBatch(fresh.image);frames++;
  }
  renderers.forEach(r=>r.destroy());textures.forEach(t=>t.destroy());await device.queue.onSubmittedWorkDone();
  const scoped=await device.popErrorScope();if(scoped||errors.length)throw Error(JSON.stringify({scoped:scoped?.message,errors}));
  node.textContent=JSON.stringify({status:'passed',frames,msaa:[1,4],coverage:['retained/fresh pixel equality','texture alternation','clip mutation','text mutation','viewport resize','resource teardown'],validationErrors:errors});node.dataset.status='passed';device.destroy();
} catch(error) {node.textContent=JSON.stringify({status:'failed',error:String(error.stack??error)});node.dataset.status='failed';}
