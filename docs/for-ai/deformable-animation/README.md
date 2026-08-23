# 来源无关可变形 2D 动效契约

本目录固定 M05 G01 的稳定架构、许可和证据入口。活动状态与执行依赖仍以
[`milestones`](../../../../milestones/milestones/m05-hya-deformable-animation-delivery/README.md)
为准；本目录不复制动态 Goal 进度或正式性能数值。

## 阅读顺序

1. [能力与缺口矩阵](./capability-matrix.md)：区分已冻结 ABI、候选实现、语料覆盖和明确不支持项。
2. [包与运行时边界](./package-boundary.md)：adapter、HYA 和浏览器 runtime 的依赖方向及 deny-list。
3. [许可矩阵](./license-matrix.md)：Core、Framework、官方模型、用户模型和派生证据的处理结论。
4. [Drawable color contract](./drawable-color-contract.md)：HYDM 1.2 multiply/screen RGBA、neutral、采样与 G15 handoff。
5. [Drawable culling contract](./drawable-culling-contract.md)：静态 back-face、CCW winding、mask/main pipeline 与 recovery 合同。
6. [诊断目录](./diagnostics.md)：normal/strict 行为、稳定 code/path 和未分类失败规则。
7. [`corpus-manifest.json`](./corpus-manifest.json)：固定官方 revision、三模型 case、哈希算法和本地同步策略。
8. [`runtime-deny-list.json`](./runtime-deny-list.json)：npm、bundle、source map、HYA package 和浏览器网络闭包禁入项。

## 冻结结论

- Delivery profile 是 `clip-baked`；HYA/runtime 不执行 Cubism 参数图、Physics、Pose、MotionSync、口型或视线输入。
- Required extension 是 `org.haiyue.deformable-mesh-2d@1`，sidecar 是 `haiyue-deformable-mesh-2d@1` / `HYDM 1.2`；reader 继续兼容 HYDM 1.0/1.1。
- `Engine/animation-spec` 拥有来源无关 schema/codec 和 build-time capture converter；`Engine/extensions` 只拥有通用播放组件。
- Cubism Core、Framework、`.moc3`、`.model3.json`、Motion3 和纹理均不得进入 HYA/runtime package 或浏览器播放闭包。
- 官方 Core 只允许由使用者在已接受相应许可后提供给本地 capture 工具。HaiYue 不下载、镜像、发布或在 CI 缓存 Core。
- WPK、`.cmo3` 和其它工程/分发容器不是 canonical input；本阶段不逆向、解密或绕过保护。
- Mask composition 与 `normal`/`additive`/`multiplicative` 已有 v1 candidate contract/runtime；正式 parity 和能力矩阵晋升分别由 G10、G11、G12 完成。
- Drawable culling 已执行为来源无关的 CCW back-face pipeline，并在主 drawable、mask source 与 effect source 使用同一静态值；正式 corpus 晋升由 G16 完成。
- Multiply/screen drawable color 已从 HYDM 1.2 pose 逐帧写入通用 visual/object uniform，并按官方 premultiplied multiply → alpha-aware screen → opacity → mask → framebuffer blend 顺序渲染；mask setup 跳过 RGB tint，正式真实模型晋升由 G16 完成。

## Source-neutral dependency diagram

```text
caller-supplied licensed Core + official runtime asset set
                         │ build-time only
                         ▼
animation-spec/live2d capture adapter
                         │ source-specific capture
                         ▼
animation-spec/deformable2d HYDM + HYA encoder
                         │ source-neutral package
                         ▼
extensions/deformable-animation + shared Animation2D renderer
                         │
                         ▼
browser playback (no Core / Framework / source asset parser)
```

## 验证入口

```bash
npm run typecheck -w ./animation-spec
npm test -w ./animation-spec
npm run build -w ./animation-spec
npm run typecheck -w ./extensions
npm test -w ./extensions
npm run build -w ./extensions
npm run check:boundaries
npm run api:check
npm run docs:check
```

真实模型只在许可已由执行者接受的本地环境中运行。公开仓库固定 manifest、hash、命令和允许分发的统计；不提交官方模型或 Core。
