# Release process

1. 更新 changelog、ADR、stable API 文档与 manifests。
2. 开发中用 `npm run release:artifact:check` 检查快速发布制品；用 `npm run performance:compare:full` 生成同机跨引擎候选；正式候选运行 `npm run release:check`（等同于 `release:check:global`）。
3. 在 `config/release-matrix.json` 的 required browser 与 Windows 独显硬件边界上执行 required correctness scenarios；不为 Apple/Windows 集显设置独立首发 handoff，兼容性设备也不充当固定性能排名主机。
4. 在 clean revision 上运行 `npm run performance:compare:formal`，评审五个引擎的同场景原始样本、截图 parity、backend、P50/P95 和排名结论，再评审 API surface、editor gzip、内部 benchmark diff、WebGPU pixel golden，以及短/长期 readback-churn artifact。
5. 仅在 required 全绿、extended 无新增 P0/P1 问题时发布。

local/global 候选门禁都执行 fast gate、slow gate、1800 帧真实 Chrome/WebGPU 长跑和包产物检查。内容 manifests 的 `ci` 标签分为 `smoke`、`full` 和 `manual`：pull request 与 main push 显式执行 `npm run check:slow -- --content-tier=smoke`，定时 nightly 以及 local/global release 固定执行 `--content-tier=full`；full tier 包含 smoke 与 full，manual 永远不由自动门禁消费。`workflow_dispatch` 可以显式选择 smoke 或 full，未指定 tier 的本地 slow gate 保守默认为 smoke。目标集合始终从 examples/games manifests 动态派生，门禁日志记录 tier、数量与完整 target ID。

fast gate 还会运行 `npm run capability:admission:check`。Forward+/Clustered、CSM、WebGL2 fallback、分层 NavMesh 和专用裁剪扩展的 policy decision 必须与登记的真实产品 evidence 一致；缺少合格证据时将能力标记为 `prototype-approved` 会阻断 local/global release。具体准入规则见[大型能力准入](./capability-admission.md)。

slow gate 通过显式 `benchmark:enforce` 生成内部 CPU artifact并执行绝对/结构预算；release gate 不再要求该 artifact 来自某个固定 CPU。local/global 随后运行同一个 portable cross-engine full contract：当前 revision 必须干净，四个排名引擎必须使用 native WebGPU，Galacean WebGL2 必须单列，三轮 cohort、结构数量和截图 sanity 必须完整。case-filter、report-only、dirty artifact、软件 adapter 或 backend fallback 都不能发布。旧 `--full` 参数保留为 `--global` 的兼容别名。editor 初始入口在构建时和 release artifact 检查时都重新 gzip，当前上限为 175,000 bytes；不能只相信旧 report。失败必须定位到具体 target 或 contract，不允许用跳过环境变量发布正式版本。

`.github/workflows/ci-device-performance.yml` 已把旧 device-class release job 替换为 portable cross-engine job：安装精确 lockfile 后运行 `performance:compare:formal`，一次上传五引擎结果。旧 device profile 脚本和 artifact 保留给内部诊断与兼容性采集，但缺少某个 profile 不再阻断渲染性能发布。`verify:device-performance` 仍把 `engine/dist`、fixture 和 benchmark 复制到临时执行快照，避免并行重建产生混合版本。本地 `--allow-dirty` 不能绕过正式 clean requirement。长跑正确性证据仍可由固定 Chrome/Metal runner 保存；像素 baseline 和内部性能预算只有在渲染变更经过视觉/数值评审后才允许更新。

CPU 同身份相对 baseline 仍可用于定位退化，但只属于诊断信号；普通 runner 继续执行绝对 P95 和结构 metric。正式发布性能由同一次浏览器会话中的相对引擎排名决定，因此不把 Apple M4 或任一 Windows GPU 型号设为发布资格。当前签入的旧 CPU/device baseline 不会被自动改写或冒充新的跨引擎证据。

smoke renderer/planar 检查只更新通用诊断 artifact，不得覆盖 `artifacts/webgpu/performance/<device-class>/` 中的 full 正式证据。仅 full workload 默认晋升正式证据；`WEBGPU_RECORD_PERFORMANCE_EVIDENCE=1` 只供明确的诊断实验使用，生成的非 full artifact 仍不能通过 release evidence gate。

## CI routing 与权限边界

`.github/workflows/ci-fast.yml` 和 `ci-slow.yml` 在 pull request/main push 分别执行 fast 与 smoke；`ci-slow.yml` 的 nightly schedule 固定选择 full。`ci-release-rehearsal.yml` 的 version-tag/manual 路径也固定先跑 full，再生成 no-publish 候选。workflow policy test 从 manifest 接线、事件、tier、设备 labels、validator、artifact upload、锁定安装和权限声明检查这些不变量；`manual` manifest target 没有自动入口。

clean CI 在 fast gate 前运行 `release-ci-bootstrap.mjs`：按 workspace 依赖方向构建 shader-language、engine、animation-spec、extensions、ui，并用真实 Chrome/WebGPU fixture 生成 architecture-decision policy test 所需的 lighting scaling 诊断。该诊断明确设置 `WEBGPU_RECORD_PERFORMANCE_EVIDENCE=0`，不会写入正式 device evidence 或 baseline；adapter 身份保留在 JSON 中，hosted runner 结果不能冒充 required physical device。

所有工作流只声明 `contents: read`，官方 Actions 固定到完整 commit SHA，checkout 禁止持久化凭据，依赖只用 `npm ci` 安装。rehearsal 不读取 secrets，也不会创建 tag、push、publish、签名或部署；将来的真实 publish/signing 必须拆到需要人工批准的 protected environment。npm token、GitHub Release 凭据、签名/公证密钥和生产部署凭据不得出现在本地文件、日志或 artifact 中，报告入口和响应边界见 [`SECURITY.md`](../../SECURITY.md)。

旧 profile 工具仍可显式选择 `apple-integrated`、`windows-integrated` 或 `windows-discrete` 来采集兼容性和内部诊断材料；这些 profile 不再决定渲染性能发布资格。正式性能 job 只需一台 native WebGPU 主机，并在同一 job 安装锁定依赖、运行 `performance:compare:formal`、上传完整 artifact。结构、截图、backend、raw sample、revision 或环境 provenance 任一失败都不能形成绿色 evidence；`if: always()` 的上传只负责保留诊断材料，不改变失败状态。
portable artifact 同时记录 self-hosted runner 环境和候选中的 OS、CPU、浏览器、adapter/backend、Node 与依赖版本。runner 环境、设备指纹或 runtime 身份缺失时 fail closed，不会用软件 backend 或缺失证据标绿；旧 identity artifact 继续服务于 device profile 诊断。

## 供应链检查

`node scripts/release-supply-chain.mjs --output artifacts/release/supply-chain` 执行以下 fail-closed 检查：

- `package-lock.json` 必须是 npm lockfile v3，安装命令固定为 `npm ci`。所有生产依赖固定精确版本；npm 生成器写出 registry resolution 时必须同时带 SHA-512 integrity，生成器保留的 version-only entry 会在报告/SBOM 中明确标为 `exact-version`。
- `npm audit --omit=dev --audit-level=high --json` 的原始 JSON 被保留；high/critical 生产漏洞阻断候选，audit 不可用或输出不完整同样阻断。
- 生产依赖许可证按显式 allowlist 检查；双许可证必须记录本次选择的兼容分支，缺失或未评审许可证阻断。
- tracked source 与候选输入检查 credential 文件名和已知 private-key/token 形态；扫描只报告路径和分类，不把疑似 secret 复制进报告。
- 输出依赖报告和 CycloneDX 1.5 SBOM；公共包内部的 files allowlist、secret-like 文件名、metadata、exports、真实安装和确定性 tarball 仍由 `verify-engine-package.mjs` 负责。

## No-publish release rehearsal

在 clean HEAD 上运行：

```bash
node scripts/release-rehearsal.mjs
```

该入口创建本地 temporary clone、再次执行 `npm ci`，并在 clean detached revision 中运行 worker。开发 G06 patch 尚未提交时可用 `--candidate-snapshot` 把 tracked diff 和未忽略的新文件提交到临时 clone；这种结果标记为 local candidate，不能替代 G07 对 frozen clean HEAD 的重放。`--worker` 是 clean CI checkout 的内部入口，不是绕过临时检出的快捷方式。

worker 依次执行生产供应链审计、`inspect-release-artifacts.mjs --release`、完整 examples/games catalog build，然后按 `review/api/release-manifest.json` 生成三个 npm tarball 引用和六个 app/catalog archive。输出目录 `artifacts/release/rehearsal/` 包含：

- `report.json`：revision、dirty 状态、精确 Node/V8/npm、tier routing、命令结果、九个 manifest artifact 的路径/bytes/SHA-256，以及 formal baseline 前后 tree hash。
- `SHA256SUMS`、in-toto Statement v1 / SLSA provenance、包含生产依赖和九个发布制品的 CycloneDX 1.5 SBOM。
- release-note candidate、version/changelog/tag dry-run、逐 artifact publish action（全部 `executed: false`）、失败恢复与 rollback unit checklist。
- npm audit 原始 JSON、public-package/G03 app reports 和 app manifests。它们是原始候选 evidence，不会写入或晋升 `review/baselines/**`。

rehearsal policy 会重新读取每个 tarball/archive，核对 manifest ID/kind/version/channel/rollback unit、bytes/hash、`SHA256SUMS`、provenance subject、SBOM component、release notes、发布动作和 baseline hash。任何缺失、audit unavailable、credential finding、tracked source 变化或未分类错误都返回非零。
worker 完成后，temporary checkout 和 CI 都会再次独立执行 `node scripts/release-rehearsal-policy.mjs --bundle artifacts/release/rehearsal`。该 validator 不信任 `report.json` 的绿色结论，会重读制品 bytes、SBOM 内 SHA-256、provenance resolved inputs/runtime、release-note candidate、生产审计原始文件和 G03/package/app raw reports；日志还明确列出 full target IDs，以及 required browser/hardware handoff 和 manual target 未在 hosted rehearsal 中执行的原因。

## 外部发布与失败恢复

rehearsal 通过不代表获得发布授权。G07 必须在同一 frozen clean revision 重跑 full/browser correctness、portable comparison、artifact 和 rehearsal validators；不再因缺少指定 Apple/Windows GPU 的性能 artifact 单独 no-go。确认 go 后，release owner 逐项核对 `release-plan.json`，再单独请求 tag、push、npm、GitHub Release、静态部署和签名/公证授权。

GitHub Pages 当前承载 Engine examples 的公开预览。`.github/workflows/deploy-pages.yml` 只接受人工输入的已签名 release tag，通过 GitHub API 确认 annotated tag 的签名状态为 verified，检出该 immutable revision，重新构建 Engine foundations 与 examples catalog，再由 main 上受 policy 约束的 `scripts/assemble-pages-release.mjs` 聚合到 `/releases/<version>/examples/`；稳定入口 `/examples/` 只负责跳转到当前部署版本。依赖本地生成 cache 的 manual corpus dashboard 不进入公共清单，其余运行时资产按示例服务器的公开 mount 契约装配。workflow 不响应普通 push、不读取存储型 secrets、不持久化 checkout 凭据；只有 deploy job 获得 `pages: write` 与 OIDC `id-token: write`，并使用 GitHub 的 `github-pages` protected environment。Pages deployment ID 是不可变部署单元，公开站点 URL 是可回切 alias；Scene Editor、AnimationEditor、Voxel PWA 与 Games 的静态发布仍按各自产物的 release owner 独立执行。

失败时先停止后续外部动作并保留 immutable candidate 与 raw evidence。npm 已发布版本不能覆盖：deprecate 问题版本并发布修复 patch；静态应用把公开 alias 切回上一 immutable deployment；Electron 撤下问题 preview attachment，并从新版本在 protected signing 环境重建。任何恢复都从新的 clean frozen revision 完整重跑，不复用失败候选的正式结论。
