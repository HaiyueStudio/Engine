# Getting started

海月是 WebGPU 3D 优先引擎。公共 consumer 使用 Node.js 22 或更高版本、TypeScript 5.2+、ESNext/Bundler module resolution，并要求支持原生 WebGPU 的浏览器。

```bash
npm install @haiyue/engine
```

仓库贡献者的 clone/build 命令见[从源码运行、贡献与验证](../for-ai/contributing.md)。下面示例要求页面包含 `<canvas id="canvas"></canvas>`，并通过 HTTP(S) 提供。

最小场景：

```ts
import { HaiyueEngine, Entity, CartesianTransform3D, Mesh3D, PbrMaterial, createBox3D } from '@haiyue/engine';

const engine = new HaiyueEngine({ canvas: '#canvas', renderProfile: 'batched' });
await engine.init();
const scene = engine.createScene({ name: 'hello', render3D: true });
const cube = new Entity('Cube');
cube.addComponent(new CartesianTransform3D());
cube.addComponent(new Mesh3D(createBox3D(), new PbrMaterial({ metallic: 0.2, roughness: 0.6 })));
scene.add(cube);
engine.switchScene(scene);
engine.run();
```

`canvas` 可传入 `HTMLCanvasElement`、裸元素 ID（如 `'canvas'`）或任意能命中 `<canvas>` 的 CSS 选择器（如 `'#canvas'`、`.viewport > canvas`、`'[data-render="main"]'`）。以 `#` 开头的字符串直接按选择器解析；其他字符串先按裸 ID 查找，未命中时再按选择器解析。字符串为空、选择器非法、没有命中或命中了非 Canvas 元素时，构造函数会立即抛出带有 `options.canvas` 路径的结构化错误。

`switchScene()` 之后，`run()` 会在每帧自动更新一次 active scene；不要再从 `update` listener 手工调用 `scene.update()`。需要驱动动画时监听 `update`（场景更新前），需要读取渲染后的统计或清理逐帧输入时监听 `after-update`：

```ts
engine.on('update', ({ detail: { delta } }) => animate(delta));
engine.on('after-update', () => collectFrameDiagnostics());
```

切换产品场景时使用 `engine.switchScene(next, { destroyPrevious: true })`。应用退出时调用 `engine.destroy()`；active scene、其资产句柄、GPU owner 和 engine listeners 会一起释放。

首次集成继续完成[资产加载、逐帧动画与显式释放](./consumer-walkthrough.md)，再选择 [`RenderProfile`](./render-profiles.md)，并阅读[浏览器要求](./browser-requirements.md)与[设备恢复](./device-recovery.md)。资产与脚本分别遵守[资产生命周期](./asset-lifecycle.md)和[脚本运行时](./script-runtime.md)。完整产品场景位于 manifest target `example:pbr-showcase`。
