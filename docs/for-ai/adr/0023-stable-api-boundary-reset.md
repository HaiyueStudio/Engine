# 0023：稳定 API 边界重置

- 状态：Accepted
- 日期：2026-07-18

## 背景

ADR 0003 建立 stable、experimental、internal 三层后，后续资产、可观测性、ECS 空间索引和渲染诊断能力仍逐渐进入 `/core`、`/assets`、`/ecs`、`/scene` 或默认根入口。仅比较 API baseline 能发现变化，却不能阻止一次 `api:update` 把实现细节永久批准为 stable；公开类成员也可能通过返回类型绕过入口导出检查。

项目尚无历史业务兼容负担，此时应一次性重设长期稳定边界，而不是保留 deprecated 转发层。

## 决策

1. 默认根入口只聚合普通游戏黄金路径。序列化是显式选择的基础设施，只从 `@haiyue/engine/serialization` 导入。
2. `/core` 只保留 Engine、生命周期、事件、插件能力协议、声明式 RenderProfile 和 RenderView。GPU resource tracker、frame diagnostics、plugin host 实现、能力协商实现与设备断言 helper 移到 `/experimental`；这些实现也不得作为 `HaiyueEngine/IEngine` 的公开属性泄漏，统一由 experimental accessor 获取。
3. `/assets` 只保留 AssetManager、AssetJob/owner 和高层 KTX2 loader。cache、scheduler、parser、worker client/source 与 KTX2 inspect/prepare/upload 移到 `/experimental`。
4. `/ecs` 只保留 Component、Entity、System、World、Query 和无缓存层级查询。ID allocator、层级帧缓存及 SpatialIndexService 移到 `/experimental`。
5. `/scene` 不暴露 preset/system-plan/normalization 实现，也不公开 RenderPipeline、RenderIntegration、registry 或 plugin host getter；`/systems` 不暴露 Render3D frame-plan 类型。底层读取使用 experimental 函数，不在 stable class 上保留 getter。
6. 同仓调用方原子迁移；editor 对 experimental 的使用继续经 `engine-adapter` 隔离。不提供旧入口 re-export、deprecated alias 或兼容 getter。
7. API 门禁为每个 stable entrypoint 固定重置后的符号数上限，并检查 experimental-only 符号、根入口 serialization 泄漏以及 stable 声明类型泄漏。`api:update` 只能接受预算内的已评审变化；stable 增长必须同时修改本 ADR 的后继决策或新 ADR。

## 稳定表面预算

预算按 API manifest 中 value/type export 条目计数：默认入口 380，assets 22，color 16，components 86，compute 7，controls 7，core 65，ecs 18，font 13，geometry 43，gui 69，input 3，lighting 15，material 54，math 7，physics 16，postprocess 19，rtt 5，scene 16，serialization 13，systems 28，tween 19。

`experimental` 不设数量上限，但每次变化仍必须更新 baseline，确保评审能看到扩张或删除。

## 后果

- 普通用户不会在自动补全中遇到 cache、worker、allocator、诊断快照和内部调度计划。
- 高级调用方有单一、明确但不承诺兼容的 experimental 入口。
- stable 新增不再能仅靠重写 baseline 静默进入；需要显式预算和架构评审。
- 这是有意的破坏式重置。仓库内调用方与模板同时迁移，旧导入路径立即失效。
