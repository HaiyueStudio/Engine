import assert from 'node:assert/strict';
import test from 'node:test';
import { LIGHT_COUNTS, makeLights, lightPosition, parseCount, parsePath } from '../examples/deferred-lighting/model.ts';
test('count/path input cannot silently request unsupported populations', () => {
 for (const count of LIGHT_COUNTS) assert.equal(parseCount(String(count)), count);
 for (const value of [null, '', '-1', 'NaN', '1000000', '8.5']) assert.equal(parseCount(value), 128);
 assert.equal(parsePath('forward'), 'forward'); assert.equal(parsePath('reference'), 'reference'); assert.equal(parsePath('unknown'), 'tiled');
});
test('light motion preserves deterministic positions at pause/reset and finite bounds', () => {
 const first=makeLights(),second=makeLights();assert.deepEqual(first,second);assert.equal(first.length,1024);
 for(const light of first){assert.deepEqual(lightPosition(light.position,light.phase,0,false),lightPosition(light.position,light.phase,0,false));
  for(const overlap of [false,true])for(const time of [0,1,100]){const p=lightPosition(light.position,light.phase,time,overlap);assert.ok(p.every(Number.isFinite));assert.ok(Math.abs(p[0])<=10.5);assert.ok(p[1]>=.5&&p[1]<=4.6);}}
 assert.notDeepEqual(lightPosition(first[0].position,first[0].phase,0,false),lightPosition(first[0].position,first[0].phase,1,false));
});
