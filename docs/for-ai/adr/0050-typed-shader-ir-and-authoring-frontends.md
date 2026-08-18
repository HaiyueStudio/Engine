# ADR 0050：Shader 组合采用 Typed IR 与多 Authoring Frontend

- 状态：Accepted
- 日期：2026-07-27
- 影响：shader 工程化、材质组合、renderer pass parity、未来节点编辑器与多后端可行性

## 背景

引擎当前有 57 个 WGSL 文件、约 3600 行 shader。`WgslFeatureComposer` 已经提供依赖排序、export/binding 冲突、feature key 和源码诊断映射，但组合单位仍然是 WGSL 字符串：资源 binding、stage interface、坐标空间、材质槽位和不同 pass 的变形一致性没有结构化语义。

真实材质需要组合 PBR、normal/UV、Fog、噪声、渐变、shadow、IBL 和自定义变形。仅给 WGSL 增加 import 能减少文件重复，但不能决定 surface hook、资源布局、varying、pipeline variant 或 depth/shadow/motion-vector 的共享逻辑。直接设计一门完整文本语言又会提前引入 parser、formatter、LSP 和第二套语义维护成本。

## 决策

1. 新建仓库根目录 [`shader-language/`](../../../shader-language/README.md)，作为 shader 组合系统的独立规范和后续实现边界。阶段 0 不把它加入 npm workspace，也不增加 engine 公共 API。
2. 唯一规范表示为带类型、stage、坐标空间、资源和 capability 的 Typed Shader IR。TypeScript DSL、Shader Graph JSON 和未来可能的文本语言都是 frontend，不能分别拥有后端语义。
3. 第一个 codegen backend 是 WGSL。GLSL ES 300 仅作为后续可行性目标；它不修改 ADR 0044 的 WebGPU-only 产品契约，也不等价于 WebGL2 renderer fallback。
4. 材质通过稳定 `MaterialSurface` 槽位和命名 hook 组合，节点不能把任意源码插入 entry point。Fog/shadow/IBL 属于 scene feature；多 pass requirement 由 RenderGraph/renderer 安排。
5. morph、skinning、自定义 displacement 与 alpha coverage 的 IR 必须派生 forward、depth、shadow、motion-vector 和 outline/selection 所需程序，不维护每个 pass 的私有变形实现。
6. shader 节点只声明符号资源。logical space 固定为 frame/group 0、object/group 1、material/group 2、pass/group 3；具体 binding、uniform layout、CPU packer 和 reflection 由同一分配结果生成。
7. 配置分为 dynamic、specialization、capability。只有影响 layout/pass/合法性或能删除显著代码的选择才进入静态 variant；compiler 必须报告 variant 来源和数量。
8. Graph JSON v1 是不可信资产，不允许内嵌 WGSL、GLSL 或 JavaScript。受信任扩展使用 typed intrinsic、target source module 或 experimental full override 的分级 escape hatch。
9. Graph format、node type、IR、reflection 和 compiler 分别版本化。对外保存真实 graph 资产前必须另立 ADR 决定迁移支持窗口。
10. 现有 `WgslFeatureComposer` 在 pilot 完成前继续服务生产；新系统先进入 private/experimental 集成，不长期维护同一 renderer 的新旧两套 shader 事实来源。

## 阶段 0 Pilot

阶段 0 固定三个 go/no-go pilot：

1. PBR + normal map + UV noise + world-height gradient + scene Fog；
2. morph + skinning + displacement 在 forward/depth/shadow/motion-vector/outline 的一致性；
3. motion blur resolve/tile-neighbor/diagnostic postprocess。

详细输入、指标和 no-go 条件由 [`shader-language/pilots.md`](../../../shader-language/pilots.md) 维护，并由 `stage0-contract.json` 与 `npm run shader-language:check` 固定结构口径。

## 结果

- shader 工程化的目标从字符串复用提升为类型、空间、资源、variant 和 pass 的统一编译契约。
- TS DSL、节点编辑器和多后端探索可以共享一份 IR，避免三套语义。
- 初期增加 compiler/IR 基础设施成本，但阶段性 pilot 可以在 PBR 全量迁移前给出 no-go。
- WebGL2 仍需要 renderer、resource 和 compute 降级；shader codegen 只解决其中一部分。
- ADR 0017 不被废止：它继续约束当前生产 WGSL 组合，并为阶段 1 迁移提供行为基线。
