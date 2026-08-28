# HaiYue Engine

HaiYue Engine 是一个以 WebGPU 为唯一渲染后端、面向现代浏览器的 TypeScript 图形与交互引擎。仓库包含核心运行时、可选扩展、HYA 动画规范、着色器构建工具，以及由清单统一管理的可执行示例。

[在线预览 Examples](https://haiyuestudio.github.io/Engine/examples/) · [引擎指南](./docs/engine-guide/README.md) · [API 文档](./docs/api/README.md) · [浏览器要求](./docs/engine-guide/browser-requirements.md)

## 能力概览

- WebGPU 2D/3D 渲染、Scene/ECS、材质、灯光、阴影、后处理和 GPU compute。
- glTF、动画混合、Spine、Live2D、Lottie 与 HYA 动画播放和离线转换能力。
- 物理、导航、GUI、字体、输入、资源生命周期和设备丢失恢复。
- `@haiyue/extensions` 承载可选、可移除的完整能力，核心包保持稳定且可按子路径加载。
- manifest 驱动的 examples catalog，示例页面同时提供运行效果和对应 TypeScript 源码。

## 快速开始

开发环境需要 Node.js 22 或更高版本，以及支持 WebGPU 的 Chrome/Edge。克隆仓库后执行：

```bash
npm ci
npm run build
npm test
```

只构建并在本机浏览 examples：

```bash
npm run build:examples
node scripts/serve-examples-lan.mjs --http --host 127.0.0.1 --port 8080
```

然后打开 `http://127.0.0.1:8080/examples/`。`localhost` 和 `127.0.0.1` 可作为 WebGPU secure context；局域网设备预览需要受信任的 HTTPS 证书，详见[浏览器与设备要求](./docs/engine-guide/browser-requirements.md)。

## 基础 Demo

页面只需要提供一个 Canvas：

```html
<canvas id="app" width="960" height="540"></canvas>
<script type="module" src="./main.ts"></script>
```

下面的 TypeScript 展示推荐的普通场景生命周期：初始化引擎、创建场景、切换 active scene、逐帧更新并在页面退出时释放资源。

```ts
import {
  BasicMaterial,
  CartesianTransform3D,
  Entity,
  HaiyueEngine,
  Mesh3D,
  createBox3D,
} from '@haiyue/engine';

const engine = new HaiyueEngine({
  canvas: 'app',
  clearColor: { r: 0.025, g: 0.055, b: 0.1, a: 1 },
});

await engine.init();

const transform = new CartesianTransform3D();
const cube = new Entity('Cube')
  .addComponent(transform)
  .addComponent(new Mesh3D(createBox3D(), new BasicMaterial()));

const scene = engine.createScene({ name: 'Hello HaiYue', render3D: true });
scene.add(cube);
engine.switchScene(scene);

engine.on('update', ({ detail: { time } }) => {
  transform.setRotation(time * 0.00035, time * 0.00065, 0);
});

engine.run();
window.addEventListener('beforeunload', () => engine.destroy(), { once: true });
```

完整的资源加载、错误处理和释放流程见 [Consumer Walkthrough](./docs/engine-guide/consumer-walkthrough.md)，对应可执行源码位于 [`examples/consumer-walkthrough`](./examples/consumer-walkthrough/)。普通应用应保持 `init → createScene → switchScene → run → destroy` 的唯一生命周期，不要再手工更新 active scene。

## 在线 Examples

GitHub Pages catalog 会展示当前发布版本中可公开运行的示例，支持按能力分组、iframe 预览和源码查看。可以从这些入口开始：

- [基础 Consumer Walkthrough](https://haiyuestudio.github.io/Engine/examples/#consumer-walkthrough)
- [PBR Showcase](https://haiyuestudio.github.io/Engine/examples/#pbr-showcase)
- [glTF Viewer](https://haiyuestudio.github.io/Engine/examples/#gltf-viewer)
- [Lottie → HYA 对比](https://haiyuestudio.github.io/Engine/examples/#lottie-hya-compare)
- [Live2D → HYA 对比](https://haiyuestudio.github.io/Engine/examples/#live2d-hya-compare)
- [Rive → HYA 左右渲染对比](https://haiyuestudio.github.io/Engine/examples/#rive-hya-compare)
- [Rive → HYA Feature Corpus](https://haiyuestudio.github.io/Engine/examples/#rive-feature-corpus)

在线站点由 [GitHub Pages 工作流](./.github/workflows/deploy-pages.yml)从人工选择并验证签名的 release tag 构建；它不会提交 `dist/` 或 examples bundle 到源码分支。仓库管理员首次使用时需在 GitHub 的 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**，然后运行 `Deploy GitHub Pages` 工作流。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| [`engine/`](./engine/) | 稳定核心、Scene/ECS、WebGPU 渲染与公共 API |
| [`extensions/`](./extensions/) | glTF、动画、Spine、ray tracing 等可选完整能力 |
| [`animation-spec/`](./animation-spec/) | HYA 格式、Lottie/Live2D 转换、viewer 与样例 |
| [`shader-language/`](./shader-language/) | 构建期着色器语言和生产 shader 生成 |
| [`examples/`](./examples/) | manifest 驱动的能力示例与在线 catalog |
| [`docs/`](./docs/) | 用户指南、API、ADR 和维护文档 |

Editor、Games 与其他 HaiYueStudio 仓库只通过打包或发布后的公共 package exports 使用 Engine；跨仓库代码不得导入本仓库的私有 `src/` 路径。

## 开发与验证

按改动范围从小到大运行验证：

```bash
npm run typecheck -w ./engine
npm test -w ./engine
npm run build -w ./engine
npm run examples:catalog:check
npm run check:fast
```

WebGPU、像素和性能改动还需要相应的真实浏览器或设备验证。贡献前请阅读 [`AGENTS.md`](./AGENTS.md) 和[仓库地图](./docs/for-ai/repository-map.md)。

## License

[MIT](./LICENSE)
