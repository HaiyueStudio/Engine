import {Geometry2D} from '@haiyue/engine/geometry';
import {AnimationVisual2D} from '../../AnimationVisual2D.js';
import {identityLayoutTransform} from './ProductionLayoutGeometry.js';

/** Preserve painter order: only adjacent, equally painted, untextured solids join.
 * Masks, images, gradients, effects and non-axis-aligned transforms keep their
 * original renderer path. No shader, sampler or source evaluation is replaced.
 */
export function batchProductionDrawVisuals(values: readonly AnimationVisual2D[], availableBytes: number): Readonly<{visuals: readonly AnimationVisual2D[]; additionalBytes: number}> {
  const visuals: AnimationVisual2D[]=[];let group:AnimationVisual2D[]=[],vertices=0,signature='',additionalBytes=0;
  const eligible=(v:AnimationVisual2D):boolean=>{const m=v.localTransform??identityLayoutTransform;return !v.sourceOnly&&!v.requiresTexture&&!v.texture&&!v.textureHandle&&!v.textMaterial&&!v.uvs&&!v.gradient&&!v.effects.length&&!v.culling&&v.blendMode==='normal'&&m[0]>0&&m[3]>0&&m[1]===0&&m[2]===0;};
  const key=(v:AnimationVisual2D):string=>JSON.stringify([v.instanceId,v.color,v.multiplyColor,v.screenColor,v.textureAlphaMode,v.uvRect,v.compositeLayers]);
  const flush=():void=>{
    if(group.length<2){visuals.push(...group);group=[];vertices=0;return;}
    const indexCount=group.reduce((sum,v)=>sum+(v.geometry.indices?.length??v.geometry.vertexCount),0),bytes=vertices*16+indexCount*2;
    // A tight original staging guard takes the original unbatched path.
    if(additionalBytes+bytes>availableBytes){visuals.push(...group);group=[];vertices=0;return;}
    const positions=new Float32Array(vertices*2),indices=new Uint16Array(indexCount);let vertex=0,index=0,finite=true;
    for(const value of group){const {geometry}=value,m=value.localTransform??identityLayoutTransform;
      for(let at=0;at<geometry.positions.length;at+=2){positions[(vertex*2)+at]=m[0]*geometry.positions[at]!+m[4];positions[(vertex*2)+at+1]=m[3]*geometry.positions[at+1]!+m[5];finite&&=Number.isFinite(positions[vertex*2+at])&&Number.isFinite(positions[vertex*2+at+1]);}
      const count=geometry.indices?.length??geometry.vertexCount;for(let at=0;at<count;at++)indices[index++]=vertex+(geometry.indices?.[at]??at);vertex+=geometry.vertexCount;
    }
    if(!finite){visuals.push(...group);group=[];vertices=0;return;}
    const first=group[0]!;
    visuals.push(new AnimationVisual2D({geometry:new Geometry2D(positions,indices),instanceId:first.instanceId,nodeId:'$batch:'+JSON.stringify(group.map(v=>v.nodeId)),order:first.order,color:first.color,multiplyColor:first.multiplyColor,screenColor:first.screenColor,textureAlphaMode:first.textureAlphaMode,uvRect:first.uvRect,composite:{layers:first.compositeLayers.map(layer=>({...layer}))},localTransform:identityLayoutTransform}));
    additionalBytes+=bytes;group=[];vertices=0;
  };
  for(const value of values){if(!eligible(value)){flush();visuals.push(value);continue;}const next=key(value);if(group.length&&(next!==signature||vertices+value.geometry.vertexCount>65535))flush();if(value.geometry.vertexCount>65535){visuals.push(value);continue;}signature=next;group.push(value);vertices+=value.geometry.vertexCount;}flush();
  return Object.freeze({visuals:Object.freeze(visuals),additionalBytes});
}
