# G06 Deferred 示例入口评审

用户于 2026-09-29 要求优先实现多灯示例。此前 private Deferred installer 不能从跨 workspace 示例导入；本次将 G07 的最小入口集成前移，复用现有 `@haiyue/engine/experimental/renderer`，不新增 package subpath 或 stable root 符号。

## 准入范围

新增 5 个符号：`createDeferredLightingProfile`、`DeferredLightingProfile`、`DeferredLightingProfileOptions`、`DeferredLightingDebugChannel`、`DeferredLightingDebugImage`。聚合 experimental 按现有门禁同步 re-export。focused 已评审数 51→56，aggregate 855→860；增长储备比例、运行性能、Shader/包体预算保持原值。API candidate diff 已核对只有这两入口各新增同样 5 个符号，无删除、stable/root/package graph 变化。

- 显式异步 factory，`reference`/`tiled` 两模式，`AbortSignal` 支持；strict 初始化失败不伪装 Deferred 成功。
- 隐藏 backend、GPU buffer/texture/bind group；snapshot 返回复制的普通数值结构。帧内不读取 GPU。
- 主动 `readDebug()` 读取最新记录视图；同一 handle 最多一个读回，资源在 finally 清理。过期 handle 返回 null；旧 handle dispose 不影响后继 profile。
- G-buffer 图、原始深度和 tile 图是主动诊断数据；readback 额外成本不得混入正式性能结论。full-list 回退使用粉色，包括 overflow/未存储块。
- scene/system 继续拥有 backend 生命周期。无需引入 UI/Editor 依赖，不修改 ABI、shader 或材质语义。

## 验证边界

单位测试覆盖预先取消、非法 mode、旧 handle 与后继 profile 隔离；浏览器验证实际灯数/像素、读回和切换。示例接口不是 G05 性能豁免，G07 仍需 clean candidate 发布验收。
