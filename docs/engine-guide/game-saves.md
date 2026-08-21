# 游戏存档

从 `@haiyue/engine/save` 创建一个存档服务，游戏只需要提供自己的 data 和 validator。所有服务方法都是异步的，
因此同一套游戏逻辑可以在 LocalStorage、IndexedDB 或自定义后端之间切换。

```ts
import { GameSaveService, LocalStorageSaveBackend } from '@haiyue/engine/save';

interface PlayerSave {
  level: number;
  position: [number, number, number];
}

const saves = new GameSaveService<PlayerSave>({
  gameId: 'my-game',
  dataVersion: 1,
  backend: new LocalStorageSaveBackend({ namespace: 'my-studio' }),
  maxSlots: 3,
  validateData: value => {
    if (typeof value !== 'object' || value === null) return false;
    const data = value as Partial<PlayerSave>;
    return Number.isInteger(data.level)
      && Array.isArray(data.position)
      && data.position.length === 3
      && data.position.every(Number.isFinite);
  },
});

await saves.save({
  saveId: 'slot-1',
  name: '城堡入口',
  data: { level: 4, position: [12, 1, -8] },
});

await saves.checkpoint({
  name: 'Boss 前',
  data: { level: 4, position: [90, 2, 13] },
});

const slots = await saves.list();
const restored = await saves.load('slot-1');
await saves.delete('slot-1');
```

固定 `saveId` 会动态覆盖同一槽并增加 `revision`；省略 id 会生成新槽。`maxSlots` 在创建新槽前检查，覆盖已有槽
不受影响。`load`、`list` 和 `import` 都会校验信封、data version、游戏 validator 和 checksum；错误使用
`GameSaveError.code` 分类，不应只匹配 message。

## 后端选择

- `LocalStorageSaveBackend`：小型、单槽或少量存档，写入同步但容量较小。2048 使用此后端。
- `IndexedDbSaveBackend`：更大的多槽存档和缩略图，拥有连接的服务可设置 `ownsBackend: true`。
- `MemorySaveBackend`：测试，或把下载文件作为唯一持久制品的会话。
- 自定义后端：实现 `GameSaveBackend`，适合获得 File System Access 授权的宿主或未来云端服务。

文件流程使用 `saves.export(id)` / `saves.import(text)`，也可直接调用 `serializeGameSaveFile`、
`parseGameSaveFile`、`readGameSaveFile` 和 `downloadGameSaveFile`。浏览器下载 API 不能删除用户下载目录里的文件；
只有获得相应目录权限的宿主才能提供文件级 list/delete。

## 缩略图与生命周期

`captureGameSaveThumbnail(canvas)` 可以生成 PNG/JPEG/WebP data URL，传给 `save({ thumbnail })`。缩略图计入
LocalStorage/IndexedDB quota；高分辨率画面应先绘制到较小画布。FNV-1a checksum 只用于发现截断或误改，不是
加密签名，也不能防作弊。

连续自动保存由服务按调用顺序串行执行。需要确保退出前落盘时先 `await saves.flush()`；结束拥有后端的服务时调用
`await saves.dispose()`，销毁后提交的新操作会得到 `E_GAME_SAVE_DISPOSED`。
