# 多光源实验室

运行 `npm run build:target -- example:deferred-lighting`，用仓库静态服务器打开 `/examples/deferred-lighting/`。需要 WebGPU；只从公共 Engine 包入口导入，无独立 UI 库依赖。

## 操作

- 顶部选择 **Tiled Deferred / Deferred 全灯参考 / Forward**，以及 1、8、9、32、128、256、512、1024 盏灯。切换保留相机、灯位置和参数。
- 分散场景展示局部彩色照明；高重叠自动扩大半径，观察剔除收益下降。512/1024 是压力档，旧设备可能明显变慢。
- 暂停运动后比较路径。重置回固定种子和相机；`?regression=1` 初始暂停，`?count=256&path=reference&overlap=1` 可预设场景。
- “观察第 9 盏灯”切为 9 盏、暂停并仅保留第 9 盏；开关它可观察地面/物体照明变化。“只保留选中灯”关闭后恢复其他启用灯。这个演示证明逐灯贡献；Forward 的选择算法不保证按序丢弃第 9 灯。
- 范围 helper 是独立 Canvas 投影，避免特殊 3D helper 触发全视图 Forward 回退；标记忽略遮挡，只用于定位，不是发光几何体。
- GPU 热力图显示当前实际 tile 列表：青色少灯、橙色多灯、粉色完整灯表回退。为了展示真实列表，该模式强制执行剔除；退出后恢复普通策略。它不用于性能比较。
- G-buffer 显示基础色/金属度、法线/粗糙度、自发光/材质 AO、设备深度。世界坐标由真实 depth32float 和相机逆矩阵重建，XYZ 分别映射 RGB。透明球经完整灯表 Forward 合成，不进入 G-buffer。

## 读数与限制

有效数为当前启用的点光源；Deferred 的提交数来自实际完整源表。当前路径保守提交完整点光源表，再按 tile 剔除；tile 引用数不能当作唯一光源数。Forward 的 8 个槽包含环境灯，UI 只报上界，不虚构实际选择数；超限场景画面不等价，不显示加速比。

CPU 为 engine record 阶段；GPU 为异步 timestamp 的 pass 合计，可能对应较早帧，带帧编号。无 timestamp 时明确 unavailable，帧间隔不冒充 GPU 耗时。面板值不是 P95、正式 FPS 承诺或 G05 性能资格。读回最多 2 Hz，调试开销包含在交互成本中。

Deferred 分配为 backend 跟踪估算，不等于整个应用或驱动驻留显存；更多上传/pass 统计在折叠面板中。渲染分辨率按实际 canvas 记录，缩放上限 1280×720，设备 DPR 不会隐式扩大负载。

局部灯无阴影；示例包含标准 PBR 不透明与透明材质，不覆盖所有特殊材质。材质/设备导致回退时显示实际策略和原因；设备初始化失败显示错误。Scene 拥有资源，pagehide 清理控制器、监听器、观察器、定时器、profile 和 engine。

## 验证

`node --test scripts/verify-deferred-lighting-model.test.mjs engine/test/deferred-example-profile.test.mjs`

`node scripts/verify-deferred-lighting-example.mjs`（本机 Chrome + native WebGPU）

截图和原始验证结果：`artifacts/engine-0.2.1/g06/`。这不是跨引擎基准；横向对比和设备分档另由 M18 G08 规划。
