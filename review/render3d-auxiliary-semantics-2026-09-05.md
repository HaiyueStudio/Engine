# Render3D 辅助 pass 几何和材质语义修复

## 行为

- depth、normal 按主材质的深度写入规则选择表面。Basic 使用 `depthWrite`，PBR / Toon blend 和 BlinnPhong alpha blending 不写入辅助深度，Volume 不以包围几何写入辅助深度。
- motion 延续主视图 opaque / alpha-test 列表策略；透明混合与折射物体没有单层速度表示，本次没有给它们引入新的合成模型。
- PBR mask 的深度、法线、运动向量、两种轮廓遮罩与方向光阴影复用主 PBR renderer 的材质 uniform、baseColor 纹理和 sampler，使用同一 alpha factor、cutoff、UV channel 与 UV transform。opaque 和 blend 不引入主 shader 没有的 discard。
- 剔除和正面绕序遵循原材质覆盖值及 geometry 回退值。双面 PBR / Toon 不会在辅助 pass 中退回单面；阴影的默认材质注册也保留 geometry 的剔除设置。
- normal 使用与 PBR 相同的 morph position / normal 数据打包及蒙皮实现，顺序为 morph → skin → model inverse-transpose → view direction。Basic / PBR / Depth / Normal 参与 GPU 变形；已有静态顶点路径保持静态。
- PBR mask 的主画面批量绘制与 prepare 现在选择同一对象表，避免辅助纹理有物体而主画面读到未准备的批量对象数据。
- 阴影启用已有片元入口，使 clipping 和 alpha-test 真正执行。不同覆盖绑定不会合并成同一个实例 draw；纹理异步加载完成会使阴影缓存失效，离开摄像机但仍投影的 mask 材质由阴影使用记录维持存活。

## 资源与内部 shader 接口

`AuxiliaryMaterial.ts` 负责覆盖绑定，PBR renderer 保持纹理和材质 buffer 的唯一所有者。辅助 pass 不启动第二次图片加载，也不复制 PBR uniform；销毁辅助 renderer 只释放它自己的 opaque fallback。

group 2 的 binding 1 / 2 / 3 分别为覆盖参数、baseColor 纹理、sampler，binding 0 保留 depth / normal 自身参数。覆盖 uniform 使用 PBR ABI 前 192 字节至 baseColor UV rows。motion 的当前 / 历史蒙皮绑定移至 group 3，历史数据仍为 240 字节；消费者必须使用本次共同生成的 reflection / artifact，旧 binding layout 会被运行时契约校验拒绝。normal 对象表由 128 字节增加到 160 字节，包含 morph weights 和 deformation flags。

所有 WGSL 与反射由 deformation / simple-3d 编译源生成，没有新增静态 shader 变体。局部生成器增加 `--family=simple-3d`，避免更新辅助 shader 时消费正在编辑的 2D shader 输入。

法线纹理仍是几何法线，不包含 PBR normal map / clearcoat normal map 的光照细节。自定义顶点位移和自定义材质覆盖需显式扩展辅助 pass 契约，本修复没有推断任意用户 shader 的语义。

## 回归入口

- `node --test engine/test/auxiliary-material-semantics.test.mjs`
- `node scripts/verify-webgpu-auxiliary-semantics.mjs`：7 组实际 GPU 像素检查，报告写入 `artifacts/webgpu/auxiliary-semantics-diagnostic.json`。
- `node scripts/verify-webgpu-postprocess-multiview.mjs`：已有多视图辅助纹理生命周期回归。
- `node scripts/verify-webgpu-shader-language-stage10.mjs`：全部 deformation shader 编译、反射和历史速度像素检查。

诊断报告包含源码指纹、git 状态、浏览器与 GPU 信息，不作为正式性能验收结果。

## 验证结果

- 全仓 `npm run typecheck` 通过。
- 全仓 `npm test` 通过：shader-language 112、engine 583、animation-spec 139、extensions 372、示例目录 7，共 1,213 项。
- 根目录 `npm run build` 通过；示例范围用 `EXAMPLE_FILTER` 限定为 normal-material、outline-postprocess、pbr-showcase、motion-blur、shadow-map，同时构建共享 Engine bundle 和 source viewer，共 7 个产物通过 freshness 检查。本次未重建全部示例。
- 实际 WebGPU：辅助语义 7 组像素检查、多视图生命周期 5 帧检查、stage10 全部 9 个 deformation pass 与运动历史像素检查通过，未发现 GPU validation error。
- `modules:check`、`renderer-prepare:check`、`fast-gate-policy:test` 通过；追加的 stage9 法线绑定契约与共享浏览器测试共 10 项通过。
- stage9 验证器同步当前内置 shader 的精确数量（16 个 pass、41 个布局，包括已有 indexed-sprite 和本次增加的 normal group 3）；没有修改像素容差或删除用例。

## 已知门禁限制

本次生成 WGSL 总量为 351,516 字节，比修复前 HEAD 的 337,454 字节增加 14,062 字节，主要来自各辅助 shader 的 alpha 覆盖代码与 normal 的变形实现；静态变体数未增加。仓库 328,000 字节上限在修复前已超出，本次进一步增加体积，因此 `shader-language:check` / stage14 DAG 的体积门禁仍失败。没有修改预算阈值或统计口径。

另外，既有 `Render3DSystem.ts` 行数预算（1273 / 1270）和其他模块的 API 基线漂移仍会影响全仓检查；本次在该 orchestrator 中只替换两处依赖注入调用，没有增加行数。

stage9 浏览器大合集在 Animation2D 像素用例失败（实际 `0,0,0,0`，期望 `96,0,159,96`）；该用例及 2D shader 不在本次修改范围。simple-3d 法线由上述辅助语义像素回归单独验证。
