# artifacts 空间淘汰

问题：多轮安装、隔离构建和原始捕获长期堆积，重复运行没有磁盘回落机制。

方法：按 [策略](../config/artifact-retention.json)在超过 5,000,000,000 bytes 后选择旧文件，回落到 4,500,000,000 bytes；默认保护当前 0.2.3、正式发布包、近期文件及小型结论报告。串行批次最多 256 MiB／1,500 文件，大文件独占一批。原件经 gzip/TAR 压缩、逐文件 SHA-256 回读校验、清单持久化后才移除。冷归档位于 artifacts 外，计入单独的长期证据存储，不伪装成磁盘数据被永久删除。

结论：5 GB 是热目录软目标；保护数据自身超过目标时明确报告，不能靠删除必需证据强行达标。冷归档没有自动过期删除规则。历史报告中的原路径和原哈希不重写，读取旧附件时先恢复。

2026-11-03 执行结果：热目录从 77.79 GiB 降为 4.26 GiB，NTFS 文件数据实际分配为 4.67 GiB。652,689 个文件分 617 批完成回读校验后移除展开副本；冷归档及清单合计 11.19 GiB，位于 `F:/HaiyueStudioArchives/Engine/artifact-retention`。计入冷存储后净减少 62.35 GiB。当前 0.2.3 的 221,315 个文件及 3,797,003,227 字节保持；最终校验汇总位于 `D:/HaiyueStudio/_diagnostics/artifact-retention-final-20261103.json`，另已通过实际 CLI 附件恢复验证。

```powershell
# 预览；不移除任何文件
npm run artifacts:plan -- --cold-root=F:/HaiyueStudioArchives/Engine/artifact-retention

# 按打印的计划执行，或中断后继续同一计划
npm run artifacts:apply -- --plan=artifacts/.retention/plans/PLAN_ID.json --max-batches=1

# 维护入口：重新盘点、生成计划并执行；适合在测试结束后重复运行
npm run artifacts:maintain -- --cold-root=F:/HaiyueStudioArchives/Engine/artifact-retention

# 完整回读归档；恢复一个历史附件时不覆盖已有同名文件
npm run artifacts:verify
npm run artifacts:restore -- --path=engine-0.2.1/g09/RUN/capture.etl --output=D:/temporary/capture.etl

# 异常退出遗留的 owner 锁：只有记录的 PID 已不存在才允许恢复
node scripts/artifact-retention.mjs recover-lock
```

默认冷存储位置为相邻 `_archives/engine-artifact-retention`，可用 `--cold-root` 指定其他磁盘；压缩直接流向冷盘，不在源盘创建大型临时副本。`.retention/plans` 保存筛选结果，`.retention/receipts` 绑定冷归档清单、原路径及回读／移除证明。运行中保持 owner 锁；近期和保护目录不会进入淘汰名单。无需停用安全软件或退出正常应用。

整组完成后，计划自身也经 SHA-256 回读压缩为 `.json.gz`，后续 `--plan` 可直接读取该文件；原始计划身份和压缩证明保留。推进到下一版本时同步维护保护前缀；保护区超额会明确报告，不自动删除正在验收的候选。

`webgpu/` 和 `performance/` 中的固定诊断／对照输入由当前门禁和复核程序读取，整组保护，不按文件年龄或 JSON 大小淘汰。2026-11-04 快速门禁暴露灯光策略输入被归档，已按原归档 SHA-256 恢复相关固定 WebGPU 输入，并补充真实配置回归检查；没有重采、重写原结果或授予新版本正式资格。

同级项目可复用此工具，但必须同时指定 `--artifact-root` 和该项目自己的 `--policy`，不能沿用 Engine 的版本保护清单。根目录只能是当前工作区内名为 `artifacts` 的目录，不能选择项目源码根目录、工作区外路径或 `.git`；冷归档也必须位于该项目之外。每处目录独立保存 `.retention/policy.json`、计划、回执和 owner 锁。

```powershell
# 先预览其他项目；移除操作另外使用 apply 或 maintain
node scripts/artifact-retention.mjs plan --artifact-root=D:/HaiyueStudio/Engine-rc-021-20261013/artifacts --policy=D:/HaiyueStudio/Engine-rc-021-20261013/artifacts/.retention/policy.json --cold-root=F:/HaiyueStudioArchives/Workspace/artifact-retention/Engine-rc-021-20261013--artifacts

# 从指定项目的冷归档恢复，仍拒绝覆盖已有文件
node scripts/artifact-retention.mjs restore --artifact-root=D:/HaiyueStudio/Engine-rc-021-20261013/artifacts --policy=D:/HaiyueStudio/Engine-rc-021-20261013/artifacts/.retention/policy.json --path=HISTORICAL/ATTACHMENT --output=D:/HaiyueStudio/_diagnostics/restored-attachment.bin
```

同级目录本轮仅处理两份旧 0.2.1 RC、旧 G10 评审副本、Editor 的旧迁移备份，以及 ShaderLab/mobile 的旧打包副本；后者保留现用 `bundles/` 和 `gpu/`。Games、Native、MUGEN 与小型／空目录未纳入移除，仍被引用的历史资格报告保留原路径。筛选和最终逐批校验汇总分别位于 `D:/HaiyueStudio/_diagnostics/sibling-artifacts-selected-20261103.json` 与 `D:/HaiyueStudio/_diagnostics/sibling-artifacts-final-20261103.json`。

本轮同级清理结果：20 处目录合计从 75.99 GiB 降至 5.80 GiB；获准的 5 处分 342 批归档 40,693 个文件，移除 70.20 GiB 展开数据，冷归档及清单为 8.36 GiB，净缩减 61.84 GiB。所有冷归档 SHA-256 已再次复核；9 份历史资格引用及当前 Engine 冻结哈希不变，跨项目实际恢复通过。MUGEN 在盘点期间仍有其他任务生成记录，其增量单列在汇总中。
