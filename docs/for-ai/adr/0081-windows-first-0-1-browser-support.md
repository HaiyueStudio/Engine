# ADR 0081：0.1 首发浏览器支持收敛为 Windows

- 状态：Accepted
- 日期：2026-08-18
- 影响范围：0.1 浏览器支持矩阵、M02 G02/G07、用户支持声明

## 背景

迁移后的开发与发布环境只有 Windows 10 22H2、稳定 Chrome/Edge 和真实独显。`chrome-macos`
仍被列为 required 时，0.1 的发布资格取决于当前无法取得的 Mac，而不是已经声明的 Windows
首发产品边界。集显类别已由 ADR 0080 移出 required correctness；浏览器支持范围也需要与实际
可持续验证的首发平台一致。

## 决策

1. 0.1 required browser 仅包含 Windows 10 22H2 或更高版本上的稳定 Chrome 与 Edge。
2. `chrome-macos` 从 required 调整为 extended，与 Safari/macOS 一样积累兼容性证据，但不阻断
   0.1 发布。
3. Windows required evidence 仍必须使用真实独显和 native WebGPU，并记录浏览器、操作系统、
   adapter/backend、驱动、GPU validation error 与 owner residual。
4. macOS extended 不等于 unsupported；在获得可重复的真实设备 evidence 后，可由后续发布重新
   提升为 required。0.1 文档不得宣称 macOS 已获得稳定支持。
5. 性能、API、制品、供应链、生命周期、像素和内容门禁不因浏览器范围调整而降低。

## 后果

- M02 G02 在 Windows Chrome/Edge 与 Windows discrete 通过时可以达到
  `all-required-evidence-passed`，不再保留设备 handoff。
- G07 仍须在本次支持矩阵提交后的新 clean HEAD 重跑 local/global release gate 与 rehearsal；旧
  revision 的绿色结果不能替代新候选重放。
- macOS CI 或真机结果继续作为 extended evidence 保存，发现 P0/P1 问题时仍需分类和记录。

## 验证

- `node --test scripts/visual-regression/g02-browser-regression-policy.test.mjs`
- `node scripts/verify-m02-g02-candidate.mjs --require-all-devices`
- `npm run render-product:structure`
- `npm run docs:check`

