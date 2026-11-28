// haiyue:builtin-render gui-shape
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

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) rect : vec4<f32>,
  @location(3) radius : f32,
  @location(4) clip : vec4<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) screenPos : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) rect : vec4<f32>,
  @location(3) radius : f32,
  @location(4) clip : vec4<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  let clipX = (input.position.x - viewport._pad.x) / viewport.size.x * 2.0 - 1.0;
  let clipY = 1.0 - (input.position.y - viewport._pad.y) / viewport.size.y * 2.0;
  out.clipPos = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.screenPos = input.position;
  out.color = vec4<f32>(select(input.color.rgb,gui_to_linear(input.color.rgb),GUI_LINEAR_OUTPUT),input.color.a);
  out.rect = input.rect;
  out.radius = input.radius;
  out.clip = input.clip;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let aa=max(0.5,length(fwidth(input.screenPos))*0.5);
  let clipAlpha=gui_clip(input.screenPos,input.clip,aa);
  if(clipAlpha<=0.001){discard;}
  if(input.radius<0.0){
    let a=gui_paint[u32(-input.radius)];let v0=input.screenPos-input.rect.xy-input.rect.zw*0.5;let p=input.rect.xy+input.rect.zw*0.5+vec2<f32>(dot(v0,a.f.zw),dot(v0,vec2<f32>(-a.f.w,a.f.z)));
    let d=gui_distance(p,input.rect,a.a);let edge=1.0-smoothstep(-aa,aa,d);
    var coverage=edge;
    if(a.c.y>0.0){coverage=1.0-smoothstep(-a.c.y,a.c.y,d);}
    var color=input.color;
    if(any(a.e.xy!=vec2<f32>(0.0))){let end=vec4<f32>(select(a.d.rgb,gui_to_linear(a.d.rgb),GUI_LINEAR_OUTPUT),a.d.a);color=mix(color,end,clamp(dot(p-a.e.zw,a.e.xy)+0.5,0.0,1.0));}
    if(a.c.x>0.0){let border=vec4<f32>(select(a.b.rgb,gui_to_linear(a.b.rgb),GUI_LINEAR_OUTPUT),a.b.a);color=mix(color,border,smoothstep(-a.c.x-aa,-a.c.x+aa,d));}
    if(a.f.y>0.0){let v=p-input.rect.xy-input.rect.zw*0.5;let angle=atan2(v.y,v.x);let tau=6.283185307;let sweep=clamp(a.c.w-a.c.z,0.0,tau);let offset=(angle-a.c.z+tau*4.0)%tau;coverage*=select(0.0,1.0,offset<=sweep);coverage*=smoothstep(-a.f.x-aa,-a.f.x+aa,d);}
    return vec4<f32>(color.rgb,color.a*coverage*clipAlpha);
  }
  let halfSize = input.rect.zw * 0.5;
  let center = input.rect.xy + halfSize;
  let radius = min(input.radius, min(halfSize.x, halfSize.y));
  let q = abs(input.screenPos - center) - (halfSize - vec2<f32>(radius, radius));
  let d = length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
  let alpha = 1.0 - smoothstep(0.0, 1.0, d);
  if (alpha <= 0.001) {
    discard;
  }
  return vec4<f32>(input.color.rgb, input.color.a * alpha * clipAlpha);
}
