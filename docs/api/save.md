# `@haiyue/engine/save`

稳定的游戏存档子入口。完整签名以 `engine/dist/save.d.ts` 为准。

## 核心类型

- `GameSaveEnvelope<TData>`：版本化通用信封，包含 id、名称、game id、日期、revision、data version、私有 data、
  可选 metadata/thumbnail 和完整性 checksum。
- `GameSaveService<TData>`：按序执行 save/checkpoint/load/list/delete/import/export，支持固定槽、多槽和 `maxSlots`。
- `GameSaveBackend`：存储 SPI；内置 `LocalStorageSaveBackend`、`IndexedDbSaveBackend` 和 `MemorySaveBackend`。
- `GameSaveValidationResult` / `validateGameSaveEnvelope`：检查字段、JSON 数据、版本、游戏 validator 和 checksum。
- `GameSaveError` / `GameSaveErrorCode`：稳定、可分类的失败语义。

文件 API 为 `serializeGameSaveFile`、`parseGameSaveFile`、`readGameSaveFile` 和 `downloadGameSaveFile`；缩略图 helper
为 `captureGameSaveThumbnail`。浏览器下载不包含对用户下载目录的枚举或删除权限。

错误码包括 invalid envelope/data、not found、conflict、slot limit、storage unavailable、quota exceeded、
serialization failed、unsupported operation 和 disposed。FNV-1a checksum 用于发现意外损坏，不是安全签名。

使用示例和后端选择见[游戏存档指南](../engine-guide/game-saves.md)，长期边界见
[ADR 0086](../for-ai/adr/0086-game-save-envelope-and-storage-backends.md)。
