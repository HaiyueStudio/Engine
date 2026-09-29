# G04 Shader 预算与构建期 import 评估

> 实施更新：用户已批准本建议，当前透明完整灯表范围的 570,000 B 预算、构建期 include 与 Artifact 去重已实施。实测和验证见 [实施报告](g04-budget-import-application.md)。以下保留提案时的评估与历史数据；600,000 B 仍仅是未来完整 G04 的规划参考。

日期：2026-09-27。状态：**提案，未应用预算、未修改运行时或生成器**。对应[实测与内存预算模拟](g04-budget-import-analysis.json)。本次只回答预算与复用机制的设计问题，不表示 G04 已完成。

## 结论

1. 对当前已实现的透明完整灯表能力，建议 WGSL 总字节上限 **570,000 B**，文件 **75**、静态变体/声明 pipeline **各 67**。
2. G04 后续若增加一个不透明扩展材质代理表面 pass，可将 **600,000 B / 76 文件 / 68 变体与 pipeline** 作为有条件的规划上限。必须以实际实现、像素与成本证据重新核定；不是预先放开任意额外 pass。
3. 引擎已经有模块依赖/符号导入和公共 WGSL 拼接。建议在这些设施上补一个**构建期文件引用入口**，让 WGSL 作者直接引用模块，不另建平行的运行时编译系统。
4. `include` 展开本身不会降低最终自包含 WGSL 总字节或静态变体数量。当前还有一个直接的包体优化机会：把已有 PBR 变体字符串去重方法应用到新 Deferred 家族。

## 预算依据

| 指标 | 现有上限 | 当前实测 | 当前能力建议 |
| --- | ---: | ---: | ---: |
| 全部生成 WGSL 字节 | 418,480 | 555,236 | 570,000 |
| 生成 WGSL 文件 | 71 | 75 | 75 |
| 静态变体 | 63 | 67 | 67 |
| 声明 pipeline | 63 | 67 | 67 |

注意：这里的 pipeline 是生成器统计的 pass 数，不是运行时由于深度格式、透明混合、拓扑、实例化等组合形成的全部 GPU pipeline 实例。

G03 实测为 417,394 B；当前差额 **137,842 B** 全部来自四个已验证的 full Forward PBR 变体（34,454 / 34,459 / 34,462 / 34,467 B）。保留静态变体是为维持已有 clearcoat/transmission 特化与纹理绑定语义；本轮不凭推测把分支并成一个动态大 Shader。

570,000 的计算方式为 `(当前 555,236 + 新增能力 137,842 × 10%)` 向上取整到千字节；余量 **14,764 B**，约为新增代码的 10.71%。并未给所有旧代码统一增加 10%。文件/变体/pipeline 只增加实际新增数量，不额外留数量余量。

历史 growthBaseline 保持 **305,504 / 64 / 56 / 56**，对应 maxGrowth 改为 **264,496 / 11 / 11 / 11**。现有验证器的内存模拟通过；四项绝对上限均验证等于上限通过、超过 1 拒绝。实际预算文件没有改动。

后续代理表面若独立生成：现有 G-buffer 源码为 **21,778 B**，只能作为估算参照。假设新增规模相当，预计总量 **577,014 B**，加上新增能力整体的约 10% 余量后约 592,976 B，因此以 **600,000 B** 作为规划值合理。对应 maxGrowth 为 **294,496 / 12 / 12 / 12**。如果通过复用现有 pass 避免新增完整 Shader，则应下调这个规划，不消费虚构余量。

不建议同时增加冷生成时间、默认 consumer gzip、npm 包体、CPU/GPU 帧时间或资源预算。WGSL 展开字节增长不能证明这些指标必然增加；公开 Deferred 入口时需要 G07 重新测量真实发布产物。

## 已有的模块能力

- `shader-language/src/moduleLinker.ts`：依赖排序、重复模块去重、循环检测、显式符号 import/export、stage/capability 校验与符号命名。
- `shader-language/src/composer.ts`：组合模块，生成源码映射及反射。
- `shader-language/src/material-lighting/definitions.ts`：将 fog、SceneFrame、clipping、morph、skinning、BRDF、clearcoat、sheen、shadow 与 PBR 主体拼接；四变体共享作者源文件。
- `scripts/rollup-plugin-wgsl.js`：目前只把 WGSL 读取为字符串，没有文件级 include。
- `shader-language/scripts/shader-source-variant.mjs`：已能将逐行差异生成共享基础字符串的无损切片表达式；旧 PBR artifact 已使用，新 Deferred full Forward artifact 仍直接导入四份完整源码。

因此缺少的是更统一的作者入口和对新增家族的打包复用，不是从零开始实现 Shader 模块化。

## three.js 对照

three.js 的 WebGL 路径使用 `#include <chunk>`，在 `WebGLProgram` 内递归替换为 `ShaderChunk` 的字符串，再创建/编译完整 Shader。它并不是 GPU 原生模块 import，也不是必须发生在应用打包阶段。[官方源码](https://github.com/mrdoob/three.js/blob/dev/src/renderers/webgl/WebGLProgram.js)

我们的方案把这一展开步骤放在 Shader Language 构建期。WGSL 最终提交完整模块；`#include` 是工具输入语法，不应进入最终 WGSL 或直接交给 WebGPU。[WGSL 模块规范](https://www.w3.org/TR/WGSL/#module)

## 建议的构建机制

可在专门的作者模板中提供类似语法（以下为提案，不是已支持 API）：

```text
#include <scene/frame>
#include <deformation/morph>
#include <deformation/skinning>
#include <pbr/brdf>
#include <pbr/surface>
```

构建过程：注册的模块 ID → 依赖解析与去重 → 特化/现有编译流程 → 展开源码与反射校验 → 完整 WGSL + Artifact + 来源映射。

具体约束：

- 由 Shader Language 的生成器统一展开；Engine 的通用 raw loader 保持简单，不能在 artifact hash 已生成后再偷偷改变源码。
- 首期仅开放给仓库内受信任的 WGSL 模块，复用既有 Typed IR/模块合同；Material Graph JSON 不获得文件路径、任意 WGSL 或网络引用能力。
- 模块以声明和函数为单位，每个输出 Shader 同一模块只展开一次；不支持任意语句块插入和复杂 C 预处理宏。
- 缺失模块、循环依赖、同 ID 不同内容、符号与绑定冲突直接报错。保留 frame/object/material/pass 资源所有权。
- 依赖文件加入生成器缓存和 watch；任一传递依赖变化必须失效。映射错误位置到原始模块文件和行号。
- 优先逐字节保持展开结果和 artifact hash；来源元数据需要变化时单独记录，不把 hash 改动误认为渲染语义必然变化。
- 首个落地点是 PBR/Deferred 共用模块及完整灯表适配器，逐步减少当前生成器对完整 Shader 做定点字符串替换的耦合。

## include 与包体去重的不同收益

| 手段 | 作者维护重复 | 实际 JS/压缩传输体积 | 展开 WGSL / GPU 编译输入 | 静态变体数量 |
| --- | --- | --- | --- | --- |
| 构建期 include 后输出完整 Shader | 降低 | 通常仍重复，需另测 | 通常不变 | 不变 |
| Artifact 共享字符串与变体差异 | 不直接解决 | 可下降 | 相同 | 不变 |
| 编译器移除不可达函数/死分支 | 不直接解决 | 可下降 | 可下降 | 通常不变 |
| 减少静态变体或改变算法 | 取决于设计 | 可能下降 | 可能下降 | 可下降，但需性能与像素验证 |

### 当前数据的小型无损实验

仅以四份 Deferred WGSL 字符串声明为输入，复用已有 `emitLineVariantExpression` 生成共享基础字符串与差异，再在 Node 中还原并逐字节检查四份输出一致：

| 表示 | JS 源码字节 | gzip level 9 |
| --- | ---: | ---: |
| 四份完整字符串 | 141,532 | 28,588 |
| 一份基础字符串 + 三份差异 | 37,257 | 8,093 |

该实验不含 artifact 反射、渲染器或实际 Rollup 结果，**不是 npm 包体收益证明**。它表明当前存在值得实作并重新打包测量的重复存储，且无需改变 Shader 语义。两种表示展开后 WGSL 都是 **137,842 B**，所以不能拿 37,257 B 代替当前门禁的展开字节数。

共享字符串是在 JS 模块装载时做固定字符串拼接，不是运行时解析 include、查文件或编译 Shader 语言。若要求客户端完全不做这种固定拼接，则保留构建期输出完整 WGSL，并接受跨变体展开字节的重复。

## 建议执行顺序

1. 对当前完整灯表四变体复用已有 artifact 字符串/反射去重，逐字节验证、真实 Rollup/gzip 与 native 双 GPU 复测；不改 WGSL 成本统计。
2. 增加统一构建期 include 作者入口，以既有模块设施为基础，覆盖循环/缺失/重复/缓存/source map 测试。
3. 按具名能力应用对应预算：当前部分 570,000；完整 G04 根据代理表面实际实现重新核定，规划参考 600,000。
4. 单独研究可信的函数可达性裁剪及资源反射同步；不通过正则删除函数，不承诺仅加 include 就降低 GPU 编译成本或提升 FPS。

预算、源码唯一存储字节、实际压缩包体、GPU 编译/帧时间分别记录；新增指标可辅助审计，不能替换旧指标使门禁变绿。
