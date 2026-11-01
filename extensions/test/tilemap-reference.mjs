// Independent full-map reference; deliberately does not import chunk/window/UV helpers.
export const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
export function projection(width,height,left=0,bottom=0){const m=identity();m[0]=2/width;m[5]=2/height;m[12]=-1-2*left/width;m[13]=-1-2*bottom/height;return m;}
export function atlasPixels(){
 const width=12,height=6,bytes=new Uint8Array(width*height*4);for(let i=0;i<width*height;i++)bytes.set([255,0,255,255],i*4);
 for(let tile=0;tile<2;tile++)for(let y=0;y<4;y++)for(let x=0;x<4;x++){
  const alpha=(x+y+tile)%4===0?0:(x+y)%3===0?128:255,r=tile?220-x*30:30+x*60,g=20+y*60,b=tile?40:210;
  bytes.set([Math.round(r*alpha/255),Math.round(g*alpha/255),Math.round(b*alpha/255),alpha],((y+1)*width+1+tile*6+x)*4);
 }return {width,height,bytes,tileWidth:4,tileHeight:4,margin:1,spacing:2};
}
const referenceCorners=[[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]];
const uvMatrices={none:[1,0,0,0,1,0],'flip-x':[-1,0,1,0,1,0],'flip-y':[1,0,0,0,-1,1],'rotate-90':[0,1,0,-1,0,1],'rotate-180':[-1,0,1,0,-1,1],'rotate-270':[0,-1,1,1,0,0]};
export function fullMapVertices(map,atlas=null,storage=null){
 let cells=0;for(let i=0;i<map.columns*map.rows;i++)if(map.cells[i]>0)cells++;
 const size=cells*6*(atlas?8:6),data=storage&&storage.length>=size?storage:new Float32Array(size);let offset=0;
 for(let row=0;row<map.rows;row++)for(let column=0;column<map.columns;column++){
  const value=map.cells[row*map.columns+column]??0;if(value<=0)continue;
  const x=map.originX+column*map.cellWidth+map.gap/2,y=map.originY+row*map.cellHeight+map.gap/2,w=Math.max(0,map.cellWidth-map.gap),h=Math.max(0,map.cellHeight-map.gap),color=map.palette[value]??map.palette[1]??[1,1,1,1];
  let px=0,py=0,uv=uvMatrices.none;
  if(atlas){const cols=Math.floor((atlas.sourceWidth-2*atlas.margin+atlas.spacing)/(atlas.tileWidth+atlas.spacing)),tile=value-1;px=atlas.margin+(tile%cols)*(atlas.tileWidth+atlas.spacing);py=atlas.margin+Math.floor(tile/cols)*(atlas.tileHeight+atlas.spacing);uv=uvMatrices[map.getCellTransform(column,row)];}
  for(const corner of referenceCorners){const u=corner[0],v=corner[1];data[offset++]=x+u*w;data[offset++]=y+v*h;
   if(atlas){data[offset++]=(px+.5+(uv[0]*u+uv[1]*v+uv[2])*(atlas.tileWidth-1))/atlas.sourceWidth;data[offset++]=(py+.5+(uv[3]*u+uv[4]*v+uv[5])*(atlas.tileHeight-1))/atlas.sourceHeight;data[offset++]=1;data[offset++]=1;data[offset++]=1;data[offset++]=1;}
   else {data[offset++]=color[0]??1;data[offset++]=color[1]??1;data[offset++]=color[2]??1;data[offset++]=color[3]??1;}
  }
 }return data.subarray(0,size);
}

export class FullMapReference {
 constructor(device,{palette,textured,format='rgba8unorm',samples=1,depth='depth24plus'}={}){
  this.device=device;this.format=format;this.samples=samples;this.depth=depth;this.buffers=[];
  this.camera=device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.object=device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.buffers.push(this.camera,this.object);
  const camera=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}}]}),object=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}}]}),material=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]});
  this.cameraGroup=device.createBindGroup({layout:camera,entries:[{binding:0,resource:{buffer:this.camera}}]});this.objectGroup=device.createBindGroup({layout:object,entries:[{binding:0,resource:{buffer:this.object}}]});this.materialLayout=material;this.sampler=device.createSampler({magFilter:'nearest',minFilter:'nearest'});
  this.pipelines=[false,true].map(atlas=>{const module=device.createShaderModule({code:atlas?textured:palette});return device.createRenderPipeline({layout:device.createPipelineLayout({bindGroupLayouts:atlas?[camera,object,material]:[camera,object]}),vertex:{module,entryPoint:'vs_main',buffers:[{arrayStride:atlas?32:24,attributes:atlas?[{shaderLocation:0,offset:0,format:'float32x2'},{shaderLocation:1,offset:8,format:'float32x2'},{shaderLocation:2,offset:16,format:'float32x4'}]:[{shaderLocation:0,offset:0,format:'float32x2'},{shaderLocation:1,offset:8,format:'float32x4'}]}]},fragment:{module,entryPoint:'fs_main',targets:[{format,blend:{color:{srcFactor:atlas?'one':'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},primitive:{topology:'triangle-list'},depthStencil:{format:depth,depthWriteEnabled:false,depthCompare:'always'},multisample:{count:samples}});});
  this.version=-1;this.map=null;this.vertex=null;this.vertexBytes=0;this.count=0;this.uploadBytes=0;this.uploadCalls=0;this.atlas=null;this.retired=[];
 }
 record(pass,map,view,world,atlas=null){
  if(this.map!==map||this.version!==map.version||this.atlas!==atlas){
   const vertices=fullMapVertices(map,atlas,this.cpuData);this.cpuData=vertices;if(vertices.byteLength>this.vertexBytes){if(this.vertex)this.retired.push(this.vertex);this.vertexBytes=Math.max(vertices.byteLength,4);this.vertex=this.device.createBuffer({size:this.vertexBytes,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});this.buffers.push(this.vertex);}
   if(vertices.byteLength){this.device.queue.writeBuffer(this.vertex,0,vertices);this.uploadBytes+=vertices.byteLength;this.uploadCalls++;}this.count=vertices.length/(atlas?8:6);this.map=map;this.version=map.version;this.atlas=atlas;
  }
  this.device.queue.writeBuffer(this.camera,0,view);if(!this.objectSnapshot||world.some((value,i)=>value!==this.objectSnapshot[i])){this.device.queue.writeBuffer(this.object,0,world);this.objectSnapshot=world.slice();}pass.setPipeline(this.pipelines[atlas?1:0]);pass.setBindGroup(0,this.cameraGroup);pass.setBindGroup(1,this.objectGroup);
  if(atlas){const texture=atlas.source.texture;if(this.texture!==texture){this.texture=texture;this.materialGroup=this.device.createBindGroup({layout:this.materialLayout,entries:[{binding:0,resource:texture.createView()},{binding:1,resource:this.sampler}]});}pass.setBindGroup(2,this.materialGroup);}
  if(this.count){pass.setVertexBuffer(0,this.vertex);pass.draw(this.count);}
 }
 destroy(){for(const buffer of this.buffers)buffer.destroy();this.buffers=[];}
}
