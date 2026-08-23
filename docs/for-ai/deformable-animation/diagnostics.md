# 可变形 2D 转换诊断目录

## Policy

- 所有 source/capture/HYDM 失败必须包含稳定 code 和 JSON/binary path。
- normal 模式只允许已分类 warning；strict 模式把任一 fidelity warning 转为失败。
- `unclassifiedFailureCount` 必须为零。未知 feature 不能按 normal、静态或空值静默继续。
- capture/Core 失败、取消、超预算或 hash mismatch 不产生可被识别为成功的部分 HYA。

## 当前稳定诊断

| Code | Severity | Path owner | 含义 / strict 行为 |
| --- | --- | --- | --- |
| `E_ANIMATION_INVALID_FORMAT` | error | HYA/HYDM binary 或 JSON path | magic/version/range/reference/topology/value 无效；始终失败 |
| `E_ANIMATION_LIMIT_EXCEEDED` | error | 超限 count/range path | 分配前超过 input/metadata/drawable/vertex/frame/mask/texture 预算；始终失败 |
| `E_CUBISM_CAPTURE_INVALID` | error | capture JSON path | capture root、time、drawable、texture、opacity、index 或 mask 引用无效；始终失败 |
| `E_CUBISM_TOPOLOGY_CHANGED` | error | `$.frames[*].drawables[...]` | clip-baked 跨帧 drawable population/topology/UV/mask identity 改变；始终失败 |
| `E_CUBISM_DEPENDENCY_MISSING` | error | `$.dependencies[*]` | model3 声明的 moc/texture/motion/expression/physics/pose 依赖未由 asset resolver 提供；始终失败 |
| `E_CUBISM_RECIPE_CAPABILITY_MISSING` | error | `$.recipe.*` | recipe 请求的 Motion/Expression/Physics/Pose 能力未由 caller-supplied evaluator 声明；始终失败 |
| `E_CUBISM_RUNTIME_INPUT_UNBAKED` | error | `$.recipe.runtimeInputs[*]` | lip-sync、eye/look、MotionSync 或外部参数仍要求运行时输入；clip-baked 始终失败 |
| `E_CUBISM_WPK_UNSUPPORTED` | error | `$.entry` | 输入是 WPK/`.cmo3` 等非 canonical 容器；要求授权预处理后的 runtime asset set |
| `E_CUBISM_DRAWABLE_COLOR_INVALID` | error | capture/evaluator drawable color path | evaluator 声明支持颜色后缺失 RGBA，或 RGBA 长度、finite、0–1 范围无效；始终失败 |
| `W_CUBISM_DRAWABLE_COLOR_UNAVAILABLE` | warning | `$.capabilities.drawableColors` / `$.evaluator.capabilities.drawableColors` | Core/evaluator 未提供 multiply/screen arrays，按旧文件 neutral 值继续；strict 失败 |
| `E_ANIMATION_2D_CULLING_INVALID` | error | `$.culling` | 通用 visual 收到非布尔 culling；始终失败 |
| `E_ANIMATION_2D_MULTIPLY_COLOR_INVALID` | error | `$.multiplyColor` | 通用 visual multiply tuple 长度、finite 或 `[0,1]` 范围无效；uniform 写入前失败 |
| `E_ANIMATION_2D_SCREEN_COLOR_INVALID` | error | `$.screenColor` | 通用 visual screen tuple 长度、finite 或 `[0,1]` 范围无效；uniform 写入前失败 |
| `E_ANIMATION_2D_PIPELINE_CREATION_FAILED` | error | `$runtime.animation2D.pipeline` | WebGPU visual pipeline 创建失败；保留完整有限状态 key 与底层 cause |

## Reserved classified gaps

下列 feature 必须在 adapter recipe/report 中产生稳定 diagnostic 后才能进入 G06/G07；在对应 code 落地前 strict conversion 不得接受包含它们的 recipe：

| Feature bucket | Required behavior |
| --- | --- |
| `parameterized-input` | `E_CUBISM_RUNTIME_INPUT_UNBAKED`；clip-baked 不接受运行时参数、lip-sync、eye/look 或 external input |
| `physics-runtime` | evaluator 未声明/执行时为 `E_CUBISM_RECIPE_CAPABILITY_MISSING`；未离线烘焙的 Physics/Pose 不进入 HYA runtime |
| `motion-sync` | 未烘焙 MotionSync 精确失败 |
| `expression-composition` | recipe 未求值的 Expression 组合精确失败 |
| `mask-inversion` | 若 source 观察到 inversion，G10 精确表达或 strict 失败 |
| `unknown-drawable-flag` | 未识别 constant/dynamic flag 不回落到 normal/default |

后续 Goal 接入剩余 code 时必须同步更新 converter union、machine-readable contract、测试和用户文档；不能只在 report 字符串中登记。
