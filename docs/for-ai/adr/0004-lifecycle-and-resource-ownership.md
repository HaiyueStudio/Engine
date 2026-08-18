# 0004：生命周期与资源所有权模型

- 状态：Accepted
- 日期：2026-07-10

## 背景

引擎已经包含 Engine、Scene、插件、AssetHandle、renderer cache 和大量 GPU 对象，但资源释放仍分散在各对象中。device lost 当前停止帧循环并发送事件，没有统一恢复协议。随着编辑器 play/restart、场景切换和 worker 加载增多，隐式所有权会导致泄漏和迟到异步结果。

## 决策

1. 所有长期资源必须属于一个 ownership scope：engine、scene、system、plugin、asset 或 frame/transient。
2. owner 负责结束异步任务并逆序释放其资源；`destroy`、`release` 和 `abort` 必须幂等。
3. Engine、Scene、Plugin 和 AssetJob 使用显式状态机，公共 API 在非法状态返回统一领域错误。
4. 所有跨帧异步操作接收 AbortSignal 或等价 job token；owner 销毁后结果不得回写。
5. 可恢复 GPU 资源保留重建 descriptor/source。device lost 后暂停提交、重建 device 与可恢复资源；无法恢复时进入明确 failed 状态并报告 owner。
6. 插件注册行为返回可撤销 token，安装失败和依赖卸载必须完整 rollback。
7. 阶段一记录决策；统一实现和强制测试在路线图阶段四完成。

## 后果

- GPUResourceTracker 将从全局计数扩展为 owner 可追踪的诊断系统。
- renderer 不能再只靠局部约定管理生命周期。
- 某些只保存 GPU handle 的 API 会在阶段四发生破坏式调整，不保留旧形式。
