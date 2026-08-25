# 可变形 2D 能力与缺口矩阵

本矩阵区分四个事实维度：`contract` 表示 source-neutral ABI 已冻结，`candidate` 表示当前实现存在，`covered` 表示固定许可语料已观察并通过验收，`unsupported` 表示该 profile 明确拒绝。`candidate` 不能替代真实语料证据，`not-covered` 也不等于 runtime 不支持。

| 能力 | Contract | 当前实现 | 固定语料覆盖 | G01 结论 / 后续 owner |
| --- | --- | --- | --- | --- |
| Stable drawable identity、topology、UV、indices | v1 required | candidate | HaiYue mascot | G02 codec/parser 验收 |
| Frame-major vertex position 与 opacity | v1 required | candidate | HaiYue mascot | G02/G03 验收 |
| Step render order、visibility via opacity | v1 required | candidate | HaiYue mascot | G03 验收 |
| Multiple textures | v1 required | candidate | 官方本地 case 待跑 | G07 |
| Alpha mask references / inverted mask | v1 required | supported | `covered`：Rice `19/5`、Mao `65/10` | G10/G12 complete；数字分别为 mask references / inverted consumers |
| `normal` drawable blend | v1 required | candidate | HaiYue mascot | G03 |
| `additive` drawable blend | v1 required | supported | `covered`：Rice `21`、Mao `15` | G11/G12 complete |
| `multiplicative` drawable blend | v1 required | supported | `covered`：Mao `8` | G11/G12 complete |
| Motion3 Linear/Bezier/Stepped/InverseStepped sampling | capture recipe | complete | synthetic sampler + local Miku action set | G06 complete；更多正式 corpus 归 G07 |
| 多动作枚举、同实例 clip range 与 cross-fade pose | runtime pose port | complete | focused mixer + Chrome action smoke | G04 complete；公共 state-machine facade 由 G09 接线 |
| Adaptive sampling、quantization 与 dirty-channel attribution | internal conversion contract | complete | analytic deformation | G05 complete；HYDM v1 仍使用 dense frame pool |
| Deterministic package/provenance/transaction owner | internal conversion contract | complete | fake adapter + abort/hash/rollback | G05 complete；公共 CLI facade 由 G09 接线 |
| Multiply drawable color | HYDM 1.2 drawable RGBA channel | supported | `covered`：Mao `54` 个非中性 drawable-frame（`Idle:0`，1s） | G13/G15/G16 complete；代表 `ArtMesh82=[0.980392,1,0.427451,1]` |
| Screen drawable color | HYDM 1.2 drawable RGBA channel | supported | `covered`：Mao `38` 个非中性 drawable-frame（`Idle:0`，1s） | G13/G15/G16 complete；代表 `ArtMesh194=[1,0.454902,0.513726,1]` |
| Drawable culling | HYDM static back-face flag | supported | `covered`：Rice `9` 个非退化且镜像翻转绕序的 drawable（`Tap@Body:0`，0.75s） | G14/G16 complete；代表 `ArtMesh161` 从 23 CCW 翻为 23 CW |
| Expression/Pose/Physics build-time composition | clip-baked evaluator recipe | candidate | synthetic controlled evaluator | G06 complete；调用者必须提供许可合规且声明 capability 的 Core/Framework evaluator，正式真实覆盖归 G07 |
| Runtime parameter、lip-sync、eye/look input、MotionSync | 不属于 clip-baked | unsupported | 不适用 | 需要独立 parameterized ADR |
| Cubism deformer/glue/parameter graph authoring | 不属于 runtime IR | unsupported | 不适用 | 不进入 M05 |
| WPK / `.cmo3` 输入或无损回写 | 非 canonical | unsupported | 不适用 | 不逆向、不解密 |

## Feature taxonomy

- `geometry`：drawable identity、topology、UV、index、vertex position、canvas/coordinate normalization。
- `drawable-channel`：opacity、render order、visibility、multiply/screen color、culling。
- `composition`：texture sampling、normal/additive/multiplicative、mask group/inversion、draw order。
- `source-evaluation`：Motion、Expression、Pose、Physics、parameter update order、external input。
- `delivery`：sampling、quantization、binary layout、integrity、determinism、package/runtime closure。
- `lifecycle`：abort、late result、reimport、resource replacement、device recovery、destroy。

## Promotion rules

1. Schema/codec unit test 只能把能力标成 `candidate`。
2. `covered` 要求许可明确的真实 source、固定 revision/hash、官方 evaluator reference、同时间/viewport/color 配置的 HYA GPU readback和零未分类失败。
3. Dashboard 的 `not-covered` 必须保留到实际 feature observation count 大于零；不得根据代码枚举直接改成 `supported`。
4. normal 模式只能对已分类、可定位的有损项给 warning；strict 模式对任何未支持或超过误差的语义失败。

G12 的 mask/blend 机器事实源是 `animation-spec/corpus/deformable2d/feature-corpus-manifest.json` 与
`review/candidates/live2d-mask-blend-corpus-candidate.json`；G16 的 drawable color/culling 事实源是
`animation-spec/corpus/deformable2d/drawable-color-culling-corpus-manifest.json` 与
`review/candidates/live2d-drawable-color-culling-corpus-candidate.json`。官方 Rice/Mao 原始模型仅由调用者在本地提供，
不会进入 Git、npm 包或公开示例。
