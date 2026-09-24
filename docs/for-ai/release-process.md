# Release process

Engine 独立发布范围由 `review/api/release-manifest.json` 定义：engine、animation-spec、extensions、shader-language 四个 npm 包，以及 Engine examples 静态目录。UI、Editor、Games 按各自仓库发布，参见 [ADR 0105](adr/0105-independent-library-release-gates.md)。

## 候选验收

1. 更新 changelog 的版本标题、release notes、API/ADR 与 manifest。候选标题可标注“未发布”，不提前声明发布完成。
2. 开发中运行 `npm run release:artifact:check`；正式候选在 frozen clean revision 运行 `npm run release:check`（等同 `release:check:global`）。
3. 从 `config/release-matrix.json` 选择完整的 Mac Chrome/Metal 或 Windows Chrome+Edge/独显路径，执行该路径的 required correctness 检查。不得混用平台证据，见 [ADR 0107](adr/0107-native-macos-release-qualification.md)。
4. local/global 门禁依次采集并校验正式灯光、执行 `check:engine:fast`、`check:engine:slow -- --content-tier=full`、1800 帧 readback 长跑、四包真实安装与消费端检查、Engine 入口预算及 `performance:compare:formal`。
5. 正式性能比较在同一干净提交、同机浏览器环境中采集五引擎原始样本。四个排名引擎必须使用 native WebGPU，Galacean WebGL2 单列；三轮 cohort、结构数量、截图 sanity、设备/backend、revision 与 raw samples 都须通过。诊断、dirty、case-filter、软件 adapter 或 fallback 不能晋升正式证据。
6. 完成下述供应链审计和 no-publish 演练，复核全部 required 结果及 extended 中是否新增 P0/P1 问题，再决定发布。

Engine fast gate 保留类型、workspace 测试、结构/模块边界、性能策略、能力准入、文档/API/范围、Shader 与发布策略测试。slow gate 保留 Engine 渲染、AO、Shader DAG、full 示例与内部 CPU benchmark。`check:fast` / `check:slow` / `release:studio:artifacts` 是显式 Studio 集成入口，不属于 Engine 演练。

## CI 初始化与证据分离

`node scripts/release-ci-bootstrap.mjs` 依依赖顺序构建 shader-language、engine、animation-spec、extensions，并执行真实 Chrome/WebGPU 灯光 fixture。`--pages-examples` 只构建四个基础库，供 Pages 使用。

bootstrap 显式选择 `--evidence=diagnostic`，仅写 `artifacts/webgpu/lighting-scaling-diagnostic.json`。架构策略测试和能力准入通过共享 loader 读取诊断结果；没有诊断文件时可以读取正式结果。指定输入缺失或已选输入无效时直接失败，不能偷偷换用其他文件。

正式发布仍只通过 `lighting:evidence:check` 验证 `artifacts/webgpu/lighting-scaling.json`，要求当前 clean revision、完整 workload、合格原生 GPU 与新鲜时间戳。诊断读取不会写入或覆盖正式文件。hosted CI 的诊断不能代替物理设备正式发布证据。

`.github/workflows/ci-fast.yml` 在 PR/main 执行 bootstrap 与 Engine fast；`ci-slow.yml` 在 PR/main 选择 smoke、nightly 选择 full，manual dispatch 可选 smoke/full。`ci-release-rehearsal.yml` 在版本 tag 或显式 dispatch 执行 Engine full slow，再运行 no-publish worker 和独立 bundle validator。

三个工作流使用 `npm ci`、精确 SHA 锁定 Actions、`contents: read`，checkout 不持久化凭据。失败时保留原始报告。没有 npm publish、tag 创建、push、签名或部署动作；正式灯光和跨引擎性能由独立 native GPU job 采集。

## 供应链检查

`node scripts/release-supply-chain.mjs --output artifacts/release/supply-chain` 检查 lockfile v3、生产依赖精确锁定/integrity、许可证 allowlist、生产漏洞和 tracked source 凭据形态，并输出 CycloneDX 1.5 SBOM。

`npm audit --omit=dev --audit-level=high --json` 的原始结果保留；high/critical 漏洞、audit 不可用、未评审许可证、锁定证据缺失或凭据命中都阻断候选。扫描只报告路径与分类，不输出疑似凭据内容。

## No-publish release rehearsal

先预览无副作用的计划：

```bash
npm run release:rehearsal:plan
```

计划校验当前 manifest 恰好是四个 npm 包与 examples，列出完整 smoke/full target IDs、命令及构建环境，不读取兄弟产品仓库，也不要求已有 dist 或 evidence。

在 clean HEAD 执行：

```bash
npm run release:rehearsal
```

该入口创建本地临时 clone，执行 `npm ci`，并在干净 detached revision 运行 worker。开发时的 `--candidate-snapshot` 将当前全部 tracked diff 与未忽略新文件复制到临时候选，结果标为 local candidate；它不能代替最终发布提交的验收。`--worker` 是 clean CI 内部入口。

worker 依次执行供应链审计、四库与诊断 bootstrap、Engine fast、四包 `--release` 打包/真实安装/消费端校验、Engine 入口预算、full 示例构建。构建、归档、输出 manifest 共用 examples manifest 中 smoke/full 集合，manual 不自动执行或打包。归档包含 source viewer、shared Engine 与示例运行时依赖。

`artifacts/release/rehearsal/` 输出五个 manifest 产物、`report.json`、`SHA256SUMS`、in-toto/SLSA provenance、CycloneDX SBOM、release-note candidate、未执行的发布计划和 rollback checklist。原始证据仅包含本仓库 public-packages 报告与供应链审计，不再要求 G03 app 报告、Editor/Electron 或 Games 清单。

完成后再次运行：

```bash
node scripts/release-rehearsal-policy.mjs --bundle artifacts/release/rehearsal
```

独立 validator 重读制品 bytes/hash、SBOM/provenance、release notes、生产审计、实际命令/构建环境、full target 集合与公共包原始报告。包名/版本、clean revision、release mode、确定性重打包 hash 必须与最终归档一致；报告声称 passed 不能替代这些检查。基线树不得变化。

## 外部发布与恢复

演练通过不代表已经发布。release owner 在同一 frozen revision 收齐完整 correctness、正式性能、制品与演练结果后，核对 `release-plan.json`，再按具体操作取得 tag、push、npm、GitHub Release、Pages 部署等授权。发布凭据只进入受保护环境，不写入本地文件、日志或 artifact，见 [`SECURITY.md`](../../SECURITY.md)。

签名 tag 的正式 Pages 部署由 `deploy-pages.yml` 执行；已有 master 自动示例预览由 `deploy-pages-ci.yml` 单独管理。后者不是正式 npm 发布或签名 tag 的证据，两者均保留 protected `github-pages` 环境。

失败时停止后续外部动作，保留候选与原始证据。npm 版本不能覆盖，应 deprecate 问题版本并发布修复；静态部署可切回上一 immutable deployment。修复后在新的 clean revision 重跑相关完整门禁，不复用旧候选的正式结论。

## Native Mac diagnostic budgets and pixel references

Native Metal correctness qualification does not enroll a fixed-device timing budget. For an unmatched physical AMD/Intel Mac, the default diagnostic runners validate full workload/sample/timing coverage and report `performanceBudget.status=not-enrolled`. They retain all timings without claiming P95 acceptance. Explicit profiles, enforced budgets and candidate/formal evidence still require a matching registered profile. The formal release performance gate remains the same-host five-engine comparison.

PBR, Fog and Volume screenshot baselines contain losslessly compressed full RGBA references. The shared portable pixel policy checks dimensions, mean channel error and changed-channel coverage; PNG hashes remain diagnostic. Review candidate images and feature-specific assertions before replacing references. Missing references must fail. Volume belongs to the manifest's full tier and is built by the render gate before browser verification.
