# M05 Live2D corpus license acceptance（2026-08-25）

本记录是 M05 G09 的工程准入证据，不是法律意见，也不扩大任何官方协议授予的权利。

## 接受声明与范围

- 接受主体：当前 HaiyueStudio 工作区使用者。
- 接受时间：2026-08-25（Asia/Shanghai）。
- 用户声明：`已阅读并接受上述协议`。
- 接受的协议：Live2D Free Material License Agreement v1.6（2025-02-03 修订）、Terms of Use for Live2D Cubism Sample Data v1.7（2026-01-29 更新）；Hatsune Miku 另受 Crypton Future Media 的 Piapro Character License 与角色使用指南约束。
- 本次批准范围：调用者提供的本地素材仅用于 HaiyueStudio 内部转换、测试和审查；不提交或再分发原始模型、纹理、`.moc3`、Cubism Core/Framework 或像素 reference。
- 未批准事项：本记录不声明使用主体所属许可分类，不授予公开发布、商业发布、原始素材再分发或把第三方角色作为官方 HaiyueStudio 产品内容的权利；这些用途必须另行复核。

## 官方来源、版本与本地指纹

本地目录使用 `animation-spec/corpus/deformable2d/fidelity-performance-corpus-manifest.json` 的有序路径、字节长度和文件内容聚合算法计算 SHA-256。三套目录的文件数、总字节数、目录 hash 和 manifest 中全部 required-file hash 均精确一致。

| 素材 | 官方来源与版本 | 本地冻结指纹 | Required files |
| --- | --- | --- | --- |
| Hatsune Miku FREE | <https://www.live2d.com/en/learn/sample/hatsune-miku/>；官方页标记 SDK3.3/Cubism3.3，本地包 `ReadMe.txt` 记录 `miku_t01` runtime 于 2020-09-17 导出，`model3.Version=3` | 13 files；4,519,848 bytes；`sha256-0258e3f65e7e3aaf9b4da9912d186b2a5959e221017aed58f2440932793335e2` | 5/5 exact |
| Rice Glassfield - PRO | <https://www.live2d.com/en/learn/sample/rice-glassfield/>；`rice_pro_t03`，本地包 `ReadMe.txt` 记录 2021-06-10 发布，官方页标记 SDK4.0/Cubism4.0，`model3.Version=3` | 10 files；3,152,965 bytes；`sha256-082dea795bfef18b5598f38d40cdadcaee54827146fdec596ecf4ee4e31eedc1` | 5/5 exact |
| Niziiro Mao | <https://www.live2d.com/en/learn/sample/niziiro-mao/>；CubismWebSamples tag `5-r.5`、commit `ed1e0b714826d92469b9e51cacc3346f4e393f03`，官方页标记 SDK5.0/Cubism5.0，`model3.Version=3` | 22 files；4,321,713 bytes；`sha256-1add506bf80e04816f438c36a50d93a4916568dfad8f88daff56e3a75dec5bc9` | 7/7 exact |

Mao 的 22 个文件还与调用者本地保存的官方 CubismWebSamples archive `Samples/Resources/Mao` 逐文件 SHA-256 相同。

## 许可边界复核

- 官方协议：<https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html>。
- Sample Data Terms：<https://www.live2d.com/eula/live2d-sample-model-terms_en.html>。
- Hatsune Miku 追加条款：<https://piapro.jp/license/pcl/summary>。
- CubismWebSamples 许可清单：<https://github.com/Live2D/CubismWebSamples/blob/5-r.5/LICENSE.md>；其中 Mao 和 Rice 被列为 Free Material License 模型。
- Engine tracked-file 扫描未发现 Miku、Rice、Mao 原始目录，或 `.moc3`、`.cmo3`、`.can3` 文件。
- Corpus manifest 保持 `caller-supplied-local-only`、`licensedAssetsBundled=false`、`derivedEvidenceOnly=true`；三套素材均禁止把 raw assets 和 pixel references 作为公开 evidence 分发。

## G09 结论

M05 G09 的“逐项核对 corpus 来源、版本、许可与 hash，并取得使用者接受”准入项通过。该结论只关闭 local-only corpus license blocker；像素 baseline 人工批准、Editor repository-wide gates 与任何发布许可仍是独立门禁。
