# 阶段 5：Postprocess Typed IR 与 Motion Blur Pilot

阶段 5 完成 Pilot 3。至此 PBR 组合、多 pass deformation 和 motion blur postprocess 三个迁移试点都已通过，但 `@haiyue/shader-language` 仍是 private workspace；本阶段没有把生产 renderer 或 `MotionBlurPass` 切换到生成代码。

## Postprocess Graph 与单一 Typed IR

[pilot-motion-blur-postprocess.graph.json](./pilot-motion-blur-postprocess.graph.json) 使用 Graph v1 的 `postprocess` kind，并通过逻辑 `pass` resource 描述 color、depth、signed UV velocity、tile-max、neighbor-max、sampler 和 uniform。graph 不携带 binding 数字、WGSL、GPU handle、纹理分配或 RenderGraph 调度代码。

`compileMotionBlurGraphV1()` 将唯一的 `haiyue.postprocess.motion-blur@1` aggregate node lower 到既有 canonical Typed Shader IR 的 postprocess region，不引入第二套 sampler、mixer 或 shader IR。compiler 从该 region 派生：

1. `motion-tile-max`：8×8 tile 最大 signed velocity；
2. `motion-neighbor-max`：3×3 tile 邻域最大 velocity；
3. `motion-blur-resolve`：centered 或稳定 tile/neighbor reconstruction、split 和 velocity heatmap。

三段程序共享同一个 `typedModuleHash`。资源 binding、uniform byte layout、entry point 和 render target class 只通过 reflection 暴露；uniform 继续由公共 packer 写入。

## Compiler 与 RenderGraph 边界

compiler 返回两个声明式 pass plan：

- centered：一个 resolve pass，零个活跃中间纹理；
- tile-neighbor-max：tile、neighbor、resolve 三个 pass，两个活跃中间纹理。

这些 plan 仅描述依赖，`compilerSchedulesPasses` 固定为 false。纹理创建、pass 调度、提交和销毁仍属于 renderer/RenderGraph。为了和当前生产实现保持相同资源预算，centered plan 记录生产路径已有的两个可复用 allocation，但不会执行 tile/neighbor pass。

当前稳定 reconstruction 不读取 depth。graph 仍声明 depth 以保留后续 depth-aware 能力的接口位置，compiler 则显式返回 `pass.depth` 为 eliminated resource；浏览器门禁要求实际 depth texture allocation 为 0。这样不会用无意义采样掩盖真实依赖。

## 动态控制与 ABI

velocity 继续使用生产路径的 signed UV velocity ABI。shutter angle 和 intensity 是两个独立动态量，`maxBlurPixels`、sample count、display mode、split position 也不会扩大 specialization variant；三个派生 pass 对应三个固定 pipeline。

诊断模式保持动态：

- raw/disabled 用于验证关闭路径逐像素不变；
- split 左侧保留 source、右侧显示 blur；
- velocity heatmap 显示方向和速度；
- tile/neighbor reconstruction 只在当前像素近似静止时引入稳定邻域速度，不恢复会随角度跳变的逐像素 5×5 最大速度选择。

## Pilot 3 浏览器证据

运行：

```bash
npm run verify:shader-language-stage5
```

真实 Chrome/WebGPU fixture 通过 HTTP 加载 graph，并同时编译生成 WGSL 与当前生产手写 WGSL 参考。门禁验证：

- 六个 raw/centered/reconstruction/heatmap/split case 的 generated/reference 最大通道差为 0；
- disabled 与输入最大通道差为 0；
- 当前证据中 slow/fast mean absolute delta 为 3.652/14.314，且门禁要求 fast 至少为 slow 的 1.1 倍；
- tile/neighbor reconstruction 改变约 6.20% 像素，固定输入重复结果最大通道差为 0；
- centered 和 tile/neighbor 分别严格执行 1/3 个 pass，活跃中间纹理为 0/2；
- shader generation 只调用一次且不进入 frame path；
- WebGPU validation、unclassified failure 和 owner residual 均为 0。

此外 `npm run verify:motion-blur` 继续验证现有生产示例，证明阶段 5 没有破坏已发布路径。

## 边界与下一步

阶段 5 没有 production migration、GLSL ES 300 backend、通用 postprocess node plugin、可视化 graph editor 或稳定公共 API。三个 pilot 全绿只意味着核心 IR/resource/pass 边界达到 go 决策点；真正迁移前仍需单独设计 renderer adapter，并用生产场景对照、首帧、pipeline cache、draw/pass/upload 和设备证据决定逐块迁移顺序。

权威机器范围见 [stage5-contract.json](./stage5-contract.json)。
