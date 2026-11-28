import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
const {World}=await importEngineSource('ecs/World.ts');
const {Entity}=await importEngineSource('ecs/Entity.ts');
const {Transform2D}=await importEngineSource('components/Transform2D.ts');
const {Transform3D}=await importEngineSource('components/Transform3D.ts');
const {Mesh3D}=await importEngineSource('components/Mesh3D.ts');
const {Geometry3D}=await importEngineSource('geometry/Geometry3D.ts');
const {BasicMaterial}=await importEngineSource('material/BasicMaterial.ts');
const {getSpatialIndexService}=await importEngineSource('spatial/SpatialIndexService.ts');
for(const dimension of [2,3]){
 const transform=x=>dimension===2?new Transform2D({x}):new Transform3D().setTranslation(x,0,0);
 test(`${dimension}D equal parent revisions still invalidate a reparented subtree and root detach`,()=>{
  const world=new World(),aTransform=transform(10),bTransform=transform(20),childTransform=transform(1),grandchildTransform=transform(2);
  const a=new Entity('A').add(aTransform),b=new Entity('B').add(bTransform),child=new Entity('Child').add(childTransform),grandchild=new Entity('Grandchild').add(grandchildTransform);
  child.addChild(grandchild);a.addChild(child);world.add(a).add(b);
  const frame=world.frameData.begin(world,null,0,0);frame.transforms.getWorldMatrix(grandchild);frame.transforms.getWorldMatrix(b);
  assert.equal(aTransform.worldVersion,bTransform.worldVersion);
  b.addChild(child);frame.begin(world,null,1,16);frame.transforms.flushDirtyWorldVersions();
  assert.equal(frame.transforms.getWorldMatrix(child)[12],21);assert.equal(frame.transforms.getWorldMatrix(grandchild)[12],23);
  b.removeChild(child);world.add(child);frame.begin(world,null,2,16);frame.transforms.flushDirtyWorldVersions();
  assert.equal(frame.transforms.getWorldMatrix(child)[12],1);assert.equal(frame.transforms.getWorldMatrix(grandchild)[12],3);
  world.destroy();
 });
 test(`${dimension}D static parent identity and revision keep the matrix early return`,()=>{
  const subject=transform(1),parent=Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,10,0,0,1]);
  subject.updateWorldMatrix(parent,7);const first=subject.worldVersion;subject.updateWorldMatrix(parent,7);assert.equal(subject.worldVersion,first);
  const other=parent.slice();other[12]=20;subject.updateWorldMatrix(other,7);assert.equal(subject.worldMatrix[12],21);assert.equal(subject.worldVersion,first+1);
  subject.updateWorldMatrix(other,7);assert.equal(subject.worldVersion,first+1);
  subject.updateWorldMatrix();const detached=subject.worldVersion;assert.equal(subject.worldMatrix[12],1);subject.updateWorldMatrix();assert.equal(subject.worldVersion,detached);
 });
}
test('spatial candidates refit a mesh when it moves between equal-version parents',()=>{
 const world=new World(),a=new Entity('A').add(new Transform3D().setTranslation(10,0,0)),b=new Entity('B').add(new Transform3D().setTranslation(20,0,0));
 const geometry=new Geometry3D({positions:new Float32Array([-.5,-.5,0,.5,-.5,0,0,.5,0])});
 const child=new Entity('mesh').add(new Transform3D().setTranslation(1,0,0)).add(new Mesh3D(geometry,new BasicMaterial()));a.addChild(child);world.add(a).add(b);
 const frame=world.frameData.begin(world,null,0,0);const spatial=getSpatialIndexService(world);spatial.syncMeshIndex();frame.transforms.getWorldMatrix(b);
 b.addChild(child);frame.begin(world,null,1,16);const index=spatial.syncMeshIndex(),old=new Set(),next=new Set();index.queryPoint(11,0,0,old);index.queryPoint(21,0,0,next);
 assert.equal(old.size,0);assert.deepEqual([...next].map(e=>e.entity),[child]);world.destroy();
});
