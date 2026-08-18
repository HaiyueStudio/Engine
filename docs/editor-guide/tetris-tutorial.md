# 使用编辑器搭建 Tetris

本教程使用海月编辑器自带的 **Tetris Starter Kit** 搭建一个完整的 2D Tetris 游戏。完成后可以在编辑器中修改棋盘、颜色、下落速度、输入和脚本，通过 Play 调试，并导出为独立项目。

Starter Kit 只是生成起始场景，不是特殊的运行时黑盒。生成结果仍然由普通 Entity、Component、Script Resource 和全局设置组成，可以继续拆改、保存和导出。

## 最终结果

完成本教程后，场景包含：

- 10×20 的 Tilemap2D 棋盘；
- I、J、L、O、S、T、Z 七种方块；
- 左右移动、旋转、软降、硬降；
- 方块锁定、整行消除、计分、等级和逐级加速；
- 下一个方块、分数和游戏状态 HUD；
- 暂停、重新开始和游戏结束；
- 横屏与竖屏自适应布局。

## 1. 启动编辑器

在仓库根目录执行：

```bash
npm install
npm run build
python3 -m http.server 8080
```

访问 `http://localhost:8080/editor/`。浏览器必须支持 WebGPU。开发编辑器代码时也可以使用 `npm run dev:editor` 持续构建。

如果这是第一次使用编辑器，建议先阅读[启动编辑器](./getting-started.md)和[核心工作流](./core-workflow.md)。

## 2. 创建 Tetris 起始场景

1. 点击顶部工具栏的 **Kits**。
2. 第一次打开时，编辑器会按需加载 Tilemap 扩展；等待列表出现。
3. 选择 **Tetris Starter Kit**。
4. 在 Hierarchy 中确认出现根实体 `Tetris Starter Kit`。

整个 Starter Kit 通过一个编辑器命令加入场景，因此刚创建后点击一次 **Undo** 可以完整移除它；**Redo** 可以恢复。

创建完成后，Hierarchy 应接近下面的结构：

```text
Tetris Starter Kit
├── Tetris Camera2D
├── Tetris Board
├── Tetris Scoreboard
├── Tetris Next Preview
├── Tetris Status
└── Tetris GameManager
```

Resources 的 Script 分类中还会出现 `Tetris GameManager` 脚本资源。

## 3. 运行游戏

点击顶部 **Play**。先在游戏画面中单击一次，让键盘焦点进入 Player，然后使用以下按键：

| 动作 | 默认按键 |
| --- | --- |
| 左移 | `←` 或 `A` |
| 右移 | `→` 或 `D` |
| 软降 | `↓` 或 `S` |
| 顺时针旋转 | `↑`、`W` 或 `X` |
| 逆时针旋转 | `Z` |
| 硬降 | `Space` |
| 暂停/继续 | `P` 或 `Escape` |
| 游戏结束后重开 | `R` |

测试时至少确认以下行为：

1. 方块不能越过左右边界或穿过已锁定方块。
2. 硬降后方块立即锁定并生成下一个方块。
3. 填满一行后该行消失，上方内容下移。
4. 每累计 10 行等级增加，下落间隔缩短。
5. 新方块出生位置被占用时进入 Game Over。

Play 使用隔离的运行时副本。游戏中产生的棋盘状态不会写回正在编辑的场景，这是正常行为。

## 4. 理解生成的场景

### Tetris Camera2D

`Tetris Camera2D` 包含一个 `Camera2D`：

- 设计尺寸：1280×720；
- Zoom：1；
- 负责 Tilemap 棋盘和 HUD 的 2D 渲染。

Starter Kit 同时把场景清屏色设置为深色，并将这个相机设为当前 2D 相机。

### Tetris Board

选择 `Tetris Board`，Inspector 中可以看到：

- `Transform2D`：编辑模式下的棋盘位置；
- `Tilemap2DComponent`：棋盘的网格和调色板。

标准配置为：

| 字段 | 值 | 含义 |
| --- | ---: | --- |
| Columns | 10 | 棋盘宽度 |
| Rows | 20 | 棋盘高度 |
| Cell Width | 32 | 编辑模式单格宽度 |
| Cell Height | 32 | 编辑模式单格高度 |
| Gap | 2 | 单格间距 |

`Palette JSON` 的索引约定如下：

- `0`：透明；
- `1`～`7`：I、J、L、O、S、T、Z；
- `8`：空棋盘背景。

`Cells JSON` 是 Tilemap 的当前单元格数组。Tetris 的真实棋盘状态保存在 GameManager 的运行时 state 中，Play 时脚本会逐帧更新 Cells，因此不要用手工编辑 Cells 的方式保存游戏进度。

### HUD Tilemap

Starter Kit 使用三个独立 Tilemap，避免为简单 HUD 引入图片或字体资源：

- `Tetris Scoreboard`：23×5，以 3×5 点阵数字显示六位分数；
- `Tetris Next Preview`：4×4，显示下一个方块；
- `Tetris Status`：6×1，用不同颜色表示 Playing、Paused 和 Game Over。

它们都可以在 Inspector 中修改单格尺寸、间距和 Palette。

### Tetris GameManager

`Tetris GameManager` 包含三个关键组件：

| 组件 | 职责 |
| --- | --- |
| `KeyboardComponent` | 让脚本读取键盘 action |
| `DataComponent` | 保存可编辑的玩法配置 |
| `ScriptComponent` | 执行 Tetris GameManager 脚本资源 |

初始 `DataComponent` 包含：

```json
{
  "dropMs": 650,
  "kinds": ["I", "J", "L", "O", "S", "T", "Z"],
  "paletteIndex": {
    "I": 1,
    "J": 2,
    "L": 3,
    "O": 4,
    "S": 5,
    "T": 6,
    "Z": 7
  },
  "shapes": {
    "I": [[0, 1], [1, 1], [2, 1], [3, 1]],
    "J": [[0, 0], [0, 1], [1, 1], [2, 1]],
    "L": [[2, 0], [0, 1], [1, 1], [2, 1]],
    "O": [[1, 0], [2, 0], [1, 1], [2, 1]],
    "S": [[1, 0], [2, 0], [0, 1], [1, 1]],
    "T": [[1, 0], [0, 1], [1, 1], [2, 1]],
    "Z": [[0, 0], [1, 0], [1, 1], [2, 1]]
  }
}
```

这些坐标位于一个 4×4 的方块局部空间。旋转时脚本重复应用 `(x, y) → (3 - y, x)`，并尝试 `0、-1、1、-2、2` 的水平踢墙偏移。

## 5. 修改玩法参数

### 调整初始速度

1. 选择 `Tetris GameManager`。
2. 在 Inspector 找到 `DataComponent` 的 JSON。
3. 把 `dropMs` 从 `650` 改为需要的毫秒数。
4. 离开输入框提交修改，然后重新进入 Play。

实际下落间隔由下面的规则计算：

```text
max(110, dropMs - (level - 1) × 42)
```

因此无论等级多高，自动下落间隔都不会低于 110 ms。按住软降时，计时速度变为普通速度的 12 倍。

### 修改方块颜色

1. 选择 `Tetris Board`。
2. 编辑 `Tilemap2DComponent` 的 `Palette JSON`。
3. 保持每个颜色为 `[r, g, b, a]`，取值范围为 0～1。
4. 保持 `paletteIndex` 与 Palette 的 1～7 索引一致。
5. 对 `Tetris Next Preview` 使用同一组 1～7 颜色，保证预览与棋盘一致。

例如将 I 方块改为高纯度青色：

```json
[0.0, 0.95, 1.0, 1.0]
```

### 修改棋盘尺寸

可以修改 `Tetris Board` 的 Columns 和 Rows。GameManager 会读取 Tilemap 的实际行列数，而不是重复保存一份固定大小。

标准 Tetris 推荐保持 10×20。若使用更窄的棋盘，需要同时检查四格长的 I 方块是否仍有合理的出生和旋转空间。

## 6. 查看和修改 GameManager 脚本

在 Resources 中切换到 **Script**，双击 `Tetris GameManager` 打开脚本编辑器。脚本按以下顺序组织：

1. 找到棋盘和 HUD Tilemap；
2. 从 `DataComponent` 读取配置；
3. 在 `component.state` 中初始化棋盘、当前方块、下一个方块、分数和阶段；
4. 处理移动、旋转、碰撞、锁定与消行；
5. 通过 `api.input` 读取 action；
6. 把运行时状态绘制到 Tilemap；
7. 根据 Player 画布尺寸更新横屏或竖屏布局。

这里使用 `component.state`，而不是把每帧状态写回 `DataComponent`。前者是 Play 会话状态，后者是需要序列化的关卡配置。

如果要修改计分规则，在脚本中搜索：

```js
const scoreByLines = [0, 100, 300, 500, 800];
```

数组下标表示一次消除的行数。硬降过程中每下降一格额外增加 2 分。

脚本使用的是 capability API，例如：

```js
api.read.find('Tetris Board');
api.input.wasPressed('MoveLeft');
api.input.isPressed('SoftDrop');
api.debug.console.log('Tetris Starter Kit ready.');
```

不要在项目脚本中保存未登记的全局监听器或计时器。需要监听器或定时器时，应使用 `api.debug.listen`、`api.debug.setTimeout` 或 `api.debug.setInterval`，让 Play 重启和退出可以正确清理。完整规则见[项目脚本运行时](../engine-guide/script-runtime.md)。

## 7. 输入映射

Starter Kit 会把默认 Tetris Input Map 写入 Global Settings。脚本依赖的是 `MoveLeft`、`MoveRight` 等 action，而不是直接依赖某一个键，因此可以更换按键而不改玩法逻辑。

默认映射等价于：

```json
{
  "MoveLeft": ["ArrowLeft", "KeyA"],
  "MoveRight": ["ArrowRight", "KeyD"],
  "SoftDrop": ["ArrowDown", "KeyS"],
  "HardDrop": ["Space"],
  "Rotate": ["ArrowUp", "KeyW", "KeyX"],
  "RotateCW": ["ArrowUp", "KeyW", "KeyX"],
  "RotateCCW": ["KeyZ"],
  "Pause": ["KeyP", "Escape"],
  "Restart": ["KeyR"]
}
```

修改映射时必须保留脚本使用的 action 名称，或者同步修改 GameManager 脚本。

## 8. 响应式布局与设备预览

GameManager 在 Play 中读取 `player-canvas` 的实际显示尺寸，并重新计算：

- 棋盘单格大小；
- 棋盘位置；
- 分数 HUD；
- 下一个方块预览；
- 状态 HUD。

因此在编辑模式中直接拖动这些实体，只会改变静态起始位置；Play 后位置仍会被响应式布局覆盖。若要永久调整运行时布局，应修改 GameManager 的 `updateLayout()`。

建议至少验证两种设备预设：

1. 1280×720 横屏；
2. 390×844 竖屏。

在 Play 面板切换设备、DPR 和缩放，确认棋盘没有超出画面，HUD 不与棋盘重叠。更多内容见[Play、调试与导出](./play-debug-export.md)。

## 9. 保存和导出

搭建完成后：

1. 点击 **Save As**，保存可继续编辑的场景 JSON。
2. 再次打开该 JSON，确认 Script Resource、Tilemap Palette、DataComponent 和 Input Map 都能恢复。
3. 点击 **Play** 做一次保存后回归测试。
4. 点击 **Export Project** 生成独立项目 ZIP。
5. 用 HTTP 静态服务器启动导出的项目，不要直接使用 `file://` 打开。

仓库也保存了一份可直接打开的参考场景：

- [`editor/scene-examples/tetris-starter.scene.json`](../../editor/scene-examples/tetris-starter.scene.json)

独立代码版 Tetris 位于：

- [`games/tetris/main.ts`](../../games/tetris/main.ts)

前者用于验证编辑器内容生产和运行时导出链路；后者适合对照不经过编辑器的直接引擎集成方式。

## 10. 从空场景手工重建

如果不使用 Starter Kit，可以按以下清单手工重建，以理解各部分依赖：

1. 创建根实体 `Tetris Starter Kit`。
2. 添加 `Tetris Camera2D`，并加入 `Camera2D`。
3. 添加 `Tetris Board`，并加入 `Transform2D` 和 10×20 的 `Tilemap2DComponent`。
4. 创建 Scoreboard、Next Preview 和 Status 三个 HUD Tilemap。
5. 创建 `Tetris GameManager`，加入 `KeyboardComponent`、`DataComponent` 和 `ScriptComponent`。
6. 在 Resources/Script 新建脚本资源并绑定到 ScriptComponent。
7. 配置 Global Settings 的设计尺寸、清屏色和 Input Map。
8. 将 GameManager 脚本拆成初始化、碰撞、移动、旋转、锁定、消行、绘制和布局八个部分。
9. 依次测试移动、旋转、硬降、消行、暂停和 Game Over。
10. 保存、重新打开、Play，并最终导出项目。

手工创建时，实体名称也是当前 Starter 脚本的查找契约。棋盘有 10×20 Tilemap fallback，但 HUD 仍按名称查找；如果重命名 `Tetris Scoreboard`、`Tetris Next Preview` 或 `Tetris Status`，必须同步修改脚本。

## 常见问题

### Kits 中没有 Tetris Starter Kit

Starter Kit 依赖按需加载的 Tilemap 扩展。第一次展开 Kits 时等待加载完成；如果仍未出现，查看编辑器错误面板中是否有 Tilemap capability 加载失败。

### Play 后看不到棋盘

确认场景包含有效的 `Camera2D`、`Tetris Board` 包含 `Tilemap2DComponent`，并检查 Player 的结构化错误和脚本日志。不要只根据编辑器 Viewport 判断 Play 会话状态。

### 按键没有反应

- 先单击 Player 画布获取焦点；
- 确认 GameManager 仍有 `KeyboardComponent`；
- 确认 Global Settings 的 Input Map 包含对应 action；
- 检查脚本是否因为早期异常被自动禁用。

### 修改位置后 Play 中又变回去了

这是响应式 `updateLayout()` 在工作。修改脚本中的布局规则，而不是只调整编辑模式下的 Transform2D。

### 修改脚本后游戏状态没有重置

退出并重新进入 Play，或者使用 Play 面板的 Restart。Play 运行时 state 与编辑文档分离。

## 完成检查

- [ ] Starter Kit 可以通过一次操作创建并通过 Undo 完整移除。
- [ ] 七种方块都可以生成、移动和旋转。
- [ ] 软降、硬降、暂停和重开输入正常。
- [ ] 单行和多行消除会正确更新分数、行数和等级。
- [ ] 横屏和竖屏预览没有溢出或 HUD 重叠。
- [ ] 保存后重新打开仍能运行。
- [ ] 导出项目可以通过 HTTP 正常启动。
