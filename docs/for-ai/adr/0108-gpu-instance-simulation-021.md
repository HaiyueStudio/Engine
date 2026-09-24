# ADR 0108：0.2.1 GPU 实例与模拟接入

- 状态：Accepted
- 日期：2026-09-24
- 依据：用户要求在独立分支开发 0.2.1，先修复引擎问题，再补齐 ParallelLegion 源码审查提出的引擎能力。
- 部分替代：ADR 0106 的 0.2.0 功能冻结范围；保留 stable golden path、能力归因预算与独立发布规则。

## 决策

开发分支为 `release/0.2.1`。工作区包及候选发布清单同步为 0.2.1；不代表发布授权或发布完成。
本次允许的新增范围是 GPU 实例数据、实例 Toon、GPU 三档 LOD、异步计算初始化、读回环与容量检查。
游戏字节码 VM、队列公平性、攻击结算、存档与 CPU 参考解释器仍由游戏负责，不进入引擎。

1. 修复共享 InstancedMaterial 的多消费者脏数据消费错误；私有有界 revision journal 不改变 stable material API。
2. 实例法线通过逆转置方向计算，覆盖非均匀和镜像缩放；保持现有材质 uniform ABI。
3. `/experimental/gpu-driven` 提供借用 GPU 矩阵、颜色、可见 ID 的渲染接口；不回读状态、也不复制到 CPU material。
4. GPU LOD 用包围球投影尺寸、视锥剔除和滞回分桶；可见 ID 保持应用实体身份，计数直接复制到间接命令。每个视图独立 owner，透明排序不适用此路径。
5. 新程序显式 `initialize()`，dispatch 不编译；读回必须在提交后开始，忙时返回 null。取消不提前复用映射或已编码的缓冲。
6. 设备替换后拒绝旧对象/绑定；游戏通过既有 recovery participant 重建资源并恢复确定性检查点。引擎不承诺恢复 GPU 中尚未保存的游戏状态。
7. legacy 实例渲染剔除/排序/间接缓冲按需创建；外部 GPU 数据路径仅拥有材质 uniform 和绑定。
8. 新 LOD shader 进入 typed production compute family，并同步 IR、反射、manifest、生成产物及浏览器验证；ABI 保持 1。

## API 与验证边界

根入口维持 30 个符号，stable compute/material 不增加新符号。聚焦 gpu-driven 入口从 25 到 36：
新增五个运行时类、一个容量检查函数、五个契约类型，其中 renderer 和 render options 是既有接口在聚焦入口的重导出。
遵循现有 focused 入口必须为兼容聚合子集的契约，聚合增加九个重导出（846 → 855）；新调用方仍使用聚焦入口。
只调整上述两个入口的已审查数量；不提高其他 API、CPU/GPU 或包字节阈值。新增声明和拆分 chunk 的文件数量按实际打包值归因，保留原有文件数储备；新 consumer 单独测量设定预算。
Shader 新增一个 LOD pass，源码预算按已测 3,464 B 增量增加，保留原余量；仅增加一个文件/variant/pipeline 名额，详细归因见实施审查。

可运行示例 [gpu-instances](../../../examples/gpu-instances/main.ts) 验证万人实例的 compute → LOD → indirect draw。
实际结果、包测量和未完成的真机资格见 [0.2.1 实施审查](../../../review/engine-0.2.1-gpu-instances.md)。
手机性能资格必须另外用真实手机验证，桌面正确性验证不替代手机帧率、功耗和长时间稳定性结果。
