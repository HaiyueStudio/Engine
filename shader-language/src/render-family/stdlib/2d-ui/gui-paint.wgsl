
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
