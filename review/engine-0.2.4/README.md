# Engine 0.2.4 验收

视觉小说入口 `@haiyue/extensions/visual-novel` 装配分支台本、分层 HYA、阅读 GUI、历史配音与存档续读。G01–G06 的合同和功能证据见 [G07 检查索引](g07-checks.json)。

已接受源码为 `c744e8323b2848178ad8f487e36968ac5fe263b2`，包含已发布 0.2.3 的全部修复。此前候选缺少发布历史、配音切回恢复及设备启动目录的问题均已解决。Windows 与 Mac 完整真机各 11 项通过，浏览器与 GPU 错误均为 0；同候选新采的 15 次生产冷进程、七组 580 次渲染、Windows 全局门禁、无发布演练及制品审计通过。

Ubuntu／SwiftShader AO 全矩阵保留原 600 秒超时：[原运行](https://github.com/HaiyueStudio/Engine/actions/runs/44537656052)完成 15／18 组，第 16 组有 13／30 样本；[标签复跑](https://github.com/HaiyueStudio/Engine/actions/runs/45412738240)完成 16／18 组，第 17 组有 3／30 样本。两次可执行指纹一致，无浏览器／GPU 错误。同候选 Windows 原生 18 组和 36 项 P95 检查通过。本候选经明确批准按原生资格继续；云端失败、后续未执行阶段、原样本、时限及预算均保留。

`@haiyue/engine@0.2.4` 和 `@haiyue/extensions@0.2.4` 已从 npm 下载并通过 SHA-256／SRI 校验。配套包保持 `animation-spec@0.2.2` 和 `shader-language@0.2.3`。Extensions 为 597,072 B，处于原批准的 600,000 B 上限内，原包体失败保留。[正式 Release](https://github.com/HaiyueStudio/Engine/releases/tag/v0.2.4) 的八份附件已逐文件从 GitHub 回读，字节数与 SHA-256 全部一致。示例通过 [版本化入口](https://haiyuestudio.github.io/Engine/releases/0.2.4/examples/) 提供，线上 110 项目录及五项关键资源哈希已核对；master 的 Fast、Slow 和 Pages 全部通过。未更新性能基线。
