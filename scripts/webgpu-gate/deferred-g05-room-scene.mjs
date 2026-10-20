import {Entity,Transform3D,Mesh3D,Geometry3D,PbrMaterial,PointLight,AmbientLight,DirectionalLight,Camera3D,ColorLinear,createBox3D,mat4} from '../../artifacts/engine-0.2.1/g03/fixture.js';
import {createDeferredRoomFixture} from './deferred-room-fixture.mjs';

/** The frozen G01/G02 room content, using the same dimensions, palette and PRNG. */
export function installG05RoomScene(state,{count,overlap,moving=true}){
  const {world,render3d}=state,data=createDeferredRoomFixture({count});
  for(const entity of [...world.entities.values()])if(!entity.name.startsWith('real-camera:'))world.removeEntity(entity);
  render3d.passes.length=0;
  const materials=data.materials.map(m=>new PbrMaterial({baseColor:new ColorLinear(...m.color),metallic:m.metallic,roughness:m.roughness})),box=createBox3D();
  data.boxes.forEach((b,i)=>world.add(new Entity(`tiled-room-box:${i}`).addComponent(new Transform3D().setTranslation(...b.position)).addComponent(new Mesh3D(box,materials[b.material]))));
  const surfaces=[
    {p:[[-12,0,-12],[-12,0,12],[12,0,12],[12,0,-12]],n:[0,1,0]},
    {p:[[-12,0,12],[-12,0,-12],[-12,8,-12],[-12,8,12]],n:[1,0,0]},
    {p:[[12,0,-12],[12,0,12],[12,8,12],[12,8,-12]],n:[-1,0,0]},
    {p:[[-12,0,-12],[12,0,-12],[12,8,-12],[-12,8,-12]],n:[0,0,1]},
    {p:[[12,0,12],[-12,0,12],[-12,8,12],[12,8,12]],n:[0,0,-1]},
  ];
  surfaces.forEach((s,i)=>world.add(new Entity(`tiled-room-surface:${i}`).addComponent(new Transform3D()).addComponent(new Mesh3D(new Geometry3D({positions:new Float32Array(s.p.flat()),normals:new Float32Array(Array.from({length:4},()=>s.n).flat()),indices:new Uint32Array([0,1,2,0,2,3])}),materials[6]))));
  world.add(new Entity('tiled-room-ambient').addComponent(new AmbientLight({intensity:.1})));
  world.add(new Entity('tiled-room-directional').addComponent(new DirectionalLight({direction:data.directional.direction,intensity:.5})));
  const lights=data.lights.map((p,i)=>{
    const transform=new Transform3D(),light=new PointLight({color:new ColorLinear(...p.color),intensity:2,range:overlap?40:2});
    const entity=new Entity(`tiled-room-point:${i}`).addComponent(transform).addComponent(light);entity.disabled=i>=count;world.add(entity);return {entity,transform,light};
  });
  const cameras=state.views.map(v=>v.camera);for(const camera of cameras)camera.addComponent(new Camera3D({fov:Math.PI/3,near:.1,far:100}));
  const update=frame=>{
    const fixture=createDeferredRoomFixture({count,frame,overlap,moving,views:cameras.length});
    cameras.forEach((camera,i)=>camera.getComponent(Transform3D).setMatrix(mat4.cameraAim(fixture.cameras[i].position,fixture.cameras[i].target,[0,1,0])));
    lights.forEach((light,i)=>light.transform.setTranslation(...fixture.lights[i].position));
  };
  update(0);render3d.checkEntityManager(world);
  return {update,fixtureId:data.id,boxes:data.boxes.length,surfaces:surfaces.length,lights:count,overlap};
}
