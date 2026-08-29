# 海月 架构文档

## 1. 项目概览

@haiyue/engine 是一个基于 WebGPU API 的轻量级 2D/3D 渲染引擎，采用 TypeScript 编写，使用 ECS（Entity-Component-System）架构模式。引擎提供完整的渲染管线，包括基础材质、Blinn-Phong 光照、实例化渲染、后处理、位图文字、2D 渲染、射线拾取交互等功能。

**技术栈**：
- 语言：TypeScript (ES2020)
- 图形 API：WebGPU
- 数学库：wgpu-matrix
- 构建：Rollup
- ECS 基础设施：自研（`ecs/` 目录）

---

## 2. 顶层目录结构

```
@haiyue/engine/
├── ecs/                    # 独立的 ECS 框架（无渲染依赖）
│   ├── Component.ts        # 组件基类 + 唯一性检查
│   ├── Entity.ts           # 实体（树形结构，组件容器）
│   ├── System.ts           # 系统基类（查询 + 更新）
│   ├── World.ts            # 世界（实体 + 系统的管理器）
│   ├── cache.ts            # WeakMap 缓存（脏标记优化）
│   ├── Global.ts           # 全局 ID 生成器
│   ├── serial.ts           # 序列化/反序列化
│   ├── interfaces/         # IECSObject, 序列化接口
│   └── utils/              # unsortedRemove, ecsManagerOperations
├── src/                    # 引擎核心
│   ├── core/               # Engine, IEngine, EventEmitter, ViewportRect
│   ├── components/         # 渲染组件（Transform, Camera, Mesh, ...）
│   ├── systems/            # 渲染系统（Render3DSystem, ...）
│   ├── renderer/           # WebGPU 渲染器（Mesh3DRenderer, ...）
│   ├── material/           # 材质定义
│   ├── geometry/           # 几何体定义
│   ├── lighting/           # 灯光组件
│   ├── postprocess/        # 后处理管线
│   ├── rtt/                # 渲染到纹理（RTT）
│   ├── culling/            # 视锥体裁剪
│   ├── controls/           # 轨道控制器
│   ├── tween/              # 补间动画
│   ├── color/              # 颜色空间（sRGB, Linear, HSL）
│   ├── font/               # 位图字体
│   ├── math/               # 数学工具（Ray）
│   └── index.ts            # 统一导出
├── examples/               # 示例程序（15+个）
├── games/                  # 游戏示例（扫雷）
├── dist/                   # 构建输出
├── package.json
├── tsconfig.json
└── rollup.config.js
```

---

## 3. 架构总览

引擎采用 **ECS + Renderer 分层架构**：

```
┌─────────────────────────────────────────────────────┐
│                    应用层 (Examples/Games)            │
├─────────────────────────────────────────────────────┤
│              World (ECS 编排层)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │  Entity   │  │  System   │  │  Component        │   │
│  │  (树形)   │  │  (查询+更新)│  │  (数据容器)       │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
├─────────────────────────────────────────────────────┤
│              System 层 (渲染逻辑编排)                  │
│  Render3DSystem / Render2DSystem /                     │
│  InteractionSystem / ...                              │
├─────────────────────────────────────────────────────┤
│              Renderer 层 (WebGPU 调用封装)             │
│  Mesh3DRenderer / BlinnPhongRenderer / ...            │
├─────────────────────────────────────────────────────┤
│              Engine 层 (GPU 设备管理)                  │
│  HaiyueEngine / RttEngine (IEngine 接口)              │
├─────────────────────────────────────────────────────┤
│              WebGPU API                              │
└─────────────────────────────────────────────────────┘
```

---

## 4. ECS 框架

### 4.1 核心概念

| 概念 | 文件 | 职责 |
|------|------|------|
| **Entity** | `ecs/Entity.ts` | 实体，树形结构节点，持有组件集合 |
| **Component** | `ecs/Component.ts` | 组件，纯数据容器，通过 `UniqueCheckType` 控制唯一性 |
| **System** | `ecs/System.ts` | 系统，通过查询规则筛选实体并执行逻辑 |
| **World** | `ecs/World.ts` | 世界，管理实体和系统的生命周期与更新循环 |

### 4.2 实体-组件关系

- Entity 继承自 `@valeera/tree` 的 `TreeNode`，支持 `parent/children` 树形结构
- Entity 通过 `addComponent/removeComponent/getComponent/hasComponent` 管理组件
- 组件唯一性由 `UniqueCheckType` 枚举控制：
  - `NO`：不检查（可添加多个同类组件）
  - `SAME`：类一致时保留最新
  - `SYMBOL`：通过 `UniqueSymbol` 标识（最常用）
  - `CHILD/SUPER`：继承关系检查
  - `REPLACE`：替换而非忽略

### 4.3 系统-查询机制

- System 构造时接收查询规则 `(entity: Entity) => boolean`
- World.update() 时：
  1. 遍历 `EntitiesCache`（脏标记集合），更新每个 System 的 `entitySet`
  2. 按 `priority` 排序执行 System
  3. System.update() 遍历匹配的实体执行 handler
- `EntitiesCache` 使用 WeakMap 以 World 为键，仅在组件变更时标记实体为脏

### 4.4 ID 生成

所有 ECS 对象通过 `IdGeneratorInstance`（来自 `@valeera/idgenerator`）分配全局唯一自增 ID，用于 Map 缓存键和序列化。

---

## 5. 引擎核心

### 5.1 IEngine 接口

定义于 `src/core/IEngine.ts`，是引擎的最小接口：

```typescript
interface IEngine {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  reverseZ: boolean;
  msaaSamples: 1 | 4;
  clearColor: { r: number; g: number; b: number; a: number };
  readonly depthTextureView: GPUTextureView;
  readonly msaaTextureView: GPUTextureView | null;
  getRenderPassDescriptor(): GPURenderPassDescriptor;
  getOutputView(): GPUTextureView;
}
```

所有 Renderer 和 System 均依赖 `IEngine` 而非 `HaiyueEngine`，使得渲染目标可以是主画布或 RTT 纹理。

### 5.2 HaiyueEngine

`src/core/Engine.ts`，主引擎类，继承 `EventEmitter`：

- **初始化**：`init()` 请求 GPU adapter/device，配置 canvas context
- **渲染目标**：管理 MSAA 纹理和深度纹理，支持动态切换 reverseZ 和 MSAA
- **渲染循环**：`run()` 使用 `requestAnimationFrame` 驱动，emit `update` 事件
- **事件**：`resize`（窗口大小变化）、`update`（每帧更新）

### 5.3 RttEngine

`src/rtt/RttEngine.ts`，离屏渲染引擎，实现 `IEngine` 接口：

- 包装 `HaiyueEngine` 共享 device/format
- 拥有独立的颜色纹理（TEXTURE_BINDING + RENDER_ATTACHMENT）和深度纹理
- 颜色纹理可被其他材质采样（用于 RTT 效果）

### 5.4 RttTexture

`src/rtt/RttTexture.ts`，RTT 便捷容器：

- 组合 `RttEngine` + `World`
- `texture` getter 返回可采样的 GPUTexture
- `render()` 调用 world.update() 完成离屏渲染

---

## 6. 组件体系

### 6.1 变换组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `Transform3D` | `components/Transform3D.ts` | 基础 3D 变换，4x4 矩阵，支持父子级联 |
| `CartesianTransform3D` | `components/CartesianTransform3D.ts` | 欧拉角变换（position/rotation/scale/anchor） |
| `BasisTransform3D` | `components/BasisTransform3D.ts` | 自定义基向量 + 局部坐标变换，默认基为 XYZ 单位轴 |
| `SphericalTransform3D` | `components/SphericalTransform3D.ts` | 球坐标变换（radius/theta/phi），适合轨道相机 |
| `Transform2D` | `components/Transform2D.ts` | 2D 变换（x/y/rotation/scaleX/scaleY） |

### 6.2 相机组件

| 组件 | 说明 |
|------|------|
| `Camera3D` | 3D 相机，支持透视/正交投影，reverseZ 深度反转 |
| `Camera2D` | 2D 正交相机，支持 zoom 缩放 |

### 6.3 渲染组件

| 组件 | 说明 |
|------|------|
| `Mesh3D` | 3D 网格（Geometry3D + Material） |
| `Mesh2D` | 2D 网格（Geometry2D + Material2D） |
| `InstancedMesh3D` | 实例化 3D 网格（Geometry3D + InstancedMaterial） |
| `BitmapText` | 位图文字（支持 normal/sdf/msdf） |
| `Line3D` | 3D 线条（LineGeometry + LineMaterial） |
| `MeshHelper` | 网格辅助可视化（AABB/OBB/线框模式） |

### 6.4 交互组件

| 组件 | 说明 |
|------|------|
| `Interactive` | 交互事件组件，支持 pointerenter/leave/down/up/move/click |

---

## 7. 系统体系

### 7.1 渲染系统

| 系统 | 查询条件 | 职责 |
|------|----------|------|
| `Render3DSystem` | `Mesh3D` | 统一调度 Basic、Blinn-Phong、PBR 等 3D 材质渲染器，并负责深度渲染、辅助线、后处理和视锥裁剪 |
| `Render2DSystem` | `Mesh3D` + `BasicMaterial` | 2D 渲染（使用 3D 管线 + 正交相机） |
| `Mesh2DRenderSystem` | `Mesh2D` | 2D 专用管线渲染 |
| `BitmapTextRenderSystem` | `BitmapText` | 位图文字渲染 |
| `InstancedMesh3DRenderSystem` | `InstancedMesh3D` | 实例化渲染 |
| `Line3DRenderSystem` | `Line3D` | 3D 线条渲染 |

### 7.2 交互系统

| 系统 | 职责 |
|------|------|
| `InteractionSystem` | 射线拾取 + 事件分发，支持遮挡和穿透 |

### 7.3 系统执行顺序

系统通过 `priority` 属性控制执行顺序，数值越小越先执行。可在构造时通过 `options.priority` 设置。

---

## 8. 渲染器体系

### 8.1 渲染器与系统的关系

```
System (逻辑编排)          Renderer (GPU 调用)
─────────────────          ──────────────────
Render3DSystem  ──────►    Mesh3DRenderer
                          BlinnPhongRenderer
                          PbrRenderer
                          DepthRenderer
                          MeshHelperRenderer
                          PostProcessRenderer

Mesh2DRenderSystem ───►    Mesh2DRenderer

BitmapTextRenderSystem ►   BitmapTextRenderer

InstancedMesh3DRenderSystem ► InstancedMesh3DRenderer

Line3DRenderSystem ───►    Line3DRenderer
```

### 8.2 渲染器通用模式

所有渲染器遵循相同模式：

1. **`prepare(engine: IEngine)`**：创建 shader module、bind group layout、pipeline、uniform buffer
2. **GPU 缓存**：使用 `Map<number, ...>` 按 geometry/entity/material ID 缓存 GPU 资源
3. **`render(passEncoder, ...)`**：检查缓存 → 上传数据 → 设置 pipeline/bind group → 绘制
4. **Pipeline 预编译**：reverseZ(2) x MSAA(2) = 4 种 pipeline 预编译，混合模式 pipeline 延迟创建并缓存
5. **`destroy()`**：释放所有 GPU 资源

### 8.3 Bind Group 布局约定

| Bind Group | 用途 | 渲染器 |
|-----------|------|--------|
| group(0) | Camera uniform (viewProj, eyePos) | 所有渲染器 |
| group(1) | Object uniform (model matrix) | 所有渲染器 |
| group(2) | Material uniform (color, texture, ...) | 大部分渲染器 |
| group(3) | Lights uniform | BlinnPhongRenderer |

---

## 9. 材质体系

```
Material (抽象基类)
├── BasicMaterial      # 基础材质（纯色 + 纹理），内含 WGSL 着色器
├── BlinnPhongMaterial # Blinn-Phong 光照材质
├── Material2D         # 2D 材质（纯色 + 纹理）
└── DepthMaterial      # 深度材质（输出线性深度）

LineMaterial          # 线条材质（独立，不继承 Material）
InstancedMaterial     # 实例化材质（独立，不继承 Material）
```

材质与着色器的对应关系：
- `BasicMaterial` → `BASIC_MATERIAL_WGSL`（内嵌在 BasicMaterial.ts）
- `BlinnPhongMaterial` → `BLINNPHONG_WGSL`（内嵌在 BlinnPhongRenderer.ts）
- `Material2D` → 2D WGSL（内嵌在 Mesh2DRenderer.ts）
- `DepthMaterial` → Depth WGSL（内嵌在 DepthRenderer.ts）

---

## 10. 几何体体系

```
Geometry3D              # 3D 几何体基类（positions, normals, uvs, indices, 自定义属性, 实例属性）
├── createBox3D()       # 立方体
├── createSphere3D()    # 球体
├── createCone3D()      # 锥体
└── createPlane3D()     # 平面

Geometry2D              # 2D 几何体基类（positions, indices）
├── createRect2D()      # 矩形
├── createCircle2D()    # 圆形
├── createTriangle2D()  # 三角形
└── createPolygon2D()   # 正多边形/自定义凸多边形

LineGeometry            # 线条几何体（3D 点序列）
```

---

## 11. 灯光体系

```
LightComponent (抽象基类, UniqueSymbol = 'LightComponent')
├── AmbientLight      # 环境光 (type='ambient')
├── DirectionalLight  # 方向光 (type='directional')
└── PointLight        # 点光源 (type='point', 含 range 衰减)
```

灯光数据由 `Render3DSystem` 在调度需要光照的材质渲染器时收集并上传；`BlinnPhongRenderer` 会将场景中的 `LightComponent` 打包为 UBO。最多支持 8 盏灯。

---

## 12. 后处理管线

```
PostProcessRenderer          # 后处理链管理器（ping-pong 缓冲区）
└── PostProcessPass (抽象)   # 后处理 Pass 基类
    ├── FxaaPass             # FXAA 抗锯齿
    ├── GaussianBlurPass     # 高斯模糊（两遍分离）
    ├── GrayscalePass        # 灰度
    └── CustomPass           # 自定义 WGSL 后处理
```

工作流程：
1. 场景渲染到 `buf0`（而非直接输出到 swapchain）
2. Pass[0] 读取 `buf0`，写入 `buf1`
3. Pass[1] 读取 `buf1`，写入 `buf0`
4. ...交替进行
5. 最后一个 Pass 输出到 `outputView`（swapchain）

---

## 13. 视锥体裁剪

`src/culling/Frustum.ts`：

- 使用 Gribb/Hartmann 方法从 viewProjection 矩阵提取 6 个裁剪平面
- `containsSphere()` 进行球体-视锥体相交测试
- `computeBoundingSphere()` 从顶点位置计算包围球
- `Render3DSystem` 通过 `RenderProfile` 启用（默认 `batched`）

---

## 14. 交互系统

`InteractionSystem` 实现射线拾取：

1. 监听 canvas 的 pointer 事件
2. 将屏幕坐标转为 NDC
3. 通过 `Ray.setFromCamera()` 构建世界空间射线
4. 对每个 Mesh3D 实体执行 `Ray.intersectMesh()`：
   - AABB slab test 粗检
   - Moller-Trumbore 逐三角形精检
5. 按距离排序，最近命中实体触发事件
6. 遮挡逻辑：无 `Interactive` 组件的 Mesh3D 作为遮挡体

---

## 15. 补间动画

```
TweenManager              # 管理所有 Tween 的生命周期
└── Tween                 # 单个补间动画
    ├── to() / from()     # 目标/起始值
    ├── delay()           # 延迟
    ├── easing()          # 缓动函数
    ├── repeat()          # 重复（含 'infinite'）
    └── yoyo()            # 往返模式
```

- 支持通用插值：数字、Float32Array、ColorSRGB
- `Easing` 模块提供标准缓动函数（linear, quad, cubic, elastic, bounce 等）

---

## 16. 颜色系统

```
ColorSRGB    # sRGB 颜色空间（引擎规范格式）
ColorLinear  # 线性 RGB 颜色空间
ColorHSL     # HSL 颜色空间
```

- 提供 `toSRGB()`/`fromSRGB()`/`srgbToLinear()`/`linearToSRGB()` 转换
- 材质颜色统一使用 `ColorSRGB`

---

## 17. 数据流与渲染循环

```
┌──────────────┐
│ HaiyueEngine │ ← requestAnimationFrame
│  emit('update')│
└──────┬───────┘
       │
       ▼
┌──────────────┐
│    World     │
│  .update()   │
└──────┬───────┘
       │
       ├──► System 1 (按 priority 排序)
       │    └── 遍历 entitySet → handler(entity)
       │
       ├──► System 2 (如 Render3DSystem)
       │    ├── 更新相机矩阵
       │    ├── 更新世界矩阵（级联 Transform3D）
       │    ├── 视锥体裁剪（可选）
       │    ├── 创建 CommandEncoder + RenderPass
       │    ├── 对每个可见实体调用 Renderer.render()
       │    ├── 后处理链（如有）
       │    └── submit 命令缓冲
       │
       └──► System N ...
```

---

## 18. 关键设计决策

1. **ECS 与渲染分离**：ECS 框架（`ecs/`）完全独立于渲染，可单独使用
2. **IEngine 接口抽象**：Renderer 依赖 `IEngine` 而非 `HaiyueEngine`，支持 RTT 离屏渲染
3. **WGSL 内嵌**：着色器代码以字符串常量内嵌在 Renderer/Material 文件中，无需外部文件加载
4. **GPU 资源缓存**：Renderer 按 ID 缓存 GPU buffer/texture/bind group，避免每帧重建
5. **Pipeline 预编译**：reverseZ x MSAA 的 4 种组合预编译，混合模式延迟创建
6. **脏标记优化**：ECS 使用 `EntitiesCache` 仅在组件变更时更新 System 的 entitySet
7. **组件唯一性控制**：`UniqueCheckType` 灵活控制同实体同类组件的添加策略
8. **树形实体**：Entity 继承 TreeNode，支持场景图层级结构
