import{HaiyueEngine}from'@haiyue/engine';
import{Entity}from'@haiyue/engine/ecs';
import{Transform2D}from'@haiyue/engine/components';
import{Tilemap2DComponent,Tilemap2DRenderSystem}from'@haiyue/extensions/tilemap';

/** AssetManager retains the atlas; the Tilemap borrows its recoverable handle. */
export async function createTilemapExample(canvas:HTMLCanvasElement,options:{columns?:number;rows?:number;atlas?:boolean;samples?:1|4}={}){
  const coldStart={startedAt:performance.now(),readyAt:0};
  const engine=new HaiyueEngine({canvas,msaaSamples:options.samples??1,timestampQuery:false,diagnostics:{enabled:true},clearColor:{r:.025,g:.045,b:.07,a:1}});await engine.init();
  const scene=engine.createScene({name:'Chunked terrain',camera:{type:'2d',camera2D:{designWidth:1280,designHeight:720,viewportMode:'fixed'}},render2D:false,render3D:false,gui:false});
  const atlasCanvas=document.createElement('canvas');atlasCanvas.width=16;atlasCanvas.height=8;const ctx=atlasCanvas.getContext('2d')!;
  ctx.fillStyle='#3b9b4e';ctx.fillRect(0,0,8,8);ctx.fillStyle='#8ddd68';ctx.fillRect(0,0,8,2);ctx.fillStyle='#2e7b40';ctx.fillRect(1,3,2,2);ctx.fillRect(5,5,2,2);
  ctx.fillStyle='#80523c';ctx.fillRect(8,0,8,8);ctx.fillStyle='#c89762';ctx.fillRect(8,0,8,2);ctx.fillStyle='#604132';ctx.fillRect(10,3,3,2);ctx.clearRect(15,7,1,1);
  const handle=await engine.assetManager!.loadTexture(atlasCanvas,{label:'tilemap-example-atlas',premultipliedAlpha:true,mipmaps:'none'}),source={get texture(){return handle.value;}},atlas={source,sourceWidth:16,sourceHeight:8,tileWidth:8,tileHeight:8};
  const columns=options.columns??512,rows=options.rows??512,cells=Int16Array.from({length:columns*rows},(_,i)=>(i%columns+Math.floor(i/columns)*3)%11===0?0:1+(Math.floor(i/columns/3)%2));
  const map=new Tilemap2DComponent({columns,rows,cells,cellWidth:32,cellHeight:32,originX:-640,originY:-360,gap:0,...(options.atlas===false?{}:{atlas})}),entity=new Entity('Terrain').addComponent(new Transform2D()).addComponent(map),system=new Tilemap2DRenderSystem(engine,scene.cameraEntity,{loadOp:'clear'});scene.add(entity);scene.addSystem(system);
  const camera=scene.cameraEntity.getComponent(Transform2D)??new Transform2D();if(!scene.cameraEntity.getComponent(Transform2D))scene.cameraEntity.addComponent(camera);
  let step=0,atlasMode=options.atlas!==false,disposed=false;
  const edit=()=>{for(let i=0;i<32;i++){const x=(step*13+i*17)%columns,y=(step*7+i*3)%rows;map.setCell(x,y,map.getCell(x,y)===1?2:1);}step++;};
  const pan=()=>{camera.x=(camera.x+512)%(columns*32);camera.y=(camera.y+256)%(rows*32);};
  const toggle=()=>{atlasMode=!atlasMode;map.setAtlas(atlasMode?atlas:null);};
  const reset=()=>{camera.x=0;camera.y=0;};
  const dispose=async()=>{if(disposed)return;disposed=true;engine.stop();scene.destroy();await engine.device.queue.onSubmittedWorkDone();for(let i=0;i<6;i++)await Promise.resolve();handle.release();engine.destroy();};
  engine.switchScene(scene).run();coldStart.readyAt=performance.now();
  return {engine,scene,map,entity,system,atlas,handle,camera,edit,pan,toggle,reset,dispose,coldStart,stats:()=>({logicalCells:map.columns*map.rows,version:map.version,atlasMode,edits:step})};
}
