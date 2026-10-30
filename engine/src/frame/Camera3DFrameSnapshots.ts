import type {Camera3DFrameData} from './FrameData';
import type {RenderCommandContext} from '../core/RenderCommandContext';
import {Frustum} from '../culling/Frustum';
import {retireSceneFrameUniformOwner,trackSceneFrameUniformOwner} from './SceneFrameUniformLifetime';
import {getSceneFrameUniformSnapshot,type SceneFrameUniformSnapshot} from './SceneFrameUniformLayout';
import type {Fog} from '../lighting/Fog';

interface Slot {readonly data:Camera3DFrameData;busy:boolean;sourcePhase:number;}
interface Pool {slots:Slot[];lastSeen:number;}
interface Recording {readonly slots:Slot[];readonly keys:Set<string>;readonly managed:boolean;released:boolean;}

/** FrameData cameras are borrowed mutable scratch. Planned views own copies until
 * submission/cancellation; synchronous legacy recordings release after encoding.
 * Reuse is per view, so arena stream identities remain stable in steady state. */
export class Camera3DFrameSnapshots {
  private readonly pools=new Map<string,Pool>();
  private readonly pending=new Set<Recording>();
  private active:Recording|undefined;
  private epoch=0;
  uniforms(data:Camera3DFrameData,fog:Fog|null):SceneFrameUniformSnapshot {
    const snapshot=getSceneFrameUniformSnapshot(data,fog);trackSceneFrameUniformOwner(data,snapshot);return snapshot;
  }

  begin(context:RenderCommandContext,reconcileFamily=context.viewFamily!==undefined):(failed?:boolean)=>void {
    if(this.active)throw Error('Camera frame planning is not reentrant.');
    const epoch=++this.epoch;
    const recording:Recording={slots:[],keys:new Set(),managed:!!context.afterSubmit&&!!context.afterCancel,released:false};
    this.active=recording;
    if(recording.managed){
      this.pending.add(recording);
      try{context.afterSubmit!(()=>this.release(recording));context.afterCancel!(()=>this.release(recording));}
      catch(error){this.release(recording);this.active=undefined;throw error;}
    }
    return failed=>{
      if(this.active===recording)this.active=undefined;
      // A complete family can remove absent members. A single-view call does
      // not prove that another independently recorded view has disappeared.
      for(const [key,pool]of this.pools)if(!recording.keys.has(key)&&(reconcileFamily||epoch-pool.lastSeen>120))this.remove(key,pool);
      // Soft idle capacity, not a limit on active views or pending recordings.
      const idle=[...this.pools].filter(([key])=>!recording.keys.has(key)).sort((a,b)=>a[1].lastSeen-b[1].lastSeen);
      for(const [key,pool]of idle){if(this.pools.size<=Math.max(32,recording.keys.size))break;this.remove(key,pool);}
      if(!recording.managed||failed||recording.slots.length===0)this.release(recording);
    };
  }

  capture(key:string,source:Camera3DFrameData):Camera3DFrameData {
    const recording=this.active;
    if(!recording||recording.released)throw Error('Camera snapshot requires an active recording.');
    let pool=this.pools.get(key);
    if(!pool){pool={slots:[],lastSeen:this.epoch};this.pools.set(key,pool);}pool.lastSeen=this.epoch;
    let slot=pool.slots.find(candidate=>!candidate.busy);
    // A new shape owns a new stream. Retiring the old CPU owner prevents an
    // append-only list of dimension variants in the device arena.
    if(slot&&(slot.data.width!==source.width||slot.data.height!==source.height||slot.data.reverseZ!==source.reverseZ)){
      pool.slots.splice(pool.slots.indexOf(slot),1);retireSceneFrameUniformOwner(slot.data);slot=undefined;
    }
    if(!slot){slot={data:createFrame(source),busy:false,sourcePhase:-1};pool.slots.push(slot);}
    slot.busy=true;recording.slots.push(slot);recording.keys.add(key);
    const data=slot.data;
    if(slot.sourcePhase!==source.phaseRevision||data.frameId!==source.frameId||!sameFrame(data,source)){
      data.entity=source.entity;data.camera=source.camera;
      data.width=source.width;data.height=source.height;data.reverseZ=source.reverseZ;data.frameId=source.frameId;
      data.phaseRevision=data.phaseRevision===0xffffffff?1:data.phaseRevision+1;
      data.projectionMatrix.set(source.projectionMatrix);data.viewMatrix.set(source.viewMatrix);
      data.viewProjectionMatrix.set(source.viewProjectionMatrix);data.inverseViewProjectionMatrix.set(source.inverseViewProjectionMatrix);
      data.worldMatrix.set(source.worldMatrix);data.position.set(source.position);data.projectionJitter.set(source.projectionJitter);
      data.frustum.setFromViewProjection(data.viewProjectionMatrix);data.frustumPlanes.set(source.frustumPlanes);
      slot.sourcePhase=source.phaseRevision;
    }
    return data;
  }

  private release(recording:Recording):void {
    if(recording.released)return;recording.released=true;
    for(const slot of recording.slots)slot.busy=false;
    recording.slots.length=0;this.pending.delete(recording);
    // Retain one reusable CPU frame per live view after an in-flight burst.
    for(const pool of this.pools.values()){let spare=false;pool.slots=pool.slots.filter(slot=>{if(slot.busy||(!spare&&(spare=true)))return true;retireSceneFrameUniformOwner(slot.data);return false;});}
  }
  private remove(key:string,pool:Pool):void {this.pools.delete(key);for(const slot of pool.slots)retireSceneFrameUniformOwner(slot.data);}
  clear():void {
    for(const pool of this.pools.values())for(const slot of pool.slots)retireSceneFrameUniformOwner(slot.data);
    for(const recording of this.pending)for(const slot of recording.slots)retireSceneFrameUniformOwner(slot.data);
    for(const recording of this.pending)this.release(recording);
    if(this.active)this.release(this.active);
    this.active=undefined;this.pools.clear();
  }
  get stats():Readonly<{views:number;slots:number;pendingRecordings:number}> {
    const slots=new Set([...this.pools.values()].flatMap(pool=>pool.slots));
    for(const recording of this.pending)for(const slot of recording.slots)slots.add(slot);
    return{views:this.pools.size,slots:slots.size,pendingRecordings:this.pending.size};
  }
}

function createFrame(source:Camera3DFrameData):Camera3DFrameData {
  return{...source,projectionMatrix:new Float32Array(16),viewMatrix:new Float32Array(16),viewProjectionMatrix:new Float32Array(16),inverseViewProjectionMatrix:new Float32Array(16),worldMatrix:new Float32Array(16),position:new Float32Array(3),projectionJitter:new Float32Array(2),frustum:new Frustum(),frustumPlanes:new Float32Array(24),phaseRevision:0};
}
function sameFrame(a:Camera3DFrameData,b:Camera3DFrameData):boolean {
  if(a.entity!==b.entity||a.camera!==b.camera||a.width!==b.width||a.height!==b.height||a.reverseZ!==b.reverseZ)return false;
  for(const key of ['projectionMatrix','viewMatrix','viewProjectionMatrix','inverseViewProjectionMatrix','worldMatrix','position','projectionJitter','frustumPlanes'] as const){
    const x=a[key],y=b[key];for(let i=0;i<x.length;i++)if(x[i]!==y[i])return false;
  }
  return true;
}
