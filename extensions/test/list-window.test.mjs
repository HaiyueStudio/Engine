import test from 'node:test';import assert from 'node:assert/strict';
import {collectionWindow} from '../src/collections/window.ts';
test('shared numeric range preserves HYA negative/positive overscroll exactly; carousel remains caller-owned',()=>{
 for(const count of [0,1,1000,10000])for(const offset of [-10000,-1,0,.25,28,280,2801,1e7])for(const extent of [0,28,560])for(const overscan of [0,1,2,32]){
   assert.deepEqual(collectionWindow(count,offset,extent,28,overscan),{first:Math.max(0,Math.floor(offset/28)-overscan),last:Math.min(count,Math.ceil((offset+extent)/28)+overscan)});
 }
});
