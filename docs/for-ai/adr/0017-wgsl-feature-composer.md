# ADR 0017：WGSL Shader Feature Composer

- 状态：Accepted
- 日期：2026-07-17

## 背景

Fog 最初通过 `source.replace('__FOG_WGSL__', fogSource)` 注入 Basic、PBR、Blinn-Phong 和 Instanced shader。继续沿用这种入口文件私有的字符串模板，会让依赖顺序、重复符号、变体缓存和编译诊断逐渐失去统一约束。

项目没有历史兼容负担，因此不保留 sentinel 替换兼容层。

## 决策

引擎采用轻量 `WgslFeatureComposer` 作为 WGSL 功能组合边界：

1. 每个 feature module 必须声明稳定 id、源码位置、依赖和导出符号。
2. Composer 对依赖执行确定性的拓扑排序，并按 module id 去重；循环依赖、冲突 id 和重复导出直接失败。
3. Feature define 由 Composer 统一生成 WGSL `const`，并进入规范化 feature key。
4. 组合结果保存生成行号到原 WGSL 模块的映射；`GPUShaderModule.getCompilationInfo()` 的诊断必须映射回模块文件与原始行号。
5. Renderer pipeline cache key 必须显式包含组合结果的 feature key，不能仅依靠 primitive/material 状态推断 shader 变体。
6. 禁止在 Composer 之外使用 `replace('__XXX__', source)` 或继续引入 WGSL sentinel。

首批模块为 Fog、morph、skinning、PBR BRDF 和 PBR directional-shadow receiver。后续 clearcoat、顶点动画、阴影算法变体和材质扩展沿用同一协议；本阶段不引入材质图。

## API 分层

Composer 是低层渲染能力，当前只从 `experimental` 入口导出。稳定材质 API 继续暴露渲染能力契约，不暴露引擎内置 feature module 实例。

## 后果

- 相同 feature set 产生确定性的源码和 pipeline key。
- 多个入口依赖同一模块时只包含一次。
- Shader 编译错误能够定位到 Fog、BRDF 等实际模块，而不是合并后不可读的行号。
- 新 shader feature 需要声明依赖和导出，并通过架构门禁，增加少量显式元数据。
