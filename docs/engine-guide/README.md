# Engine Guide

本指南面向通过 TypeScript 使用海月引擎开发游戏的开发者。页面按开发任务组织；完整类型签名请查询 [API Reference](../api/README.md)。

## 快速路径

1. [Getting started](./getting-started.md)：安装、创建第一个 3D 场景并运行。
2. [新用户黄金路径](./consumer-walkthrough.md)：install → render → load asset → animate → dispose。
3. [Render profiles](./render-profiles.md)：选择设备能力和降级策略。
4. [PBR、阴影与环境光](./pbr-rendering.md)：建立默认 3D 渲染产品路径。
5. [点击、拖拽与键盘交互](./interaction.md)：为场景加入拾取、拖拽和动作输入。
6. [后期处理效果](./post-processing.md)：接入、组合和扩展全屏效果链。
7. [glTF 模型、动画播放与切换](./gltf-models-and-animation.md)：加载角色模型并控制动画。
8. [2D 小游戏实战：打砖块](./2d-breakout-game.md)：通过代码搭建场景、编写游戏脚本并响应输入。
9. [3D 小游戏实战：水晶收集](./3d-roll-a-ball-game.md)：逐模块实现 3D 场景、PBR 光照、输入、碰撞和相机跟随。
10. [资产生命周期](./asset-lifecycle.md)：加载、持有和释放资源。
11. [浏览器与设备要求](./browser-requirements.md)：确定支持范围和 fallback。
12. [已知限制](./known-limitations.md)与[故障排查](./troubleshooting.md)：确认刻意上限并收集 issue 信息。

## 功能指南

- [项目脚本运行时](./script-runtime.md)
- [插件开发](./plugin-authoring.md)
- [Device recovery](./device-recovery.md)
- [点击、拖拽与键盘交互](./interaction.md)
- [2D 小游戏实战：打砖块](./2d-breakout-game.md)
- [3D 小游戏实战：水晶收集](./3d-roll-a-ball-game.md)
- [后期处理效果](./post-processing.md)
- [NavMesh 与 RTS 寻路](./navigation.md)
- [2D 物理与可替换后端](./physics-2d.md)
- [3D 物理与 Rapier adapter](./physics-3d.md)
- [游戏存档](./game-saves.md)
- [Haiyue 0.1.0 首发候选说明](./release-notes-0.1.0.md)

## 可运行示例

- `examples/pbr-showcase`：PBR、阴影、环境光和材质变体。
- `examples/gltf-viewer`：glTF 资产加载。
- `examples/interactive`、`examples/box-selection`：3D 点击、Hover 与拖拽框选。
- `examples/orbit-control`：相机 pointer 与触摸手势。
- `examples/postprocess`：内置与自定义后期处理效果链。
- `examples/outline-postprocess`、`examples/sobel-postprocess`：轮廓和边缘效果。
- `examples/toon-layers`：四层 Toon 材质。
- `examples/taa-postprocess`、`examples/motion-blur`：时域抗锯齿和动态模糊。
- `examples/particle-2d`、`examples/particle-3d`：粒子运行时。
- `examples/physics3d-*`：刚体拖拽、关节、浮力、天体引力与布料。
- `examples/consumer-walkthrough`：公共 Engine 安装后的渲染、资产、动画与释放黄金路径。
- `examples/hya-samples`、`examples/hya-state-machine`：HYA Tween/SpriteSheet/Path/Particle 与单素材状态机。
- `games/sokoban-3d`、`games/billiards`：完整 3D/2D 游戏工作流。
- `Games/games/2048`：单槽 LocalStorage 自动存档的产品接入。

能力是否进入 stable 以 [API stability](../for-ai/api-stability.md) 和发布包 exports 为准，不应根据源码目录推断公共 API。
