# ADR 0052：预编译 Shader Artifact V2 显式表达多 Group 与 Layout 所有权

- 状态：Accepted
- 日期：2026-07-28

## 背景

ADR 0051 的首个 production slice 只需要把 logical pass group 3 紧凑映射到 physical group 0，因此 V1 runtime 只创建一个 bind-group layout。PBR、deformation 和现有 renderer 已经使用 SceneFrame、RendererObjectTable、material 与 scene 等多个独立 layout；这些 layout 的生命周期和 ABI 由 renderer 子系统所有，shader adapter 不能重复创建或按资源名猜测。

如果 runtime cache 只使用 artifact/pass hash，不纳入外部 layout 身份，两个采用不同 renderer layout 的 pipeline 会错误复用。继续为每个效果编写 binding 名称特判也会把 reflection 再次分裂成多套事实来源。

## 决策

1. 新 production shader 使用 `haiyue-precompiled-shader-artifact` V2；runtime 同时读取阶段 6 的 V1 artifact。
2. 每个 pass 的 reflection 必须列出连续 physical group，以及 logical space/group、physical group、layout owner 和完整 WebGPU binding descriptor。
3. layout owner 只有 `artifact` 与 `renderer`。前者由私有 adapter 创建，后者必须由 renderer 显式注入；缺失时在 GPU allocation 前失败。
4. shader module 按 device/artifact/pass 缓存；artifact-owned layout 按 pass/group 缓存；pipeline layout/runtime 额外包含 renderer-owned layout 对象身份。
5. compiler 和 graph 仍不进入 engine runtime。runtime 不解析 WGSL、资源名或 graph，也不调度 pass。
6. 所有 production generator 进入统一 registry；所有 WGSL、内联 shader site 和 raw escape hatch 进入机器检查的迁移 manifest。
7. CustomPass 与 ComputeKernel 保留显式 raw-WGSL 边界。现有 WgslFeatureComposer 在独立 breaking-change ADR 前不移除。
8. 本阶段不迁移新的 production shader，不修改公共 API，也不更新 API baseline。

## 后果

- 后续 PBR 可以复用 renderer-owned SceneFrame/object/material layout，而不复制其 ABI。
- 外部 layout 变化不会错误命中旧 pipeline，也不会重复创建不受影响的 shader module/layout。
- 新增 WGSL 不再成为未登记事实源；fast gate 会要求明确生成、待迁移或 escape-hatch 状态。
- artifact V2 稍大，但 runtime 不需要正则解析 WGSL，构建产物仍是确定且可审计的。
- compute side effect、PBR、deformation、WebGL2/GLSL 和稳定 shader API 仍需后续独立阶段。

阶段范围和证据见 [shader-language/stage7.md](../../../shader-language/stage7.md)。
