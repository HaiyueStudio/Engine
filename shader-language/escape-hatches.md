# Escape Hatch 与受信任扩展

## 原则

系统必须允许高级 shader 实现，但不能重新引入任意字符串插入、隐式 binding 和无法诊断的多后端分叉。escape hatch 按能力由低到高分成三级。

## Level 1：Typed intrinsic/module

首选扩展方式。模块声明完整的 typed signature、stage、space、资源、capability 和纯度，并为每个目标提供实现：

```text
module: company.noise.simplex3d@1
input: position<world, f32x3>
output: f32
targets: webgpu-wgsl, webgl2-glsl-es300
effects: pure
```

Frontend 只看到 typed call；backend 实现可以是手写标准库模块或未来 IR body。缺失目标实现时编译器返回 unavailable diagnostic。

## Level 2：Target source module

用于尚不能由 IR 表达的受信任函数。必须满足：

- 只能由构建代码/受信任插件注册，不能来自 graph JSON 或场景文件；
- 声明稳定 module id/version、导出签名、依赖、资源和目标列表；
- 源码是完整 module/function，不允许插入 entry point 中间的 sentinel/snippet；
- 所有符号经过 namespace/mangle，binding 仍由符号资源 allocator 提供；
- WGSL-only 模块自动使 graph 不满足 `webgl2-compatible`；
- diagnostic/source map 必须映射到 module source。

Level 2 是迁移现有 WGSL 标准库的桥梁，不是长期绕过 IR 类型检查的默认方式。

## Level 3：Full shader override

完整 entry point override 只允许 experimental low-level rendering：

- 调用方显式提供 target source、entry point、reflection/layout 和 pass contract；
- 不获得自动 PBR surface、Fog、shadow、depth、motion-vector 或 WebGL2 支持；
- 不进入 Material Graph 可视化编辑器；
- pipeline key 和 lifecycle 仍必须经过 renderer contract；
- 缺失 reflection 或 reflection 与目标编译不一致时失败；
- 不进入 engine 根黄金路径。

它替代传统 `RawShaderMaterial` 场景，但不能伪装为可组合 material graph。

## 禁止行为

- 在生成源码上执行正则或字符串 `replace` 来迁移 binding、类型或函数体。
- node 自己占用 `@group/@binding`。
- graph/scene JSON 内嵌任意 shader 或 JavaScript 源码。
- backend 缺失实现时返回常量、零值或删除效果。
- raw module 修改 renderer pass、创建 GPU resource 或持有跨 device 生命周期状态。
- 用相同 module id 注册不同签名/源码。

## Portability report

编译结果必须列出每个 escape hatch：

- level；
- module id/version；
- source owner；
- supported targets；
- required capability/resource；
- 是否阻止 portable profile；
- 对 pass parity 的影响。

正式发布的内置 material graph 不允许依赖 Level 3；Level 2 必须有迁移到 IR 或保留的明确理由。
