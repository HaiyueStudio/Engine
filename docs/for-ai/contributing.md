# 从源码运行、贡献与验证

本页面向仓库贡献者。普通 npm consumer 从 [Engine 新用户黄金路径](../engine-guide/consumer-walkthrough.md)开始，不需要克隆整个 monorepo。

## 环境与安装

- Node.js 22 或更高版本；根目录与 public package `engines` 要求 `>=22`，仓库 `.node-version` 保留 22 作为默认和最低开发版本。
- npm 使用签入的 `package-lock.json`，干净安装运行 `npm ci`。
- WebGPU 页面通过 HTTP(S) 运行；不要使用 `file://`，不要用 SwiftShader 代替 required 真机验证。

```bash
git clone https://github.com/HypnosNova/HaiYue.git
cd HaiYue
npm ci
npm run build
```

## 按目标运行

示例和游戏只能通过 manifest target 选择：

```bash
npm run build:target -- example:consumer-walkthrough
npm run preview:target -- example:consumer-walkthrough
npm run build:target -- game:sokoban-3d
```

`preview:target` 默认监听 `127.0.0.1:8080`，可用 `PORT` 覆盖。局域网 WebGPU 使用 `npm run serve:examples:lan` 的受信任 HTTPS 路径。

应用开发入口：

- Scene Editor：`npm run dev:editor` 只持续构建；另开静态 HTTP server 访问 `/editor/`。
- AnimationEditor：`npm run dev:animation-editor`，默认 `http://127.0.0.1:4175`。
- Voxel PWA：`npm run build:voxel-editor-pwa`，再运行 `npm run preview:pwa -w ./voxelEditor`，默认 `http://localhost:4174`。

## 修改边界

修改前阅读根目录和目标目录的 `AGENTS.md`、相关 ADR、当前 milestone Goal 与机器可读 manifest。公共声明由 `package.json#exports` 和构建后的 `.d.ts` 决定；不要从其他 workspace 的 `src/` 相对导入，也不要为修复检查直接更新 baseline。

新增示例只写入 `examples/manifest.json` 或 `games/manifest.json`，catalog、CI tier 和 build target 都从 manifest 派生。资源和 Worker 使用 base-path-safe URL，销毁路径释放监听器、Worker、object URL、asset handle、场景和 GPU owner。

## 验证阶梯

先运行目标 workspace 的 typecheck/test/build，再扩大到仓库门禁：

```bash
npm run typecheck -w ./engine
npm test -w ./engine
npm run build -w ./engine

npm run docs:check
npm run api:check
npm run examples:catalog:check
npm run examples:freshness:check
npm run check:fast
npm run check:slow -- --content-tier=smoke
```

WebGPU、编辑器 workflow、内存、包或性能变更还要运行对应 browser/device/packed-consumer verifier。`release:artifact:check` 是快速制品审计；`release:check:local` 和 `release:check:global` 是候选操作，不能替代聚焦验证。

正式 API、pixel、screenshot、CPU/GPU、gzip、fidelity 和 performance baseline 只在被授权的 RC 集成评审中更新。贡献者应提交候选 diff、原始 artifact、环境身份和复现命令，不执行 tag、push、publish、签名或部署。
