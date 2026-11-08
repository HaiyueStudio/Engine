import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {observeAudition} from './audio-audition-test-support.mjs';

export function auditionContract(name,load,native=false){
 test(name+' isolates stereo audition from distance attenuation',async()=>{
  const values=await observeAudition(load(),native),[left,center,right,far]=values,distances=values.slice(0,3).map(v=>Math.hypot(...v.position));
  assert(distances[0]>0&&distances[0]<left.maxDistance,'Directional audition must be audible');
  assert(distances.every(d=>Math.abs(d-distances[0])<1e-10),'Left, center and right must have equal distance');
  assert(values.slice(0,3).every(v=>v.volume===center.volume&&v.maxDistance===center.maxDistance),'Stereo comparison must use the same source volume and distance model');
  assert.equal(center.position[0],0);assert(left.position[0]<0&&right.position[0]>0);
  assert(left.position[0]/left.maxDistance*left.panStrength<=-1,'Left audition must reach the left channel');
  assert(right.position[0]/right.maxDistance*right.panStrength>=1,'Right audition must reach the right channel');
  assert(Math.hypot(...far.position)>=far.maxDistance,'Far control must still reach the original silence cutoff');
 });
}
auditionContract('gameplay-kit',()=>readFileSync(new URL('./application.ts',import.meta.url),'utf8'));
