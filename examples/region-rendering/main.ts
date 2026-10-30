import {HaiyueEngine,Entity,Camera3D,CartesianTransform3D,Mesh3D,createBox3D,ColorSRGB} from '@haiyue/engine';
import {BasicMaterial} from '@haiyue/engine/material';
import {GuiRoot,GuiElement,GuiLabel,GuiButton,GuiSystem} from '@haiyue/engine/gui';
import {Render3DSystem,getSceneRenderPipeline,getEngineFrameDiagnostics,getEngineGPUResourceTracker,type RenderCommandContext} from '@haiyue/engine/experimental';
import type {World} from '@haiyue/engine/ecs';

// Explicit experimental regional scheduling; no private source imports or package baseline changes.
async function main():Promise<void> {
  const canvas=document.querySelector<HTMLCanvasElement>('#canvas')!,status=document.querySelector<HTMLElement>('#status')!;
  const verify=new URLSearchParams(location.search).has('verify');
  const engine=new HaiyueEngine({canvas,msaaSamples:4,clearColor:{r:.04,g:.07,b:.12,a:1},diagnostics:{enabled:true}});
  let disposed=false;
  const cleanup=()=>{
    if(disposed)return;disposed=true;window.removeEventListener('pagehide',cleanup);
    const tracker=getEngineGPUResourceTracker(engine);engine.destroy();
    canvas.dataset.destroyed='true';if(verify)canvas.dataset.cleanup=JSON.stringify(tracker?.getDebugSnapshot().byType);
  };
  window.addEventListener('pagehide',cleanup);
  try {
    await engine.init();if(disposed)return;
    const info=engine.adapter?.info;canvas.dataset.adapter=JSON.stringify({vendor:info?.vendor,architecture:info?.architecture,description:info?.description,isFallbackAdapter:info?.isFallbackAdapter});
    const camera=new Entity('camera').addComponent(new Camera3D({fov:Math.PI/3,near:.1,far:100})).addComponent(new CartesianTransform3D({position:[0,0,5]}));
    const scene=engine.createScene({name:'regional-3d',camera,render3D:false,render2D:false,gui:false});
    const transform=new CartesianTransform3D({rotation:[.25,.3,0]});
    scene.add(new Entity('animated HDR box').addComponent(transform).addComponent(new Mesh3D(createBox3D({width:1.8,height:1.8,depth:1.8}),new BasicMaterial({color:ColorSRGB.fromHex('#6090d0'),emissiveFactor:[1,.3,.1]}))));
    const view=scene.renderView,side=view.createRegion({id:'sidebar',bounds:{x:0,y:0,width:1,height:1},updateMode:'demand',clearMode:'on-update',visible:true}),dynamic=view.createRegion({id:'scene',bounds:{x:1,y:0,width:1,height:1},updateMode:'continuous',clearMode:'on-update',visible:true});
    const counters={frames:0,guiRecords:0,sceneRecords:0,guiLayouts:0,guiUploads:0};
    class MeasuredGui extends GuiSystem {
      override record(world:World,context:RenderCommandContext):this {
        counters.guiRecords++;const before=getEngineFrameDiagnostics(engine)?.snapshot().counters.bufferUploads??0;
        try{return super.record(world,context);}finally{counters.guiUploads+=(getEngineFrameDiagnostics(engine)?.snapshot().counters.bufferUploads??0)-before;}
      }
    }
    class MeasuredScene extends Render3DSystem {
      override record(world:World,context:RenderCommandContext):this {counters.sceneRecords++;return super.record(world,context);}
    }
    const root=new GuiRoot({theme:{fontSize:15,radius:8}});
    root.add(new GuiElement({width:'100%',height:'100%',style:{backgroundColor:'#18243a',radius:0}}));
    root.add(new GuiLabel({x:16,y:16,width:'88%',height:30,text:'Cached sidebar',fontSize:19,style:{color:'#e2efff'}}));
    root.add(new GuiLabel({x:16,y:52,width:'88%',height:28,text:'Only changes redraw here',fontSize:12,style:{color:'#9bb3cf'}}));
    const revision=root.add(new GuiLabel({x:16,y:78,width:'88%',height:26,text:'Changes: 0',style:{color:'#8cdbfb'}}));
    let playing=true,changes=0,phase=.3;
    const toggle=root.add(new GuiButton({x:16,y:112,width:'86%',height:36,text:'Pause 3D',onClick:()=>{
      playing=!playing;dynamic.setMode(playing?'continuous':'demand');dynamic.invalidate('Pause/resume captures the current scene');toggle.setText(playing?'Pause 3D':'Resume 3D');canvas.dataset.playing=String(playing);
    }}));
    root.add(new GuiButton({x:16,y:164,width:'86%',height:36,text:'Change GUI',onClick:()=>{revision.setText(`Changes: ${++changes}`);canvas.dataset.changes=String(changes);}}));
    const render3D=new MeasuredScene(engine,camera),exposure=root.add(new GuiButton({x:16,y:216,width:'86%',height:36,text:'Exposure: 1',onClick:()=>{
      render3D.exposure=render3D.exposure===1?.5:1;dynamic.invalidate('Display exposure changed');exposure.setText(`Exposure: ${render3D.exposure}`);
    }}));
    root.add(new GuiLabel({x:16,y:280,width:'86%',height:90,text:'Pause, wait, then change GUI.\nThe simulation clock continues.\nResume wakes the 3D region.',fontSize:12,style:{color:'#9bb3cf'}}));
    const layout=root.root.layout.bind(root.root);root.root.layout=rect=>{counters.guiLayouts++;layout(rect);};
    scene.add(new Entity('sidebar GUI').addComponent(root));scene.addSystem(render3D,{region:dynamic,pass:'isolated'});scene.addSystem(new MeasuredGui(engine,{roots:new Set([root])}),{region:side,pass:'isolated'});
    const resize=()=>{const width=engine.displayWidth,height=engine.displayHeight,sidebar=Math.min(260,width*.3);side.setBounds({x:0,y:0,width:sidebar,height});dynamic.setBounds({x:sidebar,y:0,width:width-sidebar,height});};
    engine.on('resize',resize);resize();engine.switchScene(scene);
    engine.on('update',event=>{counters.frames++;if(playing){phase+=event.detail.delta*.0006;transform.setRotation(.25,phase,.1);}});
    let lastStatus=0;
    engine.on('after-update',event=>{
      const stats=getSceneRenderPipeline(scene).getDebugSnapshot().regions;
      if(verify||event.detail.time-lastStatus>250){
        canvas.dataset.snapshot=JSON.stringify({...counters,playing,changes,regions:stats});lastStatus=event.detail.time;
        status.textContent=`GUI draws: ${counters.guiRecords}   3D draws: ${counters.sceneRecords}\nCache: ${((stats?.retainedColorBytes??0)/1048576).toFixed(1)} MiB   Working: ${((stats?.workingColorBytes??0)/1048576).toFixed(1)} MiB\n${stats?.presentations?'Presenting':'All static: no render submission'}`;
      }
    });
    canvas.dataset.ready='true';canvas.dataset.playing='true';canvas.dataset.changes='0';engine.run();
  }catch(error){cleanup();throw error;}
}
void main().catch(error=>{const status=document.querySelector<HTMLElement>('#status')!;status.dataset.state='error';status.textContent=String(error);console.error(error);});
