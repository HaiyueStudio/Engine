# 新用户黄金路径：安装到释放

这条路径只依赖首发公共包 `@haiyue/engine`，覆盖安装、渲染、加载资产、逐帧动画和释放。完整可运行源码是 manifest 中的 [`example:consumer-walkthrough`](../../examples/consumer-walkthrough/)，文档不维护第二份实现。

## 1. 创建项目

使用 Node.js 22 或更高版本和 TypeScript 5.2 或更高版本。TypeScript 配置采用 `module: "ESNext"`、`moduleResolution: "Bundler"` 和 `skipLibCheck: false`。

```bash
npm create vite@latest haiyue-hello -- --template vanilla-ts
cd haiyue-hello
npm install
npm install @haiyue/engine
```

在 `index.html` 中保留一个 Canvas：

```html
<canvas id="canvas"></canvas>
```

将需要的图片放在应用自己的静态资源目录；不要从 Haiyue 包内部路径引用文件。开发服务器和生产部署都必须通过 HTTP(S) 提供页面与资源，不能使用 `file://`。

## 2. 初始化、加载、动画和释放

可运行实现位于 [`examples/consumer-walkthrough/main.ts`](../../examples/consumer-walkthrough/main.ts)。它只从 stable 入口导入 API：

```ts
import {
  BasicMaterial,
  CartesianTransform3D,
  Entity,
  HaiyueEngine,
  Mesh3D,
  createBox3D,
} from '@haiyue/engine';

const engine = new HaiyueEngine({ canvas: '#canvas', renderProfile: 'batched' });
await engine.init();

const texture = await engine.assetManager!.loadTexture('/checker.png', {
  mipmaps: 'generate',
});
const transform = new CartesianTransform3D();
const cube = new Entity('Cube');
cube.addComponent(transform);
cube.addComponent(new Mesh3D(
  createBox3D(),
  new BasicMaterial({ texture: texture.value }),
));

const scene = engine.createScene({ name: 'Hello', render3D: true });
scene.add(cube);
engine.switchScene(scene);
engine.on('update', ({ detail: { time } }) => {
  transform.setRotation(0, time * 0.0006, 0);
});
engine.run();

window.addEventListener('beforeunload', () => {
  texture.release();
  engine.destroy();
}, { once: true });
```

资产句柄由获得它的作用域释放；`engine.destroy()` 停止帧循环并释放 active scene、GPU owner 和 Engine 监听器。切换关卡时优先使用 `engine.switchScene(next, { destroyPrevious: true })`，不要只从 World 移除实体却长期保留旧场景资源。

## 3. 处理不支持环境

`engine.init()` 失败时先调用 `HaiyueEngine.webGpuCompatibility.classifyError(error)`。返回报告后使用 `renderPage()` 展示统一的 WebGPU-only 阻塞页面；返回 `null` 时按普通应用错误处理。稳定错误包含 `code`、可选 `path`、`hint` 和 `docsPath`，报告 issue 时不要只截取 message。

WebGPU、浏览器和 secure-context 要求见[浏览器与设备要求](./browser-requirements.md)，常见部署与运行问题见[故障排查](./troubleshooting.md)。

## 4. 在仓库中验证同一实现

```bash
npm run typecheck -w ./examples
npm run build:target -- example:consumer-walkthrough
npm run preview:target -- example:consumer-walkthrough
```

预览命令默认输出 `http://127.0.0.1:8080/examples/consumer-walkthrough/`；通过 `PORT=9090` 可以覆盖端口。发布目录位于任意 base path 时，应用资源应使用 `new URL(relativePath, import.meta.url)` 或由宿主明确注入的绝对 URL，不能假定部署在 `/`。
