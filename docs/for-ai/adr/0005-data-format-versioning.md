# 0005：场景与导出数据版本策略

- 状态：Accepted
- 日期：2026-07-10

## 背景

编辑器场景、预制体、资源描述、session 和导出 runtime 数据会随引擎 API 演进。项目尚无历史项目，过早维护多个旧格式会增加反序列化分支和测试矩阵。

## 决策

1. 持久化项目数据必须有显式格式标识和整数版本；场景、预制体和导出 runtime 可以分别版本化。
2. 外部输入先校验为 `unknown`，通过 schema/type guard 后才进入领域对象。
3. 错误必须包含格式、版本和精确 path，能够定位 entity/component/field/resource。
4. 在没有历史项目兼容要求期间，破坏式格式调整直接提升版本、替换仓库 fixture 和模板，不提供旧版本 parser/migrator。
5. localStorage session 属于可丢弃偏好数据。版本不匹配时安全回到默认值，不影响项目数据。
6. 当项目第一次对外发布或出现真实用户项目时，必须新增 ADR 重新决定迁移支持窗口；不得默认沿用当前无兼容策略。

## 后果

- 阶段三会统一输入校验和错误协议。
- 格式变更 PR 必须同时更新 fixtures、export template、player runtime 和 contract tests。
- 当前旧格式 fallback 可以在对应重构阶段直接删除。
