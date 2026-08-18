# 阶段 1：Composer 2.0 基础层

阶段 1 把阶段 0 的模块、资源 ABI、变体和 reflection 契约变成可执行的 private workspace，但不宣称完整 Typed Shader IR 已完成，也不迁移生产 renderer。

## 已实现

- `defineShaderModule()`：声明 stage、依赖、导入/导出符号、资源、capability、specialization 和 entry point。
- `composeShaderModules()`：确定性拓扑链接、同名逻辑符号隔离、requires/provides/conflicts 与 stage/profile/target 校验。
- 符号资源分配：`frame/object/material/pass` 固定映射到 group 0–3；内置 ABI 可保留固定 binding，扩展资源确定性自动分配。
- uniform 单一布局源：同一次布局计算生成 WGSL struct 与 reflection offset/size。
- specialization：进入生成源码、canonical hash 和 variant key；普通运行时 uniform 值不进入 key。
- reflection v1 与 module-to-generated-source map，可把浏览器编译信息映射回模块源码。

模块源码必须通过受控 context 取得物理符号、资源和 specialization 名称。模块内直接写 `@group`/`@binding` 会得到分类错误；这使当前 PBR skinning 通过 `.replace()` 改 binding 的做法可以在后续 pilot 中由资源声明替代。

## 边界

- 当前 source factory 仍负责一个模块内部的 WGSL 函数体，是从字符串 feature composer 通向 Typed IR 的过渡层，不是规范 IR frontend。
- 尚未实现表达式级类型系统、坐标空间检查、varying 推导、MaterialSurface lowering、Graph v1 frontend、优化器或 GLSL backend。
- `engine/src/shader/WgslFeatureComposer.ts` 仍是生产事实来源；阶段 1 没有 engine/component 依赖，没有 root/experimental export，也没有 API baseline 变化。
- reflection 供测试和后续 runtime adapter 使用；阶段 1 不在逐帧路径创建 GPU 对象。

权威机器边界见 [stage1-contract.json](./stage1-contract.json)。下一阶段应先实现 typed expression IR 与最小 WGSL backend，再进入 PBR composition pilot；不能把 source factory 继续扩张成另一套字符串宏系统。

## 验证

```bash
npm run typecheck -w ./shader-language
npm test -w ./shader-language
npm run shader-language:check
```

测试覆盖确定性、符号隔离、资源/布局、binding 冲突、capability/stage/target diagnostic、specialization、source map，以及 PBR skinning group 3 bindings 8–10 的无字符串替换 fixture。
