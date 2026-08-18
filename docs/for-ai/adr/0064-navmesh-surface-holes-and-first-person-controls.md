# ADR 0064：NavMesh 局部表面采样与第一人称移动

- 状态：Accepted
- 日期：2026-07-31

## 背景

单层高度场已经会把缺失三角形、非有限高度和显式不可行走格记录为无效表面，路径查询也会避开这些格子；但公开 API 只有 `projectPoint()`。该方法会搜索最近可达点，不适合逐帧判断角色脚下是否是洞，否则角色会被跨洞吸附到边缘。

引擎同时缺少一个可复用的第一人称输入与基础运动控制器。把 NavMesh、Pointer Lock 和球体示例逻辑耦合在一起会使控制能力不能复用，也会让导航层错误承担连续碰撞职责。

## 决策

1. `NavBackend` 增加局部 `sampleSurface()` 查询；它只检查输入 X/Z 所在表面，不搜索其他 cell，返回 `null` 明确表示洞、边界、净空不足或查询期障碍。
2. `projectPoint()` 继续负责最近点投影，`sampleSurface()` 负责局部支撑判断，两者语义不合并。
3. `FirstPersonControls` 从稳定子路径 `@haiyue/engine/controls` 导出，不加入 30 符号根黄金入口。controls 预算经评审由 7 增至 9，仅增加 class 与 options 两个符号。
4. 控制器以 `groundProbe(position) => height | null` 注入地面来源，不直接依赖 NavMesh 或物理后端；支持 Pointer Lock/拖拽降级、WASD、Shift、Space、重力、低台阶阈值、洞下落、`teleport()` 复位与 dispose。
5. 控制器是非渲染 `System`，默认优先级 -100，在相机快照和渲染准备前更新；也允许宿主在场景更新前显式调用 `step(deltaMilliseconds)`。

## 边界

- 本轮支持的是 Y-up 单层表面的洞和断面，不表示洞穴内部、隧道上盖、叠层桥梁或任意重力。后者仍需要独立的分层 polygon backend。
- 分层 backend 只能在 [ADR 0066](./0066-evidence-driven-large-capability-admission.md) 的真实重叠表面路线证据通过后进入原型，普通地面洞口不构成准入证据。
- NavMesh 只提供表面和路径语义。墙体连续碰撞、胶囊 sweep、斜坡接触和移动平台应由物理/角色控制后端提供。
- `groundProbe` 返回 `null` 时控制器允许水平进入并受重力下落，这是游戏角色穿过地面洞所需的行为；AI 导航仍通过 `findPath()` 绕洞。

## 验证

- 单测覆盖几何体开洞、局部采样与最近点投影的语义差异、路径绕洞。
- 单测覆盖 Pointer Lock 视角、WASD、跳跃落地、高台阶阻挡、跳上台阶、洞下落和监听器销毁。
- `examples/navmesh-first-person` 使用同一 grid 同时生成可视地形和 NavMesh，展示球穿过洞口并重生，以及五级需要跳跃的台阶。
- `npm run verify:navmesh-first-person` 在真实 Chrome/WebGPU 示例中派发 PointerEvent/KeyboardEvent，确定性验证前进、高台阶阻挡、跳上台阶、洞下落、复位、dispose 后无输入残留和 GPU validation error 为零；该命令由 `verify:render` 消费，因此进入 slow/full gate。
