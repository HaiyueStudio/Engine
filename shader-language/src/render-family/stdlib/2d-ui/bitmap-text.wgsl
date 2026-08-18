
// Camera: viewProj mat4x4 = 64 bytes
struct Camera {
  viewProj: mat4x4<f32>,
};

// Per-entity model matrix = 64 bytes
struct Model {
  matrix: mat4x4<f32>,
};

// Text rendering parameters = 32 bytes
// color(16) + mode(4) + threshold(4) + smoothing(4) + _pad(4)
struct TextParams {
  color    : vec4<f32>,
  mode     : u32,   // 0=normal  1=sdf  2=msdf
  threshold: f32,
  smoothing: f32,
  _pad     : f32,
};

@group(0) @binding(0) var<uniform> cam    : Camera;
@group(1) @binding(0) var<uniform> model  : Model;
@group(1) @binding(1) var<uniform> params : TextParams;
@group(2) @binding(0) var fontTex : texture_2d<f32>;
@group(2) @binding(1) var fontSmp : sampler;

struct VIn {
  @location(0) position : vec3<f32>,
  @location(1) uv       : vec2<f32>,
};

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0)       uv  : vec2<f32>,
};

@vertex
fn vs_main(in: VIn) -> VOut {
  var out: VOut;
  out.pos = cam.viewProj * model.matrix * vec4<f32>(in.position, 1.0);
  out.uv  = in.uv;
  return out;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let s = textureSample(fontTex, fontSmp, in.uv);
  var alpha: f32;
  switch (params.mode) {
    case 1u: {
      // SDF — distance stored in red channel
      alpha = smoothstep(
        params.threshold - params.smoothing,
        params.threshold + params.smoothing,
        s.r,
      );
    }
    case 2u: {
      // MSDF — median of R, G, B channels
      let median = max(min(s.r, s.g), min(max(s.r, s.g), s.b));
      alpha = smoothstep(
        params.threshold - params.smoothing,
        params.threshold + params.smoothing,
        median,
      );
    }
    default: {
      // Normal bitmap — alpha channel of the atlas
      alpha = s.a;
    }
  }
  if (alpha < 0.01) { discard; }
  return vec4<f32>(params.color.rgb, params.color.a * alpha);
}
