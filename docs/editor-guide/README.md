# Editor Guide

本指南面向使用海月编辑器创建场景、管理资源、调试和导出项目的开发者，不要求理解编辑器内部 Store、CommandBus 或引擎渲染协议。

## 快速路径

1. [启动编辑器](./getting-started.md)
2. [核心工作流](./core-workflow.md)
3. [场景、实体与组件](./scene-entities-components.md)
4. [Play、调试与导出](./play-debug-export.md)
5. [使用编辑器搭建 Tetris](./tetris-tutorial.md)

## 首发应用边界

- 本目录描述 Scene Editor：创建、保存、Play、调试和导出场景项目。
- HYA 2D/原生 3D authoring 使用 [AnimationEditor 设计师指南](../../AnimationEditor/DESIGNER_GUIDE.md)。
- Voxel Web/PWA 与 Electron preview 使用 [`voxelEditor/README.md`](../../voxelEditor/README.md)；Electron 首发仅为 unsigned preview。
- 三个应用都遵守同一 WebGPU-only compatibility contract；没有 WebGL2 fallback。浏览器和部署问题见[故障排查](../engine-guide/troubleshooting.md)，能力上限见[已知限制](../engine-guide/known-limitations.md)。

## 编辑器区域

- **Hierarchy**：浏览、搜索和组织实体层级。
- **Systems**：查看并添加场景系统。
- **Viewport**：选择对象，使用位移、旋转和缩放 Gizmo。
- **Resources**：管理 Geometry、Material、Texture、Model、Prefab 和 Script。
- **Inspector**：编辑当前实体、组件和全局设置。
- **Play**：在设备视口中运行场景，并查看运行时 Inspector、性能和日志。

引擎代码开发请转到 [Engine Guide](../engine-guide/README.md)；类型和错误码查询请转到 [API Reference](../api/README.md)。
