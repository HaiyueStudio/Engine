// haiyue:builtin-render gui-text
// source: shader-language/builtin-engine-2d-ui-family.json

struct GuiPaint {a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>,e:vec4<f32>,f:vec4<f32>}
@group(0) @binding(1) var<storage,read> gui_paint:array<GuiPaint>;
fn gui_distance(p:vec2<f32>,r:vec4<f32>,corners:vec4<f32>)->f32{
 let h=r.zw*0.5;let v=p-r.xy-h;
 let radius=min(select(select(corners.x,corners.y,v.x>0.0),select(corners.w,corners.z,v.x>0.0),v.y>0.0),min(h.x,h.y));
 let q=abs(v)-h+radius;return length(max(q,vec2<f32>(0.0)))+min(max(q.x,q.y),0.0)-radius;
}
fn gui_clip(p:vec2<f32>,clip:vec4<f32>,aa:f32)->f32{
 if(clip.w>=0.0){return select(0.0,1.0,all(p>=clip.xy)&&all(p<=clip.zw));}
 var id=u32(-clip.w);var coverage=1.0;
 for(var n=0u;n<129u&&id!=0u;n++){let c=gui_paint[id];coverage=min(coverage,1.0-smoothstep(-aa,aa,gui_distance(p,c.a,c.b)));id=u32(c.c.x);}
 return select(coverage,0.0,id!=0u);
}

override GUI_LINEAR_OUTPUT: bool = false;
fn gui_to_linear(c:vec3<f32>)->vec3<f32>{return select(c/12.92,pow((c+0.055)/1.055,vec3<f32>(2.4)),c>vec3<f32>(0.04045));}

struct Viewport {
  size : vec2<f32>,
  _pad : vec2<f32>,
}

@group(0) @binding(0) var<uniform> viewport : Viewport;
@group(1) @binding(0) var fontTex : texture_2d<f32>;
@group(1) @binding(1) var fontSampler : sampler;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) color : vec4<f32>,
  @location(3) clip : vec4<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) screenPos : vec2<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) color : vec4<f32>,
  @location(3) clip : vec4<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  let clipX = (input.position.x - viewport._pad.x) / viewport.size.x * 2.0 - 1.0;
  let clipY = 1.0 - (input.position.y - viewport._pad.y) / viewport.size.y * 2.0;
  out.clipPos = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.screenPos = input.position;
  out.uv = input.uv;
  out.color = vec4<f32>(select(input.color.rgb,gui_to_linear(input.color.rgb),GUI_LINEAR_OUTPUT),input.color.a);
  out.clip = input.clip;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let aa=max(0.5,length(fwidth(input.screenPos))*0.5);
  let clipAlpha=gui_clip(input.screenPos,input.clip,aa);
  if(clipAlpha<=0.001){discard;}
  let sample = textureSample(fontTex, fontSampler, input.uv);
  let alpha = sample.a * input.color.a;
  if (alpha <= 0.01) {
    discard;
  }
  let rgb = select(sample.rgb, gui_to_linear(sample.rgb), GUI_LINEAR_OUTPUT);
  // Negative tint marks a color glyph; ordinary/legacy atlases remain alpha masks.
  let result=vec4<f32>(select(input.color.rgb, rgb, input.color.r < 0.0), alpha);
  return vec4<f32>(result.rgb,result.a*clipAlpha);
}
