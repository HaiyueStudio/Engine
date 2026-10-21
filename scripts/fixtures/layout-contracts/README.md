# G01 合同诊断

本目录只运行既有实现的反例、CPU/结构基线和浏览器几何 oracle，不实现新布局器，也不授予发布资格。

1. `cases.mjs` 固定四项旧 HYA 与新语义对照。
2. `policy.mjs` 校验 G01 配置与诊断产物。
3. `diagnose.mjs` 采集当前源码/构建身份及原始样本。
4. `oracle.html` / `oracle.mjs` 使用真实浏览器计算参考矩形。
5. `policy.test.mjs` 检查反例、配置和不合格产物拒绝。

G04 的 [工作集补充合同](../../../config/region-working-set-022-contract.json)由 `working-set-policy.mjs` 及其测试验证；不改写 G01 冻结配置与历史快照。运行 `node --test scripts/fixtures/layout-contracts/working-set-policy.test.mjs`，生产 1080p 像素与资源对照运行 `node engine/test/render-region-pipeline-gate.mjs --working-set`。

运行命令及证据入口见 [评审结论](../../../review/engine-0.2.2/README.md)。临时转译复用既有 HYA 测试 helper；它只用于诊断，公开包消费由 G10 完成。
