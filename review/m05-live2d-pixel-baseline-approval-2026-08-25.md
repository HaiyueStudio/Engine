# M05 Live2D pixel baseline approval（2026-08-25）

状态：`approved`。本记录是 M05 G09 的人工像素 baseline 批准回执，不修改历史 candidate 的生成 provenance，也不批准发布受许可限制的 source model 或 pixel reference 图片。

## 批准声明

- 批准主体：当前 HaiyueStudio 工作区使用者。
- 批准时间：2026-08-25（Asia/Shanghai）。
- 用户声明：`批准像素 baseline`。
- 批准范围：M05 `clip-baked` profile 的 Miku FREE、Rice Glassfield PRO、Niziiro Mao 官方 reference 与 HYA WebGPU readback 数值 baseline。
- 固定配置：Chrome 151、Windows、native ANGLE D3D11、NVIDIA Pascal、719×694 viewport、719×746 canvas、`rgba8unorm`、无浏览器颜色空间转换、premultiplied alpha、WebGL antialias 关闭、bounds-centered fit 0.82、同步视图。
- 固定阈值：1 px silhouette spatial tolerance；`maxChannelError <= 224`、`meanAbsoluteError <= 1`、`mismatchRatio <= 0.025`。

## 批准结果

下表使用 1 px spatial tolerance 后的数值；原始无 spatial tolerance 的数值仍保留在 candidate，不被覆盖或删除。

| Sample / feature population | Max channel | MAE | Mismatch ratio | Stable-interior max | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| Hatsune Miku FREE / primary G07 | 140 | 0.428385 | 0.020148 | 13 | approved |
| Rice Glassfield PRO / primary G07 + color/culling | 99 | 0.131201 | 0.006920 | 7 | approved |
| Rice Glassfield PRO / mask + additive | 97 | 0.155346 | 0.008123 | 8 | approved |
| Niziiro Mao / primary G07 + mask/blend + drawable color | 145 | 0.152207 | 0.007988 | 8 | approved |

所有批准值均低于冻结阈值。Mask/blend 与 drawable-color/culling corpus 的 `unclassifiedFailureCount` 均为 0。Miku primary G07 按 manifest 显式跳过 recovery smoke；本批准不把该项改写为已执行，lifecycle/recovery 继续由其他样本和独立 WebGPU gates 覆盖。

## 不可变 candidate 绑定

| Candidate | Clean evidence revision | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `review/candidates/live2d-g07-local-fidelity-report.json` | `5836c9828bc00187ca1e77a159b7cf55000de3f2` | 53,915 | `d85eabde90b316e0fb29b007205d3ef1c520a4c5d95050c5cf883025039d30ce` |
| `review/candidates/live2d-mask-blend-corpus-candidate.json` | `1217284cc4622f0885161dc5e933ae92674d9d02` | 18,115 | `aafa7910af4d3f9c0eefed4e59ef85240d016c2be5ca3d67d473fb0b0b2a8736` |
| `review/candidates/live2d-drawable-color-culling-corpus-candidate.json` | `41ae2b4c44f6d523b2cd458675f8bc07929f1e25` | 81,223 | `e0cfa5fa0aad3eb71e78ba42a747d5e5e5010afc09afaae23fa37fbf619b4853` |

三份 candidate 均记录 `dirty=false`。其历史 `formalEvidence=false` 字段保持不变，以免批准动作伪装成在新 revision 重新生成；本回执是对上述精确字节和 producing revisions 的人工 promotion 记录。Live2D Framework evaluator 与公共接线已经固化到 Engine `d85a3155647ea308a3783e24e96a374f8036325f`，许可接受记录固化到 `859ee4cdeee9c7d82d89ba0cd516a5fb4fa6ac9c`。

## 失效条件

以下任一变化必须生成新 candidate 并重新人工批准：模型目录 hash 或 recipe、Core/Framework 版本、capture/conversion、HYDM codec、deformable renderer/shader、mask/blend/color/culling 语义、纹理色彩空间或 alpha、fit/canvas/viewport、browser/GPU backend、阈值或 spatial-tolerance 算法。

## G09 结论

M05 G09 的人工像素 baseline 批准项通过。该结论不自动关闭 Editor repository-wide gates，也不授权 push、tag、publish 或分发官方模型/Core/pixel reference。
