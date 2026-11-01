import test from'node:test';import assert from'node:assert/strict';
import{Tilemap2DComponent,createTilemapPlugin}from'../dist/tilemap.js';
test('palette serialization and generated runtime restoration preserve explicit chunks and transforms',()=>{
 let contribution;createTilemapPlugin().installEditor({registerContribution(value){contribution=value.components[0];}});
 const legacy=new Tilemap2DComponent({columns:2,rows:2,cells:[1,0,2,1]});
 const old=contribution.serialize(legacy);assert.equal('cellTransforms'in old,false);assert.equal('chunkSize'in old,false);
 assert.deepEqual(contribution.serialize(contribution.deserialize(old)),old);
 const map=new Tilemap2DComponent({columns:2,rows:2,cells:[1,0,2,1],chunkSize:1,maxResidentChunks:2});map.setCellTransform(1,1,'rotate-90');
 const data=contribution.serialize(map),restored=contribution.deserialize(data);
 assert.equal(restored.getCellTransform(1,1),'rotate-90');assert.deepEqual(contribution.serialize(restored),data);
 const runtime=Function('data','Tilemap2DComponent','return '+contribution.runtimeExport.deserializeExpression)(data,Tilemap2DComponent);
 assert.deepEqual(contribution.serialize(runtime),data);
 map.setAtlas({source:{texture:{createView(){return{};}}},sourceWidth:8,sourceHeight:4,tileWidth:4,tileHeight:4});
 assert.throws(()=>contribution.serialize(map),e=>e.code==='E_ASSET_INVALID_DATA');
});
