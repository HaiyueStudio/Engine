# ADR 0016：Scene Render Environment 帧快照

- Status: Accepted
- Date: 2026-07-17

## Context

Fog 接入后，Render3D、InstancedMesh3D 与 Blinn-Phong 分别遍历 World 来选择 Fog、environment light、shadow light 和普通灯光。选择规则与遍历时机不一致，并且每增加天空、曝光、天气或探针都会继续增加独立扫描。

## Decision

1. 环境收集由 `SceneRenderEnvironment` 内部帧服务统一负责，缓存键为 `FrameData + World + frameId`。
2. 环境服务直接消费 World 在 entity/component add、remove 时增量维护的构造器索引，只访问 Fog、EnvironmentLight 与 LightComponent 候选集合，禁止退回 `World.entities` 全量扫描。后续渲染系统得到同一个 frame-local snapshot，下一次 `FrameData.begin()` 自动失效并重建。
3. snapshot 统一选择第一个层级可用且未禁用的 Fog、EnvironmentLight 和投射阴影的 DirectionalLight。阴影光占用灯光表第一项，其余有效灯光按 World 稳定顺序填充到统一上限。
4. Render3D、InstancedMesh3D 和 Blinn-Phong 禁止自行全量扫描环境。Blinn-Phong 在实际 render callback 中消费同一灯光数组，不在 World update 阶段提前采集。
5. snapshot 是 internal/experimental 帧数据，不进入 stable 普通用户 API。它只在当前 frame id 内有效，消费者不得跨帧保存。

## Consequences

PBR、Blinn-Phong 和 Instanced 对 Fog、灯光禁用、阴影优先级与数量上限使用相同规则。环境收集成本由 World 实体总量降为相关组件候选量。以后增加天空、曝光、天气和 reflection probe 时扩展索引查询、一个帧服务与 snapshot，而不是为每个 renderer 增加新的 World 扫描。环境数据仍保持 CPU frame-local，不引入 Scene 持久化状态或 GPU 资源所有权。
