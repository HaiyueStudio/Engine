# 海月 技术实现文档

本文档详细描述引擎各模块的技术实现方法，包括 WebGPU 资源管理策略、着色器设计、渲染管线配置、性能优化手段等。

---

## 1. WebGPU 初始化与设备管理

### 1.1 引擎初始化流程

`HaiyueEngine.init()` (`src/core/Engine.ts:63-82`)：

```typescript
async init(): Promise<this> {
  this.adapter = await navigator.gpu.requestAdapter();
  this.device  = await this.adapter.requestDevice();
  this.context = this.canvas.getContext('webgpu');
  this.format  = navigator.gpu.getPreferredCanvasFormat();
  this.context.configure({ device, format, alphaMode: 'opaque' });
  this._createRenderTargets();
  window.addEventListener('resize', this._onResize);
}
```

关键点：
- 使用 `getPreferredCanvasFormat()` 自动选择 `bgra8unorm` 或 `rgba8unorm`
- `alphaMode: 'opaque'` 避免合成器 alpha 混合开销
- resize 时自动重建 MSAA 和深度纹理

### 1.2 渲染目标管理

`_createRenderTargets()` (`src/core/Engine.ts:84-110`)：

| 配置 | MSAA 纹理 | 深度纹理格式 |
|------|-----------|-------------|
| reverseZ=false, msaa=1 | 无 | depth24plus |
| reverseZ=false, msaa=4 | format + sampleCount=4 | depth24plus + sampleCount=4 |
| reverseZ=true, msaa=1 | 无 | depth32float |
| reverseZ=true, msaa=4 | format + sampleCount=4 | depth32float + sampleCount=4 |

### 1.3 RenderPass 描述符

`getRenderPassDescriptor()` (`src/core/Engine.ts:117-145`)：

- **无 MSAA**：直接渲染到 swapchain，`storeOp: 'store'`
- **有 MSAA**：渲染到 MSAA 纹理，`resolveTarget` 指向 swapchain，`storeOp: 'discard'`
- 深度 `clearValue`：reverseZ 时为 0.0，否则为 1.0

---

## 2. 渲染器 GPU 资源管理

### 2.1 缓存策略

所有渲染器使用三层缓存，以对象 ID 为键：

```typescript
// Mesh3DRenderer 示例
private geoCache    = new Map<number, GeoGPUData>();    // geometry.id → GPU buffers
private entityCache = new Map<number, EntityGPUData>(); // entity.id → model bind group
private matCache    = new Map<number, MatGPUData>();    // material.id → color buf + texture
```

- **Geometry 缓存**：顶点/法线/UV/索引 buffer 只上传一次，后续帧复用
- **Entity 缓存**：model matrix uniform buffer + bind group 按实体 ID 缓存，每帧仅更新数据
- **Material 缓存**：颜色 uniform buffer + texture + bind group 按材质 ID 缓存

### 2.2 Buffer 对齐

WebGPU 要求 uniform buffer 大小为 16 字节对齐。引擎使用 `Math.ceil(byteLength / 4) * 4` 确保对齐：

```typescript
// Mesh3DRenderer._makeVertexBuffer
const buf = device.createBuffer({
  size: Math.ceil(data.byteLength / 4) * 4,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
```

索引 buffer 同理：`Math.ceil(indices.byteLength / 4) * 4`

### 2.3 Float32Array 写入兼容

`wgpu-matrix` 返回的 `Float32Array` 可能是 buffer 的子视图，与 `@webgpu/types` 的 `GPUAllowSharedBufferSource` 类型不兼容。引擎使用辅助函数解决：

```typescript
function wrtBuf(q: GPUQueue, dst: GPUBuffer, dstOffset: number,
  src: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number },
  srcOffset = 0, size?: number): void {
  q.writeBuffer(dst, dstOffset, src.buffer as ArrayBuffer,
    src.byteOffset + srcOffset, size ?? src.byteLength);
}
```

### 2.4 纹理加载

`Mesh3DRenderer._loadTexture()` (`src/renderer/Mesh3DRenderer.ts:358-388`)：

支持三种纹理源：
1. **URL 字符串**：`fetch → blob → createImageBitmap`
2. **ImageBitmap**：直接使用
3. **HTMLImageElement**：`createImageBitmap(img)`

加载后通过 `copyExternalImageToTexture` 上传到 GPU 纹理（格式 `rgba8unorm`）。

异步纹理加载策略：
- 首次渲染时创建 1x1 白色默认纹理
- 异步加载完成后重建 bind group
- GPUTexture（如 RTT）直接绑定，检测引用变化后重建

---

## 3. 着色器设计

### 3.1 Basic Material 着色器

内嵌于 `src/material/BasicMaterial.ts`，Bind Group 布局：

| Group | Binding | 类型 | 用途 |
|-------|---------|------|------|
| 0 | 0 | uniform | Camera viewProj (mat4x4) |
| 1 | 0 | uniform | Object model (mat4x4) |
| 2 | 0 | uniform | Material color (vec4) + useTexture (u32) |
| 2 | 1 | texture | 漫反射纹理 |
| 2 | 2 | sampler | 线性采样器 |

顶点着色器：
```wgsl
@vertex fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
) -> VertexOutput {
  out.clipPos = camera.viewProj * object.model * vec4(position, 1.0);
  out.uv = uv;
}
```

片元着色器核心逻辑：
```wgsl
@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let baseColor = select(material.color, textureSample(tex, samp, in.uv), material.useTexture == 1u);
  return baseColor;
}
```

### 3.2 Blinn-Phong 着色器

内嵌于 `src/renderer/BlinnPhongRenderer.ts`，4 个 Bind Group：

| Group | Binding | 类型 | 用途 |
|-------|---------|------|------|
| 0 | 0 | uniform | Camera: viewProj (mat4x4) + eyePos (vec4) = 80 bytes |
| 1 | 0 | uniform | Object: model (mat4x4) + normalMatrix (mat4x4) = 128 bytes |
| 2 | 0 | uniform | Material: ambient + diffuse + specular + shininess = 64 bytes |
| 3 | 0 | uniform | Lights: count + 8×LightData = 528 bytes |

LightData 结构（每个 64 bytes）：
```wgsl
struct LightData {
  typeVec   : vec4<u32>,  // x = type (0=ambient 1=dir 2=point)
  color     : vec4<f32>,  // rgb = color, a = intensity
  direction : vec4<f32>,  // xyz = direction (directional light)
  position  : vec4<f32>,  // xyz = world pos (point light), w = range
}
```

光照计算：
- **环境光**：`outColor += lightColor * ambient`
- **方向光**：半角向量 H = normalize(L + V)，Blinn-Phong 高光
- **点光源**：平滑距离衰减 `t = clamp(1 - dist/range, 0, 1); atten = t * t`

### 3.3 深度着色器

将 clip-space z 转换为线性深度：

```wgsl
// 透视投影
let zNdc = clipPos.z / clipPos.w;
let linear = near * far / (far - zNdc * (far - near));

// 正交投影
let linear = near + zNdc * (far - near) * 0.5 + (far - near) * 0.5;
```

### 3.4 2D 着色器

顶点着色器直接将 2D 坐标映射到 clip space：
```wgsl
out.clipPos = camera.viewProj * object.model * vec4<f32>(position, 0.0, 1.0);
```

深度比较设为 `always`（2D 不受 3D 深度影响）。

### 3.5 实例化着色器

使用 `@builtin(instance_index)` 和 storage buffer：

```wgsl
@group(1) @binding(0) var<storage, read> instances: array<InstanceData>;

struct InstanceData {
  model: mat4x4<f32>,
  color: vec4<f32>,
}

@vertex fn vs_main(
  @location(0) position: vec3<f32>,
  @builtin(instance_index) idx: u32,
) -> VertexOutput {
  let worldPos = instances[idx].model * vec4(position, 1.0);
  out.clipPos = camera.viewProj * worldPos;
  out.color = instances[idx].color;
}
```

### 3.6 线条着色器

3D 线条使用屏幕空间宽度渲染（非 glLineWidth）：

- 每段线生成 quad（2 个三角形）+ 可选 round cap（半圆扇形）
- 顶点着色器将线段端点投影到屏幕空间，沿法线方向扩展宽度
- 支持世界空间宽度（世界单位）和屏幕空间宽度（像素单位）
- Camera uniform 包含 `camPos` 和 `viewport` 用于屏幕空间计算

### 3.7 位图文字着色器

支持三种渲染模式：

**Normal 模式**：直接采样纹理 alpha 通道
```wgsl
let a = textureSample(fontTex, fontSamp, uv).a;
```

**SDF 模式**：使用 red 通道 + smoothstep
```wgsl
let dist = textureSample(fontTex, fontSamp, uv).r;
let a = smoothstep(threshold - smoothing, threshold + smoothing, dist);
```

**MSDF 模式**：使用 RGB 三通道中值算法
```wgsl
let msd = textureSample(fontTex, fontSamp, uv).rgb;
let sd = median(msd.r, msd.g, msd.b);
let a = smoothstep(threshold - smoothing, threshold + smoothing, sd);
```

---

## 4. 渲染管线配置

### 4.1 Pipeline 预编译策略

所有渲染器在 `prepare()` 时预编译 4 种 pipeline（2×2 组合）：

```
[reverseZ=false, msaa=1] [reverseZ=false, msaa=4]
[reverseZ=true,  msaa=1] [reverseZ=true,  msaa=4]
```

混合模式 pipeline 延迟创建并缓存：

```typescript
private _blendPipelineCache = new Map<string, GPURenderPipeline>();
// key: `${blendMode}_${rzIdx}_${msaaIdx}`
```

### 4.2 Reverse-Z 深度策略

Reverse-Z 将远平面映射到 NDC z=0，近平面映射到 z=1：

```typescript
// Camera3D.projectionMatrix
if (this.reverseZ) {
  const m = this._projMatrix;
  for (let c = 0; c < 4; c++) {
    m[c * 4 + 2] = -m[c * 4 + 2] + m[c * 4 + 3];
  }
}
```

对应的 pipeline 配置：
- 深度格式：`depth32float`（比 `depth24plus` 精度更高）
- 深度比较：`greater` 或 `greater-equal`
- 深度清除值：0.0

### 4.3 MSAA 实现

- MSAA 纹理作为 `colorAttachment.view`
- swapchain 纹理作为 `resolveTarget`
- `storeOp: 'discard'`（MSAA 纹理不需要保留）
- 深度纹理也使用相同的 `sampleCount`

### 4.4 混合模式

| 模式 | 颜色混合 | Alpha 混合 | 深度写入 | 背面剔除 |
|------|---------|-----------|---------|---------|
| none | 不混合 | 不混合 | 启用 | back |
| normal | src-alpha / one-minus-src-alpha | one / one-minus-src-alpha | 禁用 | none |
| additive | src-alpha / one | zero / one | 禁用 | none |

---

## 5. 视锥体裁剪实现

### 5.1 平面提取

使用 Gribb/Hartmann 方法从 viewProjection 矩阵提取 6 个归一化平面：

```typescript
// Frustum.setFromViewProjection(vp: Float32Array)
// left:   vp[3] + vp[0]
// right:  vp[3] - vp[0]
// bottom: vp[3] + vp[1]
// top:    vp[3] - vp[1]
// near:   vp[3] + vp[2]
// far:    vp[3] - vp[2]
```

每个平面存储为 `[a, b, c, d]`，归一化后 `ax + by + cz + d = 0`。

### 5.2 球体测试

```typescript
containsSphere(sphere: BoundingSphere): boolean {
  for each plane:
    distance = a*cx + b*cy + c*cz + d
    if (distance < -radius) return false; // 完全在平面外侧
  return true;
}
```

### 5.3 包围球计算

`computeBoundingSphere()` 使用质心 + 最大距离法（快速但保守，不保证最小包围球）：

```typescript
center = positions 的算术平均
radius = max(distance(position, center))
```

---

## 6. 后处理管线实现

### 6.1 Ping-Pong 缓冲区

`PostProcessRenderer` 维护两个全屏纹理 `buf0` 和 `buf1`：

```
场景渲染 → buf0
Pass[0]: buf0 → buf1
Pass[1]: buf1 → buf0
Pass[2]: buf0 → buf1
...
最后一个 Pass: src → outputView (swapchain)
```

### 6.2 PostProcessPass 基类

```typescript
abstract class PostProcessPass {
  abstract prepare(device: GPUDevice, format: GPUTextureFormat): void;
  abstract apply(
    encoder: GPUCommandEncoder,
    srcView: GPUTextureView,
    dstView: GPUTextureView,
    width: number, height: number
  ): void;
  abstract resize(device: GPUDevice, width: number, height: number): void;
  abstract destroy(): void;
}
```

共享全屏三角形顶点着色器：
```wgsl
@vertex fn vs_fullscreen(@builtin(vertex_index) vid: u32) -> VertexOutput {
  // 3 个顶点覆盖整个屏幕（无需 vertex buffer）
  var pos = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  out.uv = pos[vid] * 0.5 + 0.5;
  out.position = vec4(pos[vid], 0.0, 1.0);
}
```

### 6.3 FXAA 实现

标准 FXAA 算法：
1. 计算像素亮度 (luma)
2. 计算梯度方向（水平/垂直）
3. 沿边缘方向双采样对
4. 混合结果

### 6.4 高斯模糊实现

两遍分离高斯模糊：
1. 水平 pass：从 src 读取，写入中间纹理
2. 垂直 pass：从中间纹理读取，写入 dst

使用 `textureSampleLevel` 在循环中采样，避免导数计算限制。支持可配置 `radius` 和 `sigma`。

---

## 7. RTT（渲染到纹理）实现

### 7.1 RttEngine

`RttEngine` 实现 `IEngine` 接口，包装 `HaiyueEngine`：

```typescript
class RttEngine implements IEngine {
  // 共享自 HaiyueEngine
  get device() { return this._engine.device; }
  get format() { return this._engine.format; }

  // 独立拥有
  private _colorTexture: GPUTexture;  // RENDER_ATTACHMENT | TEXTURE_BINDING
  private _depthTexture: GPUTexture;
  private _msaaTexture: GPUTexture | null;
}
```

关键：颜色纹理的 usage 包含 `TEXTURE_BINDING`，使其可被其他材质采样。

### 7.2 RttTexture 使用模式

```typescript
// 1. 创建 RTT
const rtt = new RttTexture(engine, { width: 512, height: 512 });
rtt.world.addSystem(new Render3DSystem(rtt.engine, cameraEntity));

// 2. 每帧先渲染 RTT
rtt.render(time, delta);

// 3. 将 RTT 纹理作为材质纹理
material.texture = rtt.texture;  // GPUTexture

// 4. 渲染主场景（使用 RTT 纹理）
world.update(time, delta);
```

---

## 8. 交互系统实现

### 8.1 射线构建

`Ray.setFromCamera()` 从 NDC 坐标 + 相机参数构建世界空间射线：

```typescript
setFromCamera(ndcX: number, ndcY: number, camera: Camera3D, camWorldMatrix: Float32Array) {
  // 逆投影：NDC → 世界空间
  const invVP = mat4.inverse(mat4.multiply(camera.projectionMatrix, viewMatrix));
  const nearPoint = mat4.transformPoint(invVP, [ndcX, ndcY, -1]);  // 或 1 (reverseZ)
  const farPoint  = mat4.transformPoint(invVP, [ndcX, ndcY, 1]);   // 或 0 (reverseZ)
  // origin = nearPoint, direction = normalize(farPoint - nearPoint)
}
```

### 8.2 射线-网格相交

`Ray.intersectMesh()` 实现两阶段检测：

**阶段一：AABB Slab Test**（粗检）
- 将射线变换到模型局部空间
- 对局部空间 AABB 进行 slab test
- 快速排除不相交的网格

**阶段二：Moller-Trumbore 三角形检测**（精检）
- 遍历几何体的每个三角形
- 使用 Moller-Trumbore 算法计算射线-三角形交点
- 记录最近正面交点的距离、世界空间点和法线

### 8.3 事件分发

```typescript
// 事件类型
type InteractiveEvent = 'pointerenter' | 'pointerleave' | 'pointerdown'
  | 'pointerup' | 'pointermove' | 'click';

// 事件数据
interface InteractiveEventData {
  worldPoint: [number, number, number];  // 世界空间交点
  distance: number;                       // 射线距离
  normal: [number, number, number];       // 交点法线
  originalEvent: PointerEvent;           // 原始 DOM 事件
}
```

遮挡逻辑：
- 无 `Interactive` 组件的 Mesh3D 实体作为遮挡体
- `penetrable = true` 的 Interactive 实体完全透明（不遮挡后方实体）

---

## 9. 实例化渲染实现

### 9.1 数据布局

`InstancedMaterial` 管理每实例数据：

```typescript
transforms: Float32Array;  // instanceCount × 16 (mat4x4)
colors: Float32Array;      // instanceCount × 4  (rgba)
```

### 9.2 GPU 上传策略

使用 `storage buffer` 而非 `uniform buffer`：

```typescript
// InstancedMesh3DRenderer
@group(1) @binding(0) var<storage, read> instances: array<InstanceData>;
```

- `transformsDirty` / `colorsDirty` 标记控制是否需要上传
- `instanceCount` 变化时重建 GPU buffer（`device.createBuffer`）
- 使用 `device.queue.writeBuffer` 更新数据

### 9.3 绘制调用

```typescript
passEncoder.setVertexBuffer(0, geo.posBuf);
passEncoder.setVertexBuffer(1, geo.normBuf);
passEncoder.setVertexBuffer(2, geo.uvBuf);
if (geo.idxBuf) {
  passEncoder.setIndexBuffer(geo.idxBuf, geo.indexFormat);
  passEncoder.drawIndexed(geo.indexCount, instanceCount);
} else {
  passEncoder.draw(geo.vertexCount, instanceCount);
}
```

---

## 10. 位图文字实现

### 10.1 字体数据

`BitmapFontData` 包含：
- 字符映射 `Map<number, BitmapFontChar>`（charCode → 字形信息）
- Kerning 映射 `Map<string, number>`（`${first}_${second}` → 间距调整）
- 图集页面（URL 或 ImageBitmap）

### 10.2 字体加载

支持两种格式：
- **AngelCode .fnt 文本格式**：`parseFnt()`
- **JSON 格式**：`parseFntJson()`

### 10.3 运行时字体生成

`buildBitmapFont()` 使用 Canvas 2D API：
1. 创建离屏 Canvas
2. 逐字符 `measureText` 获取度量
3. 行打包算法排列字形
4. 白色文字绘制到透明背景
5. 返回 `BitmapFontData` + Canvas（可作为纹理源）

### 10.4 文字网格构建

`BitmapTextRenderer.buildTextMesh()` CPU 端构建：
1. 遍历文字的每个字符
2. 查找字形信息（x/y/width/height/xOffset/yOffset/xAdvance）
3. 应用 kerning 调整
4. 处理换行（`\n`）
5. 生成 4 顶点/字符（2 三角形）的位置 + UV 数据
6. `dirty` 标记机制：文字变更时标记，渲染器消费后清除

---

## 11. MeshHelper 辅助可视化

### 11.1 三种模式

| 模式 | 说明 | 实现方式 |
|------|------|---------|
| `aabb` | 世界空间轴对齐包围盒 | 每帧 CPU 计算包围盒，更新 line-list 顶点 |
| `obb` | 局部空间方向包围盒 | 使用局部空间包围盒 + 世界矩阵 |
| `wireframe` | 三角面边线 | 从索引/非索引几何体提取去重边 |

### 11.2 边提取算法

```typescript
// 索引几何体：遍历三角形，收集边
for (let i = 0; i < indices.length; i += 3) {
  edges.add(key(i0, i1));
  edges.add(key(i1, i2));
  edges.add(key(i2, i0));
}

// 非索引几何体：每 3 个顶点为一个三角形
```

使用 `key = min(i,j) + '_' + max(i,j)` 去重。

---

## 12. OrbitControl 实现

### 12.1 输入映射

| 输入 | 操作 |
|------|------|
| 左键拖拽 | 旋转（theta/phi） |
| 右键/中键拖拽 | 平移（target） |
| 滚轮 | 缩放（radius） |
| 双指捏合 | 缩放（radius） |

### 12.2 平移计算

基于相机坐标系：
```typescript
const right = [camWorld[0], camWorld[4], camWorld[8]];   // 列0
const up    = [camWorld[1], camWorld[5], camWorld[9]];   // 列1
target += right * dx + up * dy;
```

### 12.3 限制

- `minRadius` / `maxRadius`：半径限制
- `phi` 限制在 `[PHI_EPS, PI - PHI_EPS]` 避免万向节锁

---

## 13. 补间动画系统

### 13.1 Tween 生命周期

```
创建 → delay → 首次 update 捕获起始值 → easing 插值 → 完成
                    ↑                         |
                    └──── repeat/yoyo ─────────┘
```

### 13.2 插值系统

`interpolate()` 函数根据目标类型自动选择插值方式：

| 目标类型 | 插值方法 |
|---------|---------|
| `number` | `lerpNumber(a, b, t)` |
| `Float32Array` | `lerpFloat32Array(a, b, t)` |
| `ColorSRGB` | `lerpColorSRGB(a, b, t)` |

可通过 `interpolatorRegistry` 注册自定义插值器。

### 13.3 缓动函数

`Easing` 模块提供标准缓动函数：

```typescript
Easing.linear, Easing.quadIn, Easing.quadOut, Easing.quadInOut,
Easing.cubicIn, Easing.cubicOut, Easing.cubicInOut,
Easing.elasticIn, Easing.elasticOut, Easing.elasticInOut,
Easing.bounceIn, Easing.bounceOut, Easing.bounceInOut, ...
```

---

## 14. 颜色空间转换

### 14.1 sRGB ↔ Linear

```typescript
static srgbToLinear(c: number): number {
  return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

static linearToSRGB(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
```

### 14.2 HSL ↔ sRGB

标准 HSL ↔ RGB 转换算法，H 范围 [0, 360]，S/L 范围 [0, 1]。

---

## 15. 序列化系统

`ecs/serial.ts` 提供 ECS 对象的序列化/反序列化：

- 维护 ID 映射表（componentIdMap / entityIdMap / worldIdMap）处理 ID 重分配
- 延迟处理 children 关系（因为实例化顺序问题）
- 支持通过 `constructorMap` 注册自定义构造函数

---

## 16. 构建配置

### 16.1 Rollup 配置

**库构建** (`rollup.config.js`)：
- 入口：`src/index.ts`
- 输出：ES 模块格式到 `dist/index.js`
- 外部依赖：`wgpu-matrix`
- 插件：node-resolve, typescript

**示例构建** (`../../examples/rollup.config.js`)：
- 多入口：`examples/*/main.ts`
- 输出：`examples/*/bundle.js`
- 内联所有依赖（包括 wgpu-matrix）

**游戏构建** (`../../games/rollup.config.js`)：
- 多入口：`games/*/main.ts`
- 输出：`games/*/bundle.js`

### 16.2 TypeScript 配置

- `target: ES2020`
- `module: ESNext`
- `moduleResolution: bundler`
- 声明文件输出到 `dist/`
- 包含 `@webgpu/types` 类型
- `strict: false`
- `experimentalDecorators: true`

---

## 17. 性能优化总结

| 优化项 | 实现方式 |
|--------|---------|
| GPU 资源缓存 | 按 ID 缓存 buffer/texture/bind group，避免每帧重建 |
| Pipeline 预编译 | reverseZ × MSAA 的 4 种组合在 prepare 时创建 |
| 混合模式延迟创建 | 按需创建混合 pipeline，Map 缓存 |
| ECS 脏标记 | EntitiesCache 仅在组件变更时更新 System 的 entitySet |
| 视锥体裁剪 | 可选启用，AABB slab test 粗检 |
| 实例化渲染 | storage buffer + instance_index，单次 draw call |
| Buffer 对齐 | Math.ceil(byteLength/4)*4 确保对齐 |
| 纹理异步加载 | 先用 1x1 白色占位，加载完成后重建 bind group |
| unsortedRemove | O(1) 数组删除（不保持顺序） |
| 投影矩阵懒计算 | Camera3D 使用 dirty 标记，仅在参数变更时重算 |
