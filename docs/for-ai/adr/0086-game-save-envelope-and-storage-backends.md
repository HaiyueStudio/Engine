# ADR 0086：游戏存档使用来源无关信封与可替换存储后端

- 状态：Accepted
- 日期：2026-08-21
- 影响范围：`@haiyue/engine/save`、Games 存档、浏览器持久化、存档文件格式

## 背景

多个游戏需要自动保存、checkpoint、多槽、完整性检查、删除和缩略图。若每个游戏直接拼接 LocalStorage key、
自行定义日期和版本字段，会重复实现错误处理，也无法在 IndexedDB 或文件流程之间切换。2048 已经有一套仅适用
自身的 LocalStorage JSON，适合作为首个真实产品迁移证据。

## 决策

1. 新增 stable focused entrypoint `@haiyue/engine/save`，不从 Engine 根入口 re-export。该入口属于
   `runtime-foundations`，首批审查 35 个公共符号。
2. 存档使用版本化 `haiyue.game-save` 信封。公共字段包含 save/game id、名称、类型、创建与更新时间、revision、
   游戏数据版本、游戏私有 JSON data、可选 metadata/thumbnail，以及用于发现意外损坏的 FNV-1a checksum。
   checksum 不是安全签名，不能用于防作弊或鉴权。
3. `GameSaveService` 统一串行化同一服务实例上的异步操作，负责槽位限制、动态覆盖、checkpoint、列表、加载、
   删除、导入导出和游戏数据 validator。销毁后不接受新操作；拥有后端时销毁会关闭后端。
4. Engine 提供 LocalStorage、IndexedDB 和内存后端。LocalStorage 与 IndexedDB 实现完整多槽 CRUD；内存后端用于
   测试和文件为唯一持久制品的会话。
5. 本地文件通过同一信封的显式 serialize/parse/read/download API 导入导出。网页无权在没有用户授权的情况下枚举
   或删除下载目录中的任意文件，因此 OS 文件删除不伪装为通用后端能力；获得目录授权的宿主可以实现
   `GameSaveBackend`。
6. 游戏私有 data 的 schema 和 migration 仍由游戏拥有。Engine 只验证 JSON 完整性、信封版本、checksum，并调用
   游戏提供的 validator；版本不匹配必须产生结构化错误，不能静默载入。
7. Games/2048 迁移到固定 `autosave` id、`maxSlots: 1` 的 LocalStorage 服务，棋盘、分数、最高分和阶段都进入
   单一存档，不再维护独立 best key。

## 后果

- 游戏可只更换 backend，不重写存档格式和基础工作流。
- 缩略图是可选 data URL，会占用浏览器 quota；产品应按需要缩放画布后再捕获。
- 多设备云同步、账号冲突合并、加密、防作弊和游戏私有数据迁移不在本能力内。

## 验证

- `npm run typecheck -w ./engine`
- `npm test -w ./engine`
- `npm run build -w ./engine`
- `npm run api:check`
- `npm run verify:engine-package`
- `npm run typecheck`（Games）
- `npm test`（Games）
- `npm run build:target -- game:2048`（Games）
