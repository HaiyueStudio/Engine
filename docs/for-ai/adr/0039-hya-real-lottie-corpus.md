# 0039：HYA 质量与性能由固定真实 Lottie 语料共同度量

- 状态：Accepted
- 日期：2026-07-22

## 背景

HYA 的目标是把常见动效素材转换为更适合 Web 加载和解析的运行时格式。合成 fixture 可以验证 codec 和局部语义，但无法回答三个产品问题：转换是否保留了真实素材的画面、体积是否真正下降、格式收益是否能在浏览器首帧兑现。

只记录“转换成功”也不充分。转换器可能跳过 layer 或静默降级；只选当前支持的素材则会让数据失去发现能力缺口的价值。

## 决策

HYA 建立版本化的真实 Lottie 语料和同源报告：

1. 语料必须来自许可明确、可固定到完整 revision 的上游，并为每个输入和参考帧保存 SHA-256；缓存不是来源真相。
2. 语料同时保留 supported、degraded、unsupported 三类产品预期，仪表盘不得隐藏红色样本。
3. 同一报告必须包含 fidelity、raw/gzip size、source-to-runtime parse 和 warm-adapter first-frame 四类指标。
4. fidelity 使用来源方参考 PNG；WebGPU 输出必须从当帧 GPU texture readback，不能依赖呈现后的 canvas 截图。
5. 转换 diagnostics 与 layer coverage 是 fidelity 之外的一等证据，不能被单个聚合分数替代。采集器必须扫描源 Lottie 的实际特性，并把每条 diagnostic 按 JSON path 和 code 唯一归入一个 feature bucket；无法分类的诊断单独计数且基线要求为 0。
6. 报告记录语料 revision、Git revision、Node、浏览器和 GPU adapter。不同环境的绝对性能值不直接比较。
7. 初期报告作为可追溯观测基线。只有积累同环境历史分布后，才按 feature/expectation 建立 release regression budget。
8. AE 参考 PNG 使用透明背景。基准场景必须显式设置透明 clear color，不能依赖会被 scene defaults 覆盖的 engine 默认值。
9. feature 的 observed fidelity loss 只用于排序相关性，不能宣称单个 feature 对像素误差具有因果关系。

## 结果

- 格式、转换器和 WebGPU runtime 的退化可以在同一素材 ID 上定位。
- size/parse 的局部收益不会掩盖画面丢失，反之亦然。
- 新增 Lottie 能力时，需要把代表性真实素材和参考帧加入固定 manifest，而不是只增加合成单测。
- 上游素材不提交到仓库；manifest 和生成报告提交，从而兼顾许可证、仓库体积与可复现性。
- 报告同时保留 sample 级 `featureAnalysis` 和跨样本 `featureSummary`，可以从低分素材下钻到具体 feature、diagnostic code 与源 JSON path。
