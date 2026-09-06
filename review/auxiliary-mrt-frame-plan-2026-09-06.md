# 辅助缓冲合并与帧资源依赖验证

日期：2026-09-06。变更直接延续辅助语义、TAA 与统一 HDR 输出工作；设计见 [ADR 0097](../docs/for-ai/adr/0097-auxiliary-mrt-and-frame-resource-dependencies.md)。

## 已实现

- 相同覆盖和排序的深度/法线/运动输出共用一次 MRT 几何 pass，3 次重绘降为 1 次。
- 不需要运动时合并深度/法线；含透明深度写入者时单独保持运动表面。在一个透明前景与不透明背景的用例中，辅助 draw 从未合并的 5 次降至 3 次，pass 从 3 次降至 2 次。
- 深度和法线参数按视图区分，验证同次提交、同尺寸复用下不同相机 near/far 的数值正确。
- 帧计划明确 import/export、读写版本、生产者和依赖，先编译再执行；辅助缓冲为独立的按需节点。导出的显示目标和历史不会被标为瞬态资源。
- shader 来源、反射、8 槽 vertex 布局、CPU 绑定及新扩展合同同步更新；不增加 static pass。历史合同和预算阈值保持不变。

## 性能证据边界

使用共享 real-renderer 场景、GPU 审计及 timestamp probe；`artifacts/webgpu/auxiliary-semantics-diagnostic.json` 保存代码指纹、工作区状态、浏览器/适配器、每个用例的结构计数、CPU 录制、GPU 时间、队列等待、上传及分配。每帧指标在额外像素读取之前采集。

NVIDIA Pascal / HeadlessChrome 152，64×64 单物体稳定 MRT 样本：辅助 pass/draw 均为 1，未合并参考均为 3；整帧含场景、两个选择 mask、灰度、输出共 6 pass / 6 draw。最终诊断样本为 4 次 buffer 上传、672 字节、0 新建 buffer，GPU 表面 pass 约 0.002 ms，整帧 GPU 约 0.024 ms，CPU 录制约 1.32 ms、队列等待约 3.68 ms。资源 owner 释放后残留为 0。

这是像素/结构诊断，不是同工作负载的正式性能前后对比；切换到独立参考 renderer 的首帧包含资源初始化，不能直接比较 CPU/GPU 加速比。运动开启时需要携带 morph normal 属性；没有运动需求时不会为法线创建历史。完整轮廓、主场景以及后处理仍各有其必要绘制。帧计划图元数据按视图编译，未声称 CPU 零分配或纹理显存下降。

## 验证记录

- 仓库 typecheck 通过；仓库测试通过后，最终 Engine 全量 605 项和 shader 全量 112 项再验通过；animation 139、extensions 372、catalog 7 项均通过，合计 1235 项。最终 Engine typecheck 和 59 项重点回归也通过。
- WebGPU 辅助对照共 17 项，覆盖原有 7 项，以及独立深度/法线/运动参考、非均匀缩放、空深度附件、透明深度写入者及双相机范围；TAA 25 项、输出 17 项、多视图 5 帧且 12/12 纹理回收均通过，验证错误为 0。
- 模块边界、责任边界、renderer prepare、docs 和 diff 检查通过。
- Motion 的 stage 10 夹具改用交错 morph 数据和第 8 个法线 buffer，9 个 production pass 的编译和原有像素断言通过。
- `shader-language:check` 和 stage 14 仍被预算阻止：WGSL 357848 > 328000 字节，增长 52344 > 22500，文件增长 2 > 1。本轮相对上轮增加 2421 WGSL 字节，没有放宽统计或预算。
- Stage 9 浏览器夹具仍在既有 Animation2D 用例失败：夹具使用旧 1264 字节/字段偏移及不覆盖 `fs_effect` 的 frame visibility，而当前材质块为 1296 字节且输出语义已有变化。保留原用例和像素标准，仅同步本轮 normal MRT 的目标格式映射；未将其记为通过。

- 仓库 build 的所有基础工作区通过；示例范围为 ambient-occlusion、taa-postprocess、motion-blur、outline-postprocess、normal-material、shader-language-lab、shader-language-character-material，共 7 个示例及 2 个共享目标，9 个目标的 freshness 校验通过。Lab 和 character-material 浏览器验证通过。此处没有执行全部示例构建。
- API 基线仍存在既有的工作区图、audio、simulation、GUI、animation 等符号差异，基线未更新。详见 `artifacts/aux-plan-api.log`。既有平面反射 pass 预算问题未在本轮重跑或宣称解决。

关键日志：`artifacts/aux-plan-build.log`、`artifacts/aux-plan-engine-final.log`、`artifacts/aux-plan-shader-final.log`、`artifacts/aux-plan-typecheck.log`、`artifacts/aux-plan-shader-check.log`、`artifacts/aux-plan-stage14.log`、`artifacts/aux-plan-stage9-gpu.log`。
