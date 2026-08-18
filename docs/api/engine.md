# `@haiyue/engine`

稳定根入口只覆盖普通游戏开发的 30 个黄金路径符号：

| 领域 | 根入口符号 |
| --- | --- |
| Engine 与场景 | `HaiyueEngine`、`HaiyueEngineOptions`、`Scene`、`SceneOptions`、`RenderProfileName` |
| ECS | `Component`、`Entity`、`System`、`World` |
| 错误 | `EngineError`、`EngineErrorCode` |
| 3D | `Camera3D`、`CartesianTransform3D`、`SphericalTransform3D`、`Mesh3D`、`Geometry3D` |
| 2D | `Camera2D`、`Transform2D`、`Mesh2D`、`Geometry2D`、`Material2D` |
| 材质与灯光 | `BasicMaterial`、`PbrMaterial`、`DirectionalLight`、`EnvironmentLight`、`ColorSRGB` |
| 创建与控制 | `createBox3D`、`createPlane3D`、`createSphere3D`、`OrbitControl` |

根入口不是所有 stable API 的聚合 barrel。Fog、PointLight、资源加载、脚本、粒子、特殊材质、渲染系统和底层协议必须从领域子入口导入，例如：

```ts
import { Fog, PointLight } from '@haiyue/engine/lighting';
import { ScriptComponent } from '@haiyue/engine/components';
import { ToonMaterial } from '@haiyue/engine/material';
import { Render3DSystem } from '@haiyue/engine/systems';
```

## 稳定子路径

具体子路径以 [`engine/package.json`](../../engine/package.json) 的 `exports` 为准。主要领域包括：

- `/core`：Engine 生命周期、事件、插件能力、RenderProfile 和 RenderView。
- `/assets`：AssetManager、AssetJob、owner 和高层纹理加载。
- `/diagnostics`：只读、深冻结的 frame/GPU resource 聚合快照。
- `/extension-authoring`：供独立渲染扩展使用的窄 SPI；不聚合 renderer 或 diagnostics 实现。
- `/ecs`：Component、Entity、System、World 和 Query。
- `/components`：全部内置组件，包括脚本、粒子和高级 Transform/Mesh。
- `/geometry`：全部 2D/3D 几何与工厂。
- `/material`：稳定材质、MaterialDescriptor 和材质创建协议。
- `/lighting`：全部灯光与 Fog。
- `/scene`：Scene、公开配置和 pipeline warmup。
- `/systems`：可装配的公开系统。
- `/serialization`：显式选择的序列化协议。
- `/font`：位图字体、SDF 字体构建与解析。
- `/navigation`：地形 NavMesh、按代理半径寻路和动态圆形障碍。
- `/experimental`：低层协议与诊断能力，不保证兼容。

```ts
import { getEngineDiagnosticsSnapshot } from '@haiyue/engine/diagnostics';

const snapshot = getEngineDiagnosticsSnapshot(engine);
console.log(snapshot.frame.cpuMs, snapshot.gpuResources.totals);
```

需要开启采集、owner 追踪、资源明细或 instrumentation 时仍使用 experimental diagnostics；stable 快照不会返回资源句柄、owner identity、label、stack 或写方法。

`/extension-authoring` 只面向扩展实现作者。它提供 command context、device guard、资源估算/记账和共享 renderer resource 能力；普通游戏代码应继续使用 `/core`、`/ecs`、`/components` 等领域入口。

## `HaiyueEngineOptions.canvas`

类型为 `HTMLCanvasElement | string`。字符串可以是裸元素 ID 或 CSS 选择器，且必须解析为 `<canvas>`；无效目标会在构造阶段抛出 `E_WEBGPU_CONTEXT_UNAVAILABLE`，错误路径为 `options.canvas`。

根入口精确名单由 [ADR 0035](../for-ai/adr/0035-root-golden-path-entrypoint.md) 和 `api:check` 双重冻结。精确签名以构建后的 `engine/dist/*.d.ts` 为准；公开声明不得泄漏 private renderer、GPU cache 或内部 frame plan 类型。
