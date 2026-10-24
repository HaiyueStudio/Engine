# HYA 组合播放

问题：文本、布局、数据、状态与资源分别运行时，重绑定或异步更新可能与当前绘制代次脱节。

方法：组合 Player 以一次帧事务驱动原有 owner；宿主借用 Scene、资源、字体、音频及语义服务。首个必需资源未就绪时保留上一帧，返回 `ready: false`；失效回调通知调用方再次推进。

首次激活渲染场景前，使用同一个零步长请求推进到 `ready: true`，再启动场景与渲染循环；等待期间保留相同 sequence、viewport 和 DPR。浏览器示例与 Native 入口使用同一启动屏障。

| 子路径 | 工厂 | 归属 |
| --- | --- | --- |
| `@haiyue/extensions/hya-player` | `createHyaPlayer` | 组合状态、时间、数据与真实绘制 |
| `@haiyue/extensions/hya-text` | `createHyaTextShaper` | 一次 prepared-font acquire／release |
| `@haiyue/extensions/hya-layout` | `createHyaLayout` | 原布局求值器，借用已准备的 text |
| `@haiyue/extensions/hya-data` | `createHyaData`、`createHyaSemantics` | 原数据事务、语义树与订阅 |
| `@haiyue/extensions/hya-audio` | `createHyaAudio`、`createBrowserHyaAudioHost` | 原音频调度，借用显式 AudioContext |

格式入口是 `@haiyue/animation-spec/hya-production`。新工厂不进入 extensions 根入口。

[组合与模型绑定示例](../../examples/hya-production/main.ts)使用四个组合 part、实际字体和 PNG；资源与场景逐项校验 SHA-256，字体许可随示例保留。GUI 输入框写入同一个数据事务，按钮控制暂停／恢复及状态切换；该示例不代替音频、语义或物理设备完整资格。

```ts
import {createHyaPlayer} from '@haiyue/extensions/hya-player';

const player = await createHyaPlayer(source, {
  mode: 'render', scene, viewport: [800, 600], dpr: devicePixelRatio,
  host: {
    capabilities: new Set(['org.haiyue.layout-2d@1', 'org.haiyue.data-binding@1']),
    invalidate() { requestAnotherFrame(); },
  },
});
player.data?.run(write => write.set({part: 'data', id: 'root'}, ['label'], 'A'));
const frame = player.advance({sequence: 1, deltaSeconds: 0, viewport: [800, 600], dpr: devicePixelRatio});
// An exact repeat of the same sequence/request returns the same committed frame.
player.dispose();
```

结论：每个 Player 隔离模型重绑定、资源代次和提交序列。`pause`／`resume`／`seek`／`setRate` 沿用原时间线；解锁音频须在实际用户手势中调用 `unlockAudio()`。无 DOM／GPU 的 `mode: 'evaluate'` 使用同一求值与字节资源协议；缺少必需端口明确失败。

## 独立资源与几何

独立 `createHyaData` 使用本地 ID；显式地址的 `part` 为 `''`。组合 Player 使用来源中的 part ID，拒绝跨 part 的隐式同名推断。

data 文档不含资产目录。独立资源替换通过 options 的可选 `resourceCatalogue` 声明 `{kind, id, integrity}`，SHA 格式与布局资产的 `sha256-<base64>` 相同；传入的资源端口收到该预期 SHA。缺少目录、未知身份或错误 handle 明确失败。目录不会触发隐式加载。

`replaceResource` 的 Promise 表示候选就绪；下一 `advance` 才提交资源与排队数据。待就绪期间阻止半帧提交，旧句柄在成功推进后释放。观察者可排队下一帧事务；提交后观察者错误或被拒 intent 的异常带 `committed: true` 和已提交 `changes`，不可据异常重放既有事务。

布局 node／instance 的可选 `transform` 把局部拟合坐标映射到共同视口；rect、glyph 和 clip 仍为局部坐标。平台语义 bounds 使用对应的轴对齐包围框，精确命中使用原逆变换。

text 工厂拥有其字体租约；layout 借用 text，不会替调用方销毁它。语义工厂仅在几何有效后发布，失败恢复原语义 revision／公告；销毁只取消本实例的动作订阅。audio 工厂准备保持静音，关闭 owner 不关闭调用方的共享 AudioContext。

完整可运行的最小来源及自制字体见 [组合示例](../../examples/hya-production/index.html)。该例说明组合和模型重绑定；完整 G11 的字体／资源、原生输入、性能和设备资格另行验收，既有拒绝能力与预算保持。

## 共享文本与可编辑字体宿主

`@haiyue/engine/text` 的 `textGraphemeBoundaries(text)` 返回固定 Unicode 字素的 UTF-16 边界，不加载 GUI／DOM／GPU。HYA 的输入 valuePort 替换整个值；未改动字素前后缀保留作者样式，替换继承首个被替换字素，插入继承前一字素（段首取首字素）。

显式 `HyaFontPort` 的 `shape` 接收可选 `editingViewport`。需要 GUI 编辑时，返回 `HyaTextResult.editing`：`text`、`carets: {offset, line, rect}[]` 与 `cells: {start, end, line, rect}[]`。偏移为逻辑 UTF-16 字素边界，`rect` 为块局部逻辑像素的四元组，`line` 索引返回的行。提供与 glyph 相同整形结果的光标／选区几何；原 G06 继续拥有缓冲、IME、滚动和 undo，宿主无需另建编辑器。错误几何会保留上一已提交帧及数据。

旧宿主可省略编辑几何，用于非编辑文本。默认字体端口会拒绝其无法实现的 variation 或 synthetic 字体请求；有对应能力的显式宿主仍可通过同一 `HyaFontPort` 提供真实 glyph、度量与几何，资源释放保持一次 acquire／release 的归属。
