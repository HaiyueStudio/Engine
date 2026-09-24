# ADR 0106：0.2.0 能力范围与包体预算

- 状态：Accepted
- 日期：2026-09-23
- 部分替代：ADR 0101 中虚拟摇杆仅作为后续 minor 候选、不进入当前冻结发布的限制。
- 延续：ADR 0085 的能力归因预算模型、ADR 0105 的 Engine 独立发布范围。

## 决策

用户明确将音频混音、多玩家输入、字体、动画交互和虚拟摇杆纳入本次发布，并选择 0.2.0。
四个公共 npm 包和私有 examples catalog 统一使用 0.2.0；extensions 的 Engine / animation-spec
peer 范围为 `>=0.2.0 <0.3.0`。数据格式、shader artifact 与其他仓库的版本不随之调整。

- 混音与多玩家输入继续通过 Engine 的 `/experimental/audio`、`/experimental/simulation` 暴露，
  纳入发布不等于承诺 stable。兼容聚合 `/experimental` 同步记录导出。
- 字体由现有 `/font`、`/gui` 与 HYA 文本契约承载；动画交互使用 extensions `/animation`。
- 虚拟摇杆使用 stable extensions `/controls`，保持一个类和八个契约类型。
- Engine 根入口仍精确为 30 个符号。仅刷新受影响入口的已审查数量，沿用原 growth reserve 规则。
- 包体容量按照实际 dist-only npm tarball 和实际消费端测量重新归因，新增六个消费端 fixture。
  接受完整动画文本能力所需的 OpenType 解析成本；当前静态依赖会进入 Animation2D / HYA 状态机
  消费端，即使具体文档不含文本也会承担这部分下载成本。未来拆分应单独评审加载契约。
- Engine 根入口、原有其他 focused consumer、Shader Language、CPU/GPU、设备矩阵的限制不变。
  本次能力准入不能用来放宽未归因的 Shader 成本超限或替代真实设备证据。

## 依据与验证

数值、测量方法、储备及剩余发布阻塞见 [0.2.0 预算评审](../../../review/release-0.2.0-capability-budgets.md)。
运行 API、scope、package policy、dist-only packed consumer、类型与功能测试；本次决策不是发布授权或发布成功记录。
