
// Camera uniform: viewProj(64) + camPos(12) + _pad(4) + viewport(8) + _pad2(8) = 96 bytes
struct Camera {
  viewProj : mat4x4<f32>,
  camPos   : vec3<f32>,
  _pad     : f32,
  viewport : vec2<f32>,
  _pad2    : vec2<f32>,
};

// Line uniform: color(16) + width(4) + screenSpace(4) + capType(4) + numPoints(4) = 32 bytes
struct LineParams {
  color      : vec4<f32>,
  width      : f32,
  screenSpace: u32,   // 1 = screen-space, 0 = world-space
  capType    : u32,   // bit 0: round caps, bit 1: independent segment pairs
  numPoints  : u32,
};

// Model matrix uniform: mat4x4<f32> = 64 bytes
struct Model {
  matrix : mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> cam    : Camera;
@group(0) @binding(1) var<uniform> line   : LineParams;
@group(0) @binding(2) var<uniform> model  : Model;
@group(0) @binding(3) var<storage, read> pts : array<f32>;

struct VOut {
  @builtin(position) pos    : vec4<f32>,
  @location(0)       color  : vec4<f32>,
  @location(1)       uv     : vec2<f32>,  // for round-cap alpha
};

fn getPoint(i: u32) -> vec3<f32> {
  let base = i * 3u;
  return vec3<f32>(pts[base], pts[base + 1u], pts[base + 2u]);
}

fn toClip(p: vec3<f32>) -> vec4<f32> {
  return cam.viewProj * model.matrix * vec4<f32>(p, 1.0);
}

const PI: f32 = 3.14159265358979;

fn safeNormalize2(v: vec2<f32>) -> vec2<f32> {
  let len = length(v);
  return select(vec2<f32>(1.0, 0.0), v / len, len > 0.00001);
}

fn safeNormalize3(v: vec3<f32>) -> vec3<f32> {
  let len = length(v);
  return select(vec3<f32>(1.0, 0.0, 0.0), v / len, len > 0.00001);
}

fn screenPoint(i: u32) -> vec2<f32> {
  let clip = toClip(getPoint(i));
  return clip.xy / clip.w * cam.viewport;
}

fn screenJoinOffset(pointIdx: u32, side: f32, halfWidth: f32) -> vec2<f32> {
  if ((line.capType & 2u) != 0u) {
    let pairStart = (pointIdx / 2u) * 2u;
    let dir = safeNormalize2(screenPoint(pairStart + 1u) - screenPoint(pairStart));
    return vec2<f32>(-dir.y, dir.x) * halfWidth * side;
  }
  let lastPoint = line.numPoints - 1u;
  if (pointIdx == 0u) {
    let dir = safeNormalize2(screenPoint(1u) - screenPoint(0u));
    return vec2<f32>(-dir.y, dir.x) * halfWidth * side;
  }
  if (pointIdx >= lastPoint) {
    let dir = safeNormalize2(screenPoint(lastPoint) - screenPoint(lastPoint - 1u));
    return vec2<f32>(-dir.y, dir.x) * halfWidth * side;
  }

  let dirPrev = safeNormalize2(screenPoint(pointIdx) - screenPoint(pointIdx - 1u));
  let dirNext = safeNormalize2(screenPoint(pointIdx + 1u) - screenPoint(pointIdx));
  let nNext = vec2<f32>(-dirNext.y, dirNext.x);
  let tangent = safeNormalize2(dirPrev + dirNext);

  if (length(dirPrev + dirNext) <= 0.00001) {
    return nNext * halfWidth * side;
  }

  let miter = vec2<f32>(-tangent.y, tangent.x);
  let denom = dot(miter, nNext);
  let safeDenom = select(
    select(-0.2, 0.2, denom >= 0.0),
    denom,
    abs(denom) > 0.2,
  );
  let miterLimit = 4.0;
  let miterLength = clamp(halfWidth / safeDenom, -halfWidth * miterLimit, halfWidth * miterLimit);
  return miter * miterLength * side;
}

fn worldJoinOffset(pointIdx: u32, side: f32, halfWidth: f32) -> vec3<f32> {
  let lastPoint = line.numPoints - 1u;
  let p = getPoint(pointIdx);
  let toCam = safeNormalize3(cam.camPos - p);

  if ((line.capType & 2u) != 0u) {
    let pairStart = (pointIdx / 2u) * 2u;
    let dir = safeNormalize3(getPoint(pairStart + 1u) - getPoint(pairStart));
    return safeNormalize3(cross(dir, toCam)) * halfWidth * side;
  }

  if (pointIdx == 0u) {
    let dir = safeNormalize3(getPoint(1u) - getPoint(0u));
    return safeNormalize3(cross(dir, toCam)) * halfWidth * side;
  }
  if (pointIdx >= lastPoint) {
    let dir = safeNormalize3(getPoint(lastPoint) - getPoint(lastPoint - 1u));
    return safeNormalize3(cross(dir, toCam)) * halfWidth * side;
  }

  let dirPrev = safeNormalize3(getPoint(pointIdx) - getPoint(pointIdx - 1u));
  let dirNext = safeNormalize3(getPoint(pointIdx + 1u) - getPoint(pointIdx));
  let nPrev = safeNormalize3(cross(dirPrev, toCam));
  let nNext = safeNormalize3(cross(dirNext, toCam));
  let miter = safeNormalize3(nPrev + nNext);

  if (length(nPrev + nNext) <= 0.00001) {
    return nNext * halfWidth * side;
  }

  let denom = dot(miter, nNext);
  let safeDenom = select(
    select(-0.2, 0.2, denom >= 0.0),
    denom,
    abs(denom) > 0.2,
  );
  let miterLimit = 4.0;
  let miterLength = clamp(halfWidth / safeDenom, -halfWidth * miterLimit, halfWidth * miterLimit);
  return miter * miterLength * side;
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  var out : VOut;
  out.color = line.color;

  let segmentList = (line.capType & 2u) != 0u;
  let numSegs = select(line.numPoints - 1u, line.numPoints / 2u, segmentList);
  let segIdx  = vi / VERTS_PER_SEG;
  let corner  = vi % VERTS_PER_SEG;

  if (segIdx >= numSegs) {
    out.pos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return out;
  }

  let pointA = select(segIdx, segIdx * 2u, segmentList);
  let pointB = pointA + 1u;
  let pA = getPoint(pointA);
  let pB = getPoint(pointB);

  // half-width in appropriate space
  let hw = line.width * 0.5;

  // ── Segment body (first 6 vertices, 2 tris) ──────────────────────────────
  if (corner < 6u) {
    // corner→(sideA, sideB, tA, tB) mapping: two CCW triangles
    // tri0: 0→(−,0), 1→(+,0), 2→(−,1)
    // tri1: 3→(+,0), 4→(+,1), 5→(−,1)
    let quadVerts = array<vec2<f32>, 6>(
      vec2<f32>(-1.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(-1.0, 1.0),
      vec2<f32>( 1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
    );
    let qv   = quadVerts[corner];
    let side = qv.x;   // -1 or +1
    let t    = qv.y;   // 0 = pA end, 1 = pB end
    let p    = mix(pA, pB, t);

    out.uv = vec2<f32>(side * 0.5 + 0.5, t);

    if (line.screenSpace == 1u) {
      let pointIdx = select(pointA, pointB, t > 0.5);
      let clip = toClip(p);
      let offset = screenJoinOffset(pointIdx, side, hw) * 2.0 / cam.viewport;
      out.pos = vec4<f32>(clip.xy + offset * clip.w, clip.z, clip.w);
    } else {
      let pointIdx = select(pointA, pointB, t > 0.5);
      let wp     = p + worldJoinOffset(pointIdx, side, hw);
      out.pos    = toClip(wp);
    }

    return out;
  }

  // ── Round/butt caps ───────────────────────────────────────────────────────
  // Indices 6 .. (6 + CAP_SEGS*3 - 1) = start cap (pA side)
  // Indices (6 + CAP_SEGS*3) .. (6 + CAP_SEGS*6 - 1) = end cap (pB side)
  let capVertCount = CAP_SEGS * 3u;
  let inEnd   = corner >= 6u + capVertCount;
  let capCorner = corner - 6u - select(0u, capVertCount, inEnd);
  let triIdx  = capCorner / 3u;
  let vertInTri = capCorner % 3u;

  if (!segmentList && ((inEnd && segIdx != numSegs - 1u) || (!inEnd && segIdx != 0u))) {
    out.pos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return out;
  }

  let capPt   = select(pA, pB, inEnd);
  // Direction away from the opposite end
  let segDir  = normalize(pB - pA);
  let outward = select(-segDir, segDir, inEnd);

  // For butt caps: emit degenerate triangles at clip(0,0,0,1)
  if ((line.capType & 1u) == 0u) {
    out.pos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return out;
  }

  // Round cap: fan of CAP_SEGS triangles in the hemisphere
  // angle range: [-PI/2 .. PI/2] around outward
  let a0 = f32(triIdx)       * PI / f32(CAP_SEGS);
  let a1 = f32(triIdx + 1u)  * PI / f32(CAP_SEGS);

  if (line.screenSpace == 1u) {
    let capClip  = toClip(capPt);
    let clipA_   = toClip(pA);
    let clipB_   = toClip(pB);
    let ndcA_    = clipA_.xy / clipA_.w;
    let ndcB_    = clipB_.xy / clipB_.w;
    let segDirNDC = normalize((ndcB_ - ndcA_) * cam.viewport);
    let perpNDC  = vec2<f32>(-segDirNDC.y, segDirNDC.x);
    let outNDC   = select(-segDirNDC, segDirNDC, inEnd);
    let hwNDC    = hw * 2.0 / cam.viewport;

    // angle shifted by -PI/2 so fan starts on one edge, bulges outward at
    // the middle, and ends on the opposite edge.
    let a0s = a0 - PI * 0.5;
    let a1s = a1 - PI * 0.5;
    var offset: vec2<f32>;
    switch (vertInTri) {
      case 0u: { offset = vec2<f32>(0.0, 0.0); }
      case 1u: { offset = (outNDC * cos(a0s) + perpNDC * sin(a0s)) * hwNDC; }
      default: { offset = (outNDC * cos(a1s) + perpNDC * sin(a1s)) * hwNDC; }
    }
    out.pos = vec4<f32>(capClip.xy + offset * capClip.w, capClip.z, capClip.w);
  } else {
    let dir_   = normalize(pB - pA);
    let toCam_ = normalize(cam.camPos - capPt);
    let perp_  = normalize(cross(dir_, toCam_));
    let a0s    = a0 - PI * 0.5;
    let a1s    = a1 - PI * 0.5;
    var wp: vec3<f32>;
    switch (vertInTri) {
      case 0u: { wp = capPt; }
      case 1u: { wp = capPt + (outward * cos(a0s) + perp_ * sin(a0s)) * hw; }
      default: { wp = capPt + (outward * cos(a1s) + perp_ * sin(a1s)) * hw; }
    }
    out.pos = toClip(wp);
  }

  out.uv = vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  return in.color;
}
