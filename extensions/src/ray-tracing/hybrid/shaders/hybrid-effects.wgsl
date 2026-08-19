// G07 hybrid ray effects. Artifact V2 owns the complete bind-group layout.
const LEAF_BIT: u32 = 0x80000000u;
const INDEX_MASK: u32 = 0x7fffffffu;
const MISSING: u32 = 0xffffffffu;
const MAX_DISTANCE: f32 = 3.402823466e+38;

struct Params {
  image: vec4u, scene: vec4u, fullImage: vec4u,
  cameraOrigin: vec4f, lightDirection: vec4f, environment: vec4f,
  effect: vec4f, inverseViewProjection: mat4x4f, viewProjection: mat4x4f,
}
struct Diagnostics {
  rays: atomic<u32>, tlasNodes: atomic<u32>, blasNodes: atomic<u32>, primitives: atomic<u32>,
  hits: atomic<u32>, misses: atomic<u32>, transparentSkips: atomic<u32>, stackOverflows: atomic<u32>, invalidAccesses: atomic<u32>, reserved0: atomic<u32>, reserved1: atomic<u32>, reserved2: atomic<u32>,
}
struct Candidate { hit: u32, t: f32, position: vec3f, normal: vec3f }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> blasNodes: array<u32>;
@group(0) @binding(2) var<storage, read> blasTable: array<u32>;
@group(0) @binding(3) var<storage, read> tlasNodes: array<u32>;
@group(0) @binding(4) var<storage, read> primitives: array<u32>;
@group(0) @binding(5) var<storage, read> instances: array<u32>;
@group(0) @binding(6) var rasterDepth: texture_depth_2d;
@group(0) @binding(7) var rasterNormal: texture_2d<f32>;
@group(0) @binding(8) var rasterMaterial: texture_2d<f32>;
@group(0) @binding(9) var rasterSceneColor: texture_2d<f32>;
@group(0) @binding(10) var previousEffect: texture_2d<f32>;
@group(0) @binding(11) var<storage, read_write> diagnostics: Diagnostics;
@group(0) @binding(12) var effectOutput: texture_storage_2d<rgba16float, write>;

fn instance_f32(index: u32, word: u32) -> f32 { return bitcast<f32>(instances[index * 36u + word]); }
fn transform_point(index: u32, value: vec3f, inverse: bool) -> vec3f {
  let b = select(0u, 16u, inverse);
  let r = vec4f(instance_f32(index,b)*value.x+instance_f32(index,b+4u)*value.y+instance_f32(index,b+8u)*value.z+instance_f32(index,b+12u), instance_f32(index,b+1u)*value.x+instance_f32(index,b+5u)*value.y+instance_f32(index,b+9u)*value.z+instance_f32(index,b+13u), instance_f32(index,b+2u)*value.x+instance_f32(index,b+6u)*value.y+instance_f32(index,b+10u)*value.z+instance_f32(index,b+14u), instance_f32(index,b+3u)*value.x+instance_f32(index,b+7u)*value.y+instance_f32(index,b+11u)*value.z+instance_f32(index,b+15u));
  return r.xyz / select(r.w, 1.0, r.w == 0.0);
}
fn transform_vector(index: u32, value: vec3f, inverse: bool) -> vec3f {
  let b = select(0u,16u,inverse); return vec3f(instance_f32(index,b)*value.x+instance_f32(index,b+4u)*value.y+instance_f32(index,b+8u)*value.z, instance_f32(index,b+1u)*value.x+instance_f32(index,b+5u)*value.y+instance_f32(index,b+9u)*value.z, instance_f32(index,b+2u)*value.x+instance_f32(index,b+6u)*value.y+instance_f32(index,b+10u)*value.z);
}
fn transform_normal(index: u32, value: vec3f) -> vec3f { return normalize(vec3f(instance_f32(index,16u)*value.x+instance_f32(index,17u)*value.y+instance_f32(index,18u)*value.z, instance_f32(index,20u)*value.x+instance_f32(index,21u)*value.y+instance_f32(index,22u)*value.z, instance_f32(index,24u)*value.x+instance_f32(index,25u)*value.y+instance_f32(index,26u)*value.z)); }
fn bounds_hit(nodes: ptr<storage,array<u32>,read>, index: u32, o: vec3f, d: vec3f, tmin: f32, tmax: f32) -> bool {
  let b=index*8u; var lo=tmin; var hi=tmax;
  for(var a=0u;a<3u;a++){ let c=d[a]; let mn=bitcast<f32>((*nodes)[b+a]); let mx=bitcast<f32>((*nodes)[b+4u+a]); if(abs(c)<=1e-20){if(o[a]<mn||o[a]>mx){return false;}}else{let inv=1.0/c; let x=(mn-o[a])*inv; let y=(mx-o[a])*inv; lo=max(lo,min(x,y)); hi=min(hi,max(x,y)); if(lo>hi){return false;}} }
  return true;
}
fn empty() -> Candidate { return Candidate(0u,MAX_DISTANCE,vec3f(0.0),vec3f(0.0)); }
fn primitive_hit(pi:u32,ii:u32,o:vec3f,d:vec3f,tmin:f32,tmax:f32)->Candidate{
  let b=pi*16u; let kind=primitives[b+12u];
  if(kind==0u){ let p0=transform_point(ii,vec3f(bitcast<f32>(primitives[b]),bitcast<f32>(primitives[b+1u]),bitcast<f32>(primitives[b+2u])),false); let p1=transform_point(ii,vec3f(bitcast<f32>(primitives[b+3u]),bitcast<f32>(primitives[b+4u]),bitcast<f32>(primitives[b+5u])),false); let p2=transform_point(ii,vec3f(bitcast<f32>(primitives[b+6u]),bitcast<f32>(primitives[b+7u]),bitcast<f32>(primitives[b+8u])),false); let e1=p1-p0; let e2=p2-p0; let pv=cross(d,e2); let det=dot(e1,pv); if(abs(det)<=1e-12){return empty();} let inv=1.0/det; let tv=o-p0; let u=dot(tv,pv)*inv; let q=cross(tv,e1); let v=dot(d,q)*inv; let t=dot(e2,q)*inv; if(u<0.0||v<0.0||u+v>1.0||t<tmin||t>tmax){return empty();} return Candidate(1u,t,o+d*t,normalize(cross(e1,e2))); }
  if(kind==1u){ let lo=transform_point(ii,o,true); let ld=transform_vector(ii,d,true); let c=vec3f(bitcast<f32>(primitives[b]),bitcast<f32>(primitives[b+1u]),bitcast<f32>(primitives[b+2u])); let r=bitcast<f32>(primitives[b+3u]); let oc=lo-c; let a=dot(ld,ld); let hb=dot(oc,ld); let disc=hb*hb-a*(dot(oc,oc)-r*r); if(disc<0.0||a<=1e-12){return empty();} var t=(-hb-sqrt(disc))/a; if(t<tmin||t>tmax){t=(-hb+sqrt(disc))/a;if(t<tmin||t>tmax){return empty();}} return Candidate(1u,t,o+d*t,transform_normal(ii,normalize(lo+ld*t-c))); }
  return empty();
}
fn trace(o:vec3f,d:vec3f,tmin:f32,tmax:f32,anyHit:bool)->Candidate{
  atomicAdd(&diagnostics.rays,1u); if(params.scene.x==MISSING){atomicAdd(&diagnostics.misses,1u);return empty();}
  var ts:array<u32,64>; var tn=1u; ts[0]=params.scene.x; var best=empty();
  loop{if(tn==0u){break;}tn--;let ni=ts[tn];if(ni*8u+7u>=arrayLength(&tlasNodes)){atomicAdd(&diagnostics.invalidAccesses,1u);return empty();}atomicAdd(&diagnostics.tlasNodes,1u);if(!bounds_hit(&tlasNodes,ni,o,d,tmin,min(tmax,best.t))){continue;}let b=ni*8u;let first=tlasNodes[b+3u];let nodeMeta=tlasNodes[b+7u];if((nodeMeta&LEAF_BIT)==0u){if(tn+2u>64u){atomicAdd(&diagnostics.stackOverflows,1u);return empty();}ts[tn]=first;ts[tn+1u]=nodeMeta&INDEX_MASK;tn+=2u;continue;}for(var ii=first;ii<first+(nodeMeta&INDEX_MASK);ii++){if(ii>=params.scene.y||ii*36u+35u>=arrayLength(&instances)){atomicAdd(&diagnostics.invalidAccesses,1u);return empty();}let table=instances[ii*36u+32u];if(table*4u+3u>=arrayLength(&blasTable)){atomicAdd(&diagnostics.invalidAccesses,1u);return empty();}let root=blasTable[table*4u];if(root==MISSING){continue;}let lo=transform_point(ii,o,true);let ld=transform_vector(ii,d,true);var bs:array<u32,64>;var bn=1u;bs[0]=root;loop{if(bn==0u){break;}bn--;let bi=bs[bn];if(bi*8u+7u>=arrayLength(&blasNodes)){atomicAdd(&diagnostics.invalidAccesses,1u);return empty();}atomicAdd(&diagnostics.blasNodes,1u);if(!bounds_hit(&blasNodes,bi,lo,ld,tmin,min(tmax,best.t))){continue;}let bb=bi*8u;let pf=blasNodes[bb+3u];let bm=blasNodes[bb+7u];if((bm&LEAF_BIT)==0u){if(bn+2u>64u){atomicAdd(&diagnostics.stackOverflows,1u);return empty();}bs[bn]=pf;bs[bn+1u]=bm&INDEX_MASK;bn+=2u;continue;}for(var pi=pf;pi<pf+(bm&INDEX_MASK);pi++){if(pi*16u+15u>=arrayLength(&primitives)){atomicAdd(&diagnostics.invalidAccesses,1u);return empty();}atomicAdd(&diagnostics.primitives,1u);let h=primitive_hit(pi,ii,o,d,tmin,min(tmax,best.t));if(h.hit!=0u){best=h;if(anyHit){atomicAdd(&diagnostics.hits,1u);return best;}}}}}}
  if(best.hit!=0u){atomicAdd(&diagnostics.hits,1u);}else{atomicAdd(&diagnostics.misses,1u);}return best;
}
fn hash(v:u32)->f32{var x=v;x^=x>>16u;x*=0x7feb352du;x^=x>>15u;x*=0x846ca68bu;x^=x>>16u;return f32(x)/4294967296.0;}
fn raster_coord(p:vec2u)->vec2i{return vec2i(min(params.fullImage.xy-vec2u(1u),vec2u((vec2f(p)+0.5)*vec2f(params.fullImage.xy)/vec2f(params.image.xy))));}
fn world_position(c:vec2i,depth:f32)->vec3f{let uv=(vec2f(c)+0.5)/vec2f(params.fullImage.xy);let h=params.inverseViewProjection*vec4f(uv*2.0-1.0,depth,1.0);return h.xyz/h.w;}
fn scene_to_linear(value:vec3f)->vec3f{return select(value,pow(max(value,vec3f(0.0)),vec3f(2.2)),params.fullImage.z==1u);}
fn run_effect(gid:vec3u,effectId:u32){
  if(any(gid.xy>=params.image.xy)){return;}let p=gid.xy;let c=raster_coord(p);let depth=textureLoad(rasterDepth,c,0);let material=textureLoad(rasterMaterial,c,0);if(depth>=0.999999||material.b<0.999){if(material.b<0.999){atomicAdd(&diagnostics.transparentSkips,1u);}textureStore(effectOutput,vec2i(p),select(vec4f(0.0),vec4f(1.0),effectId!=1u));return;}let pos=world_position(c,depth);let nraw=textureLoad(rasterNormal,c,0).xyz*2.0-1.0;if(dot(nraw,nraw)<1e-8){textureStore(effectOutput,vec2i(p),select(vec4f(0.0),vec4f(1.0),effectId!=1u));return;}let n=normalize(nraw);var value=vec4f(1.0);var sum=vec4f(0.0);
  for(var s=0u;s<params.image.z;s++){let seed=(p.y*params.image.x+p.x)*4u+s+params.scene.w*1664525u;if(effectId==0u){let d=normalize(-params.lightDirection.xyz+vec3f(hash(seed)-0.5,hash(seed+1u)-0.5,hash(seed+2u)-0.5)*params.effect.w);let h=trace(pos+n*params.effect.x,d,params.effect.x,params.effect.y,true);sum+=vec4f(1.0-f32(h.hit)*params.effect.z);}else if(effectId==1u){let incident=normalize(pos-params.cameraOrigin.xyz);let rough=material.g; if(rough>params.effect.w){sum+=vec4f(0.0);continue;}let d=normalize(reflect(incident,n)+vec3f(hash(seed)-0.5,hash(seed+1u)-0.5,hash(seed+2u)-0.5)*rough);let h=trace(pos+n*params.effect.x,d,params.effect.x,params.effect.y,false);var color=params.environment.xyz;if(h.hit!=0u){let clip=params.viewProjection*vec4f(h.position,1.0);let uv=clip.xy/clip.w*0.5+0.5;if(all(uv>=vec2f(0.0))&&all(uv<=vec2f(1.0))){let hc=vec2i(min(params.fullImage.xy-vec2u(1u),vec2u(uv*vec2f(params.fullImage.xy))));color=scene_to_linear(textureLoad(rasterSceneColor,hc,0).rgb);}}let reflectivity=material.a*(1.0-rough/max(params.effect.w,1e-4))*params.effect.z;sum+=vec4f(color*reflectivity,reflectivity);}else{let u=hash(seed);let v=hash(seed+1u);let z=u;let r=sqrt(max(0.0,1.0-z*z));let a=v*6.283185307;let local=vec3f(r*cos(a),r*sin(a),z);let tangent=normalize(select(cross(n,vec3f(0.0,0.0,1.0)),cross(n,vec3f(0.0,1.0,0.0)),abs(n.z)>0.99));let bitangent=cross(n,tangent);let d=normalize(tangent*local.x+bitangent*local.y+n*local.z);let h=trace(pos+n*params.effect.x,d,params.effect.x,params.effect.y,true);sum+=vec4f(1.0-f32(h.hit)*params.effect.z);}}
  value=sum/f32(params.image.z);if(params.scene.z==0u){let old=textureLoad(previousEffect,vec2i(p),0);value=mix(value,old,params.environment.w);}textureStore(effectOutput,vec2i(p),value);
}
@compute @workgroup_size(8,8,1) fn shadow_main(@builtin(global_invocation_id) gid:vec3u){run_effect(gid,0u);}
@compute @workgroup_size(8,8,1) fn reflection_main(@builtin(global_invocation_id) gid:vec3u){run_effect(gid,1u);}
@compute @workgroup_size(8,8,1) fn ao_main(@builtin(global_invocation_id) gid:vec3u){run_effect(gid,2u);}
