# 海月 原始需求文档

> 来源：项目根目录 `task.md`，整理到 devLog 作为需求基线参考。

## 需求规格

实现一个完全基于 WebGPU 的渲染引擎，不需要用 WebGL 做兼容。

### 功能需求

1. 使用 TypeScript
2. 支持 3D 渲染与 2D 渲染。3D 相机支持透视投影与正交投影。2D 也有相机的概念
3. 支持 MSAA 设置，默认不开启
4. 支持自定义构造几何体，能支持顶点索引、instance 渲染，可以自定义 attribute buffer。提供常见几何体构造方法，例如立方体、球体、锥体
5. 支持自定义 shader，支持自定义 uniform
6. 目前只需要先实现 basic 材质，不需要光源，只需要颜色+纹理
7. 实现 tween 动画系统。需要有功能拓展能力，使其能力上越来越接近 gsap。目前 tween 插值支持向量、数字、矩阵、颜色插值
8. 数学库使用 wgpu-matrix
9. 颜色底层使用 sRGB 颜色空间。可以有多个不同的颜色类，比如线性 RGB 颜色、HSL 颜色等，这些类在数据修改后会转成 sRGB，从而引擎直接使用
10. Transform 组件支持位移、旋转、缩放、锚点，右手坐标系。底层都是矩阵描述数据。在操作上支持上层封装拓展。例如可以变成球坐标系，修改数据后会更新 translate 数据。如果 entity 没有添加 transform 组件，那么 transform 的数据默认使用一个单位矩阵。提供一个使用直角坐标系、欧拉角操作 transform 的组件
11. 使用 ECS 架构。ECS 的框架代码在当前目录里的 ecs 文件夹里
12. 引擎对象有自增 ID
13. 创建 rollup 脚手架，TypeScript 编译到 ESNext 标准的 JS。src 里面是项目源码，examples 里面放例子，目前只需要添加一个带纹理的立方体旋转 demo

### API 用法示例

```typescript
const engine = new HaiyueEngine({...options});
const world = new World(); // 容器

const cameraEntity = new Entity(); // 添加相机
cameraEntity.addComponent(new Camera3D({...options}));

const renderSystem = new Render3DSystem(engine, cameraEntity, {...options});
renderSystem.addRenderer(new Mesh3DRenderer(engine, {...options})); // 支持网格渲染

const entity = new Entity(); // 被渲染的物体
entity.addComponent(new Mesh3D(createBox3D({...options}), new BasicMaterial({...options}))) // 添加 geometry 和 material。如果没有 material，默认是一个纯白材质
    .addComponent(new Transform3D({...options}));

world.addEntity(entity).addEntity(cameraEntity);
world.addSystem(renderSystem);

engine.run(); // 开启 requestAnimationFrame
engine.on('update', (time, deltaTime) => {
    world.update(time, deltaTime);
});
```

### 需求实现状态

| 需求 | 状态 | 备注 |
|------|------|------|
| TypeScript | 已完成 | - |
| 3D + 2D 渲染 | 已完成 | 支持 Camera3D(透视/正交) + Camera2D |
| MSAA | 已完成 | 支持 1x / 4x |
| 自定义几何体 + 索引 + 实例化 + 自定义 attribute | 已完成 | Geometry3D 支持自定义/实例属性 |
| 自定义 shader + uniform | 已完成 | 通过 CustomPass 和内嵌 WGSL |
| Basic 材质 | 已完成 | 颜色 + 纹理 + 混合模式 |
| Tween 动画系统 | 已完成 | 支持数字/向量/矩阵/颜色插值 |
| wgpu-matrix | 已完成 | - |
| sRGB 颜色空间 | 已完成 | ColorSRGB + ColorLinear + ColorHSL |
| Transform 组件 | 已完成 | Transform3D + CartesianTransform3D + SphericalTransform3D |
| ECS 架构 | 已完成 | Entity + Component + System + World |
| 自增 ID | 已完成 | IdGeneratorInstance |
| Rollup + 立方体 demo | 已完成 | 15+ 示例 |

### 超出原始需求的额外实现

- Blinn-Phong 光照材质 + 灯光系统（环境光/方向光/点光源）
- 后处理管线（FXAA、高斯模糊、灰度、自定义 Pass）
- 渲染到纹理（RTT）
- 视锥体裁剪
- 轨道控制器（OrbitControl）
- 射线拾取交互系统
- 位图文字渲染（normal/SDF/MSDF）
- 3D 线条渲染
- 网格辅助可视化（AABB/OBB/线框）
- Reverse-Z 深度策略
- 深度材质渲染
- 2D 几何体（矩形/圆/三角/多边形）