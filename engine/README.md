# `@haiyue/engine`

海月是面向现代浏览器的 WebGPU-first 2D/3D 游戏引擎。稳定入口提供 ECS、场景、PBR 渲染、资产生命周期、输入、后处理和常用几何能力；高级渲染与诊断协议通过明确的 experimental 子路径隔离。

## 要求

- Node.js 22 或更高版本（构建、测试和发布工具）
- TypeScript 5.2+，`module: "ESNext"`、`moduleResolution: "Bundler"`、`skipLibCheck: false`
- 支持 WebGPU、ES modules、Workers、AbortController 和现代 TypedArray 的浏览器
- 应用需要为不支持 WebGPU 的设备提供产品级不支持页面；当前没有 WebGL renderer fallback

## 安装

```bash
npm install @haiyue/engine
```

## 最小 3D 场景

```ts
import {
  CartesianTransform3D,
  Entity,
  HaiyueEngine,
  Mesh3D,
  PbrMaterial,
  createBox3D,
} from '@haiyue/engine';

const engine = new HaiyueEngine({
  canvas: '#canvas',
  renderProfile: 'batched',
});

await engine.init();

const scene = engine.createScene({ name: 'hello', render3D: true });
const cube = new Entity('Cube');
cube.addComponent(new CartesianTransform3D());
cube.addComponent(new Mesh3D(
  createBox3D(),
  new PbrMaterial({ metallic: 0.2, roughness: 0.6 }),
));
scene.add(cube);

engine.switchScene(scene);
engine.run();
```

`canvas` 可以是 `HTMLCanvasElement`、裸元素 ID 或 CSS selector。`renderProfile: 'batched'` 是普通产品默认路径；可选能力会经过协商并产生明确的降级报告。

初始化失败时用 `HaiyueEngine.webGpuCompatibility.classifyError(error)` 区分 unsupported、adapter unavailable 与 context unavailable，再用 `renderPage()` 显示统一阻塞页面。其他 `EngineError` 保留稳定的 `code`、`path`、`hint`、`docsPath` 和 `context`；不要只匹配 message。

## 稳定入口

- `@haiyue/engine`：普通游戏黄金路径
- `@haiyue/engine/assets`：资产加载与生命周期
- `@haiyue/engine/diagnostics`：只读 frame/GPU resource 聚合快照
- `@haiyue/engine/extension-authoring`：独立渲染扩展使用的窄稳定 SPI
- `@haiyue/engine/geometry`：几何生成和处理
- `@haiyue/engine/material`：材质和来源无关的材质描述
- `@haiyue/engine/postprocess`：后处理
- `@haiyue/engine/physics`：可替换物理后端
- `@haiyue/engine/scene`、`/systems`、`/serialization`：场景装配、系统和显式序列化

完整入口以 `package.json#exports` 和构建后的 `.d.ts` 为准；[API Reference](https://github.com/HypnosNova/HaiYue/tree/main/docs/api) 只提供索引，不复制 declaration。

`@haiyue/engine/experimental` 及其细分入口不提供与 stable API 相同的兼容承诺。包内未由 `package.json#exports` 声明的文件属于私有实现。

## 生命周期

场景切换使用 `engine.switchScene(next, { destroyPrevious: true })`。应用退出时调用 `engine.destroy()`，使 active scene、资产 owner、GPU 资源和监听器按所有权一起释放。

完整指南、浏览器支持矩阵、示例和 API 稳定性规则位于项目仓库的 `docs/engine-guide`、`docs/api` 与 `docs/for-ai/api-stability.md`。

从安装到资产加载、动画和释放的可运行路径见 [consumer walkthrough](https://github.com/HypnosNova/HaiYue/blob/main/docs/engine-guide/consumer-walkthrough.md)。支持上限和故障信息见 [known limitations](https://github.com/HypnosNova/HaiYue/blob/main/docs/engine-guide/known-limitations.md) 与 [troubleshooting](https://github.com/HypnosNova/HaiYue/blob/main/docs/engine-guide/troubleshooting.md)。

Repository：[HypnosNova/HaiYue](https://github.com/HypnosNova/HaiYue/tree/main/engine)。

## License

[MIT](./LICENSE)
