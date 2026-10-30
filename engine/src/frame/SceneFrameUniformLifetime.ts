import {getSceneFrameUniformSnapshotMetadata,type SceneFrameUniformSnapshot} from './SceneFrameUniformLayout';

interface StreamLifetime {retired:boolean;readonly listeners:Set<()=>void>;}
const owners=new WeakMap<object,Set<object>>(),lifetimes=new WeakMap<object,StreamLifetime>();

/** Private CPU snapshot ownership; the shader/uniform ABI stays unchanged. */
export function trackSceneFrameUniformOwner(owner:object,snapshot:SceneFrameUniformSnapshot):void {
  const stream=getSceneFrameUniformSnapshotMetadata(snapshot)?.stream??snapshot;
  let streams=owners.get(owner);if(!streams){streams=new Set();owners.set(owner,streams);}
  streams.add(stream);
}
export function retireSceneFrameUniformOwner(owner:object):void {
  const streams=owners.get(owner);if(!streams)return;owners.delete(owner);
  for(const stream of streams){const state=lifetime(stream);if(state.retired)continue;state.retired=true;for(const callback of state.listeners)callback();state.listeners.clear();}
}
export function isSceneFrameUniformStreamRetired(stream:object):boolean {return lifetimes.get(stream)?.retired===true;}
export function onSceneFrameUniformStreamRetired(stream:object,callback:()=>void):()=>void {
  const state=lifetime(stream);if(state.retired){callback();return()=>{};}state.listeners.add(callback);return()=>state.listeners.delete(callback);
}
function lifetime(stream:object):StreamLifetime {
  let state=lifetimes.get(stream);if(!state){state={retired:false,listeners:new Set()};lifetimes.set(stream,state);}return state;
}
