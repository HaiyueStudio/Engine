# Live2D/Cubism 许可矩阵

本页是工程处理结论，不替代法律意见。执行者必须阅读并接受对应官方协议；无法确认时保持 blocked，不能由工具代替用户点击同意或推断再分发权。

| 对象 | 官方许可/来源 | HaiYue 允许用途 | Git/npm/CI/公开站点 | 结论 |
| --- | --- | --- | --- | --- |
| Cubism Core for Web | Live2D Proprietary Software License；官方说明 Core 不在 GitHub 发布 | 用户接受许可后，本地 build-time drawable capture | 禁止提交、镜像、缓存或进入公开 playback bundle | caller-supplied optional integration |
| Cubism Web Framework / Samples code | Live2D Open Software License / 仓库 `LICENSE.md` | 可作为本地官方 evaluator reference；若引入代码需保留许可并单独评审 | M05 当前不复制，不进入 runtime | external reference only |
| Haru、Hiyori、Mao 等官方模型 | Live2D Free Material License + Cubism Sample Data Terms | 已接受许可的本地转换、测试与审查 | 原始模型/纹理/Core 不提交；只保存 URL、revision、hash 和允许的统计 | local-only corpus input |
| HaiYue mascot capture fixture | HaiYue 原创，MIT | codec、runtime、公开示例与测试 | 允许 | redistributable synthetic fixture |
| 用户/第三方模型 | 模型作者与分发平台条款 | 仅在用户声明有权使用时本地处理 | 默认不复制到仓库、npm、CI 或公开示例 | caller-responsible / no redistribution |
| WPK、`.cmo3`、受保护容器 | 容器/作者条款不确定 | 仅接受使用者已授权导出的官方 runtime asset set | 不提交解包器、密钥或 payload | unsupported canonical input |
| 转换后的 HYA/HYDM、报告和 pixel diff | 同时受源素材和工具许可约束 | 仅在源许可允许的范围内保存/分发 | manifest 必须逐项声明；不确定时只保留 hash/数值 | per-source review required |

## 固定官方 corpus 许可策略

G01 固定 Live2D 官方 `CubismWebSamples` tag `5-r.5`（commit `ed1e0b714826d92469b9e51cacc3346f4e393f03`）中的 Haru、Hiyori 和 Mao。官方仓库 `LICENSE.md` 将这些模型列入 Free Material License；官方协议同时规定默认不得再分发 Material。因此：

1. manifest 固定官方 URL、tag、commit、archive SHA-256 和每个模型目录聚合 SHA-256；
2. 仓库不保存模型文件、纹理、`.moc3`、Motion3 或 Core；
3. 同步必须由已阅读并接受协议的用户显式执行，本阶段不提供自动下载/接受；
4. candidate evidence 优先保存结构化统计和 hash；截图或 pixel diff 只有在具体使用条款确认允许时才提交；
5. 企业发布或公开部署必须重新审查相应 Core publication/release 条款，不能沿用本地研发结论。

## 官方来源

- <https://github.com/Live2D/CubismWebSamples/blob/5-r.5/LICENSE.md>
- <https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html>
- <https://www.live2d.com/eula/live2d-sample-model-terms_en.html>
- <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- <https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/>
