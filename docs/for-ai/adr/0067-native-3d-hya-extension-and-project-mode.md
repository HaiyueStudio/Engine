# ADR 0067：原生 3D HYA 使用必需扩展与独立工程模式

- 状态：Accepted
- 日期：2026-08-04

## 背景

HYA `haiyue-animation@1.0` 与 AnimationEditor
`haiyue-animation-editor-project@1` 的坐标和 transform 都是明确的 2D
`screen-y-down` 语义。仓库同时已经有来源无关的 Animation3D
Clip/Binding/Pose/Mixer、glTF adapter 和引擎原生 ParticleEmitter3D。M01 需要让
设计师创建和交付真实 3D 动画，但不能把空间字段偷偷解释成现有 2D 字段，也不能
在 engine 或 editor 中复制第二套 mixer/runtime。

格式还必须保留既有 JSON HYA、二进制 container v1/v2 和 2D project 的解码；缺少
3D 能力的宿主必须在创建 runtime 之前得到稳定、可定位的错误。首版 mixed 2D/3D
composition 缺少一致的相机、深度、合成和交互语义，不能靠隐式投影补齐。

## 决策

1. HYA core 保持 `haiyue-animation@1.0`。原生 3D 使用必需的 versioned document
   extension `org.haiyue.animation-3d@1`，payload format 为
   `haiyue-animation-3d@1`。标识必须同时出现在 `extensionsUsed` 和
   `extensionsRequired`。
2. 3D carrier 的 core `canvas` 仅表达像素输出 viewport；core `nodes` 和 `tracks`
   必须为空。任何 2D core 内容与 3D extension 同时出现都以
   `E_ANIMATION_3D_MIXED_DIMENSIONS` 精确拒绝。
3. 2D editable project 保持 `haiyue-animation-editor-project@1` schema 1。原生
   3D 使用 `haiyue-animation-editor-project-3d@1` schema 1。第一版不允许 mixed
   composition；项目以 `E_PROJECT_MIXED_DIMENSIONS` 在 `$.mode` 拒绝。
4. 3D 世界固定为右手、+Y up、-Z forward、米、秒、弧度；持久化 rotation 是
   normalized XYZW quaternion。Euler 只属于 UI 输入。
5. Extension 冻结 canonical Transform3D、perspective/orthographic camera、
   primitive/model、基础 PBR material、Particle3D descriptor、source-neutral
   `haiyue-animation3d-clip@1` 和
   `haiyue-animation3d-state-machine@1`。
6. Joint 使用稳定 node id/path 的普通 transform binding；Morph 使用
   `morph.weights`；material/camera 使用 finite `property` binding。所有通道复用
   `@haiyue/extensions/animation3d` 的 binding resolver、pose 和 mixer，state-machine
   mask 存 binding id。
7. glTF/GLB 仍由 `@haiyue/extensions/gltf` adapter 负责；模型在 HYA core resource
   table 中使用 `binary` 加标准 model MIME。Particle3D 复用 engine 已有 descriptor
   和 simulation，不复制 runtime，也不增加 engine root export。
8. Bare HYA 保留 delivery URI；确定性 package 把受管资源改写为
   `assets/<sha256>.<ext>` 并写无时间戳 manifest。`blob:`、`file:`、
   `javascript:` 不是可交付 URI。
9. 编译仅可剥离 editor-only 状态。未知 feature、混排、悬空资源、binding width、
   particle/state-machine side effect 或预算错误必须中止，禁止无提示降级为 pseudo-3D
   或另一棵可视层级。

完整 machine-readable 决策表、schema、diagnostic 和 fixtures 位于
`animation-spec/schema/animation-3d*` 与 `AnimationEditor/schema/project-3d*`。

## 兼容与错误路径

- 旧 2D project 与 HYA 的格式、schema 和 decode 分支不变。
- 新写入的 `.hya` 继续使用当前 binary container v2；reader 继续接受 v1/v2。
- 未注册或未知 major 的 required 3D extension 走已有
  `E_ANIMATION_MISSING_EXTENSION`；未知 core version 与 container version 分别走
  `E_ANIMATION_UNSUPPORTED_VERSION`、`E_ANIMATION_INVALID_BINARY`。
- G06 注册 payload parser 后，使用冻结的 `E_ANIMATION_3D_*` code 与精确 JSON path；
  parser 在所有验证和预算检查完成前不得分配 ECS/GPU runtime owner。

## 被否决的方案

- **直接把 HYA 1.0 transform 扩成 3D：**会让同一 version 的字段产生两套语义，
  破坏 2D parser、schema 和内容寻址。
- **立即建立 HYA core 2.0：**当前差异是可选能力而不是全部 core 的替换；新 core 会
  重复 extension negotiation 并扩大兼容面。
- **允许同 composition 混排：**首版没有冻结 camera/depth/composite/input contract，
  不可测试地依赖 host 行为。
- **编译时投影回 2D：**这是已有 pseudo-3D 工作流，不能宣称 native 3D，也无法保留
  camera、joint、Morph 和 material runtime channel。
- **在 engine 或 AnimationEditor 重写 mixer：**会分裂 Animation3D pass history、
  pose ownership 和 glTF adapter contract。

## 影响

- G02–G05 和 G07 可以按明确的 mode、identity、time、resource 与 diagnostic 边界并行；
  G06 可直接实现 schema parser/runtime，不再重新决定版本或 owner。
- 不支持 3D 的现有宿主会安全拒绝 required extension，而不是显示错误的空画面或
  部分 2D 内容。
- mixed composition 延后；需要组合的产品当前必须显式预渲染一侧为普通资源。
- 新 native-3D code 属于 optional extension package，不扩大 engine root 和稳定 API
  baseline。
