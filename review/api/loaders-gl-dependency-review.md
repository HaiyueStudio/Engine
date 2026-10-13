# loaders.gl 依赖范围复核 — 2026-10-11

用户要求收紧整组 loaders.gl 的版本范围。Engine 原来的 `^4.4.3` 允许新消费者解析到 4.5.x：`worker-utils@4.5.3` 的 peer 范围 `core@~4.5.0` 选中 `core@4.5.4`，后者又精确依赖 npm 中当时不可用的 `worker-utils@4.5.4`，全新打包消费因此报 `ETARGET`。

## 变更范围

将 `engine/package.json` 的两项生产依赖 `@loaders.gl/schema`、`@loaders.gl/worker-utils` 和一项开发依赖 `@loaders.gl/textures` 从 `^4.4.3` 固定为 `4.4.4`，并把原本自动安装的 peer `@loaders.gl/core` 显式声明为生产依赖 `4.4.4`，同步 npm 生成的 lock 元数据。

修改前的 lock 和 node_modules 已使用 4.4.4；其余 core、images、loader-utils、schema-utils 也均为 4.4.4。本次不升级已安装依赖。第一次只固定原有三个声明时，真实全新安装已经成功，但 `worker-utils@4.4.4` 的上游 peer 范围 `core@~4.4.0` 仍选中了 4.4.5，并带入嵌套 4.4.5 包，因此补齐显式 core 约束。实际发布的 Engine manifest 带有四个精确版本约束，对没有本仓 lock 的消费者生效；上游 peer 元数据不由本仓改写。

## API 和兼容性结论

已有隐式 peer core 转为显式依赖；没有新增第三方包种类、workspace 边、公开导出、类型或运行时实现。lock 中 core/schema-utils 的 peer-only 标记随之移除，版本、完整性摘要及已安装包字节不变。公共 API、包版本、文件白名单及原包体预算保持。范围收紧只影响未来依赖解析，恢复到本仓现有经过验证的系列。今后升级这一组包须重新执行发布包的独立安装和消费验证。

G09 的 runtime 输入指纹包含 `package-lock.json`，因此锁文件元数据变动需要重新构建并登记当前 B4 制品。旧测量与失败证据保留，不因依赖修复获得性能资格；5% 回归预算不变。

## 验证记录

执行目录：[依赖修复验证](../../artifacts/engine-0.2.1/g09/loaders-pin-20261011T055135982Z)；汇总与文件摘要见[机器复核记录](../engine-0.2.1/g09/loaders-dependency-checks.json)。

- 独立消费者使用本次实际 Engine tarball，在没有仓库 lock 和 overrides 的新目录安装；5 个运行时 loaders.gl 包全部为 4.4.4，没有嵌套重复版本。仓库 lock 中的 7 个 loaders.gl 包仍为 4.4.4，解析版本、完整性摘要及已安装 manifest 均未改变。
- 29 项 loader 专项、1,446 项全仓测试、全仓类型检查、API 检查和构建通过，98 个示例重新生成。模块边界、职责边界、renderer prepare 与 no-rive 制品检查通过。
- 四个发布包的独立安装以及 Node、TypeScript、66 个导出与 CLI 消费通过。发布包总门禁仍失败：`@haiyue/extensions` 有 202 个文件，超过原 200 个上限。修改前后该包 tarball 的 SHA-256 相同（`6505af3b60d263ffd233cbf19c0cef814336e1a81c73a3029af7c7898b8d4517`），因此这是原有独立问题；未调整预算。
- 重新构建的 B4 四个 JavaScript 制品与修改前逐字节一致。仅刷新当前 `fixture-build.json` 的输入绑定，旧原始报告和历史指纹保持。长诊断计划与原 5% 回归预算未变；本次未运行性能采样，不能据此完成 G09 性能验收。
