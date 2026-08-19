struct CompositeParams { image: vec4u, flags: vec4u }
@group(0) @binding(0) var<uniform> params: CompositeParams;
@group(0) @binding(1) var sceneColor: texture_2d<f32>;
@group(0) @binding(2) var shadowEffect: texture_2d<f32>;
@group(0) @binding(3) var reflectionEffect: texture_2d<f32>;
@group(0) @binding(4) var aoEffect: texture_2d<f32>;
@group(0) @binding(5) var output: texture_storage_2d<rgba8unorm,write>;
fn sample_scaled(t:texture_2d<f32>,p:vec2u)->vec4f{let d=vec2u(textureDimensions(t));let c=vec2i(min(d-vec2u(1u),vec2u((vec2f(p)+0.5)*vec2f(d)/vec2f(params.image.xy))));return textureLoad(t,c,0);}
fn to_linear(v:vec3f)->vec3f{return select(v,pow(max(v,vec3f(0.0)),vec3f(2.2)),params.flags.y==1u);}fn from_linear(v:vec3f)->vec3f{return select(v,pow(max(v,vec3f(0.0)),vec3f(1.0/2.2)),params.flags.y==1u);}
@compute @workgroup_size(8,8,1) fn composite_main(@builtin(global_invocation_id) gid:vec3u){if(any(gid.xy>=params.image.xy)){return;}let p=gid.xy;var base=textureLoad(sceneColor,vec2i(p),0);let shadow=sample_scaled(shadowEffect,p);let reflection=sample_scaled(reflectionEffect,p);let ao=sample_scaled(aoEffect,p);var value=vec4f(from_linear(to_linear(base.rgb)*shadow.rgb*ao.rgb),base.a);value=vec4f(from_linear(clamp(mix(to_linear(value.rgb),reflection.rgb,reflection.a),vec3f(0.0),vec3f(1.0))),value.a);if(params.flags.x==1u){value=shadow;}else if(params.flags.x==2u){value=vec4f(from_linear(reflection.rgb),reflection.a);}else if(params.flags.x==3u){value=ao;}textureStore(output,vec2i(p),value);}
