struct LodParams {
  planes: array<vec4f,6>,
  view: mat4x4f,
  // projection pixel scale, perspective flag, near threshold, middle threshold
  screen: vec4f,
  // hysteresis, unused
  tuning: vec4f,
  sphere: vec4f,
  // count, capacity, aligned visibility stride in words, unused
  dispatchInfo: vec4u,
}
@group(0) @binding(0) var<storage,read> transforms: array<mat4x4f>;
@group(0) @binding(1) var<storage,read_write> visible: array<u32>;
@group(0) @binding(2) var<storage,read_write> counts: array<atomic<u32>>;
@group(0) @binding(3) var<storage,read_write> levels: array<u32>;
@group(0) @binding(4) var<uniform> params: LodParams;
@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid:vec3u) {
  let id=gid.x;
  if(id>=params.dispatchInfo.x){return;}
  let model=transforms[id];
  let center=(model*vec4f(params.sphere.xyz,1)).xyz;
  // Frobenius norm is a conservative bound even for sheared transforms.
  let radius=params.sphere.w*sqrt(dot(model[0].xyz,model[0].xyz)+dot(model[1].xyz,model[1].xyz)+dot(model[2].xyz,model[2].xyz));
  for(var p=0u;p<6u;p++) {if(dot(params.planes[p].xyz,center)+params.planes[p].w < -radius*length(params.planes[p].xyz)){return;}}
  let distance=max(.0001,-(params.view*vec4f(center,1)).z-radius);
  let height=2*radius*params.screen.x/select(1.0,distance,params.screen.y>.5);
  var level=select(2u,1u,height>=params.screen.w);
  if(height>=params.screen.z){level=0u;}
  let previous=levels[id];let h=params.tuning.x;
  if(previous<3u) {
    level=previous;
    for(var step=0u;step<2u;step++) {
      if(level>0u) {
        let threshold=select(params.screen.w,params.screen.z,level==1u);
        if(height>=threshold*(1+h)){level-=1u;continue;}
      }
      if(level<2u) {
        let threshold=select(params.screen.w,params.screen.z,level==0u);
        if(height<threshold*(1-h)){level+=1u;continue;}
      }
      break;
    }
  }
  levels[id]=level;
  let slot=atomicAdd(&counts[level],1u);
  if(slot<params.dispatchInfo.y){visible[level*params.dispatchInfo.z+slot]=id;}
}
