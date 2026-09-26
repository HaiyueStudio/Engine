import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeferredRoomFixture, DEFERRED_ROOM_PALETTE } from './deferred-room-fixture.mjs';
test('frozen room seed, palette, material and full-resolution view work remain deterministic',()=>{
 const room=createDeferredRoomFixture({moving:false,count:1,views:4});
 assert.deepEqual(room.lights[0],{index:0,position:[-4.9622683227062225,5.264943102840334,-6.3794487016275525],color:[.2,.8,.3],intensity:2,range:2,phase:1.5825201669113245});
 assert.equal(room.boxes.length,256);assert.deepEqual(room.boxes[0].position,[-11.25,.5,-11.25]);assert.deepEqual(room.boxes[255].position,[11.25,.5,11.25]);
 assert.deepEqual(room.materials.map(m=>m.color),DEFERRED_ROOM_PALETTE);
 assert.ok(room.materials.every((m,i)=>m.metallic===i%2&&m.roughness===.1+.1*i));
 assert.deepEqual(room.cameras[0].position,[18,6,0]);assert.ok(room.cameras.every(c=>c.width===1280&&c.height===720));
});
test('sparse/overlap and static/moving variants preserve the same authored lights',()=>{
 const original=createDeferredRoomFixture({count:1024,moving:false}),moved=createDeferredRoomFixture({count:1024,frame:37,overlap:true});
 for(let i=0;i<1024;i++){const a=original.lights[i],b=moved.lights[i];assert.equal(b.range,40);assert.equal(a.position[1],b.position[1]);assert.deepEqual(a.color,b.color);assert.equal(b.position[0],a.position[0]+Math.sin(37/60+a.phase));assert.equal(b.position[2],a.position[2]+Math.cos(37/60+a.phase));}
 assert.throws(()=>createDeferredRoomFixture({count:1025}));assert.throws(()=>createDeferredRoomFixture({frame:-1}));
});
