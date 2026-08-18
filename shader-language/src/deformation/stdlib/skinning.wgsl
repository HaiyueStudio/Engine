struct SkinUniforms {
  jointMatrices : array<mat4x4<f32>>,
}

struct SkinAttributes {
  values : array<vec4<f32>>,
}

fn skinPosition(position: vec3<f32>, joints: vec4<f32>, weights: vec4<f32>) -> vec4<f32> {
  if (dot(weights, vec4<f32>(1.0)) <= 0.0) {
    return vec4<f32>(position, 1.0);
  }
  let j0 = u32(joints.x);
  let j1 = u32(joints.y);
  let j2 = u32(joints.z);
  let j3 = u32(joints.w);
  let p = vec4<f32>(position, 1.0);
  return (skin.jointMatrices[j0] * p) * weights.x +
    (skin.jointMatrices[j1] * p) * weights.y +
    (skin.jointMatrices[j2] * p) * weights.z +
    (skin.jointMatrices[j3] * p) * weights.w;
}

fn skinNormal(normal: vec3<f32>, joints: vec4<f32>, weights: vec4<f32>) -> vec3<f32> {
  if (dot(weights, vec4<f32>(1.0)) <= 0.0) {
    return normal;
  }
  let j0 = u32(joints.x);
  let j1 = u32(joints.y);
  let j2 = u32(joints.z);
  let j3 = u32(joints.w);
  let n = vec4<f32>(normal, 0.0);
  return (skin.jointMatrices[j0] * n).xyz * weights.x +
    (skin.jointMatrices[j1] * n).xyz * weights.y +
    (skin.jointMatrices[j2] * n).xyz * weights.z +
    (skin.jointMatrices[j3] * n).xyz * weights.w;
}

fn safeNormalize(value: vec3<f32>) -> vec3<f32> {
  let len2 = dot(value, value);
  if (len2 <= 0.00000001) {
    return value;
  }
  return value * inverseSqrt(len2);
}
