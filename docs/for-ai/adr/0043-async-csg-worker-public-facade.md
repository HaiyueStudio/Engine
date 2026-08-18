# ADR 0043：异步 CSG 使用最小 Worker 门面与显式 Worker 失败语义

- 状态：Accepted
- 日期：2026-07-24
- 影响：`@haiyue/engine/geometry`、CSG 示例、稳定 API 门禁

## 背景

同步 `createCSGGeometry`、`csgUnion`、`csgSubtract` 和 `csgIntersect` 适合离线或小规模计算，但交互式 CSG 会在主线程制造 long task。异步实现已经使用 dedicated Worker、prepared geometry handle、transferable 输出与 latest-wins 队列，但首轮接口只导出了工厂函数，工厂返回的 `CSGWorkerClient` 实现类型无法从公开子入口命名。调用者只能通过 `ReturnType` 推导类型，稳定声明也泄漏了内部实现名称。

同时，Worker 不可用、崩溃或协议错误不能静默回退到同步计算，否则看似异步的调用仍可能阻塞页面。

## 决策

1. 异步 CSG 只从 `@haiyue/engine/geometry` 导出，不进入根黄金路径。
2. 稳定公共面严格限定为五个符号：
   - `createCSGWorkerClientFromUrl`
   - `createInlineCSGWorkerClient`
   - `createCSGWorkerSource`
   - `CSGWorker`
   - `CSGPreparedGeometry`
3. 工厂返回 `CSGWorker` 门面。`CSGWorkerClient` 实现类、Worker-like adapter、消息协议、序列化 payload 和响应类型保持内部。
4. `CSGPreparedGeometry` 是单个 Worker 拥有的句柄。运行时必须校验 owner；release 或 dispose 后不得复用。
5. 每个 Worker 只保持一个执行中的 compute 和一个 latest queued compute。较旧请求以 `AbortError` 结束，不能覆盖最新结果。
6. 输入 `Geometry3D` 复制到 Worker payload，不 detach 渲染中的 buffer；结果数组以 transferable 返回。
7. Worker 能力不可用、Worker error、messageerror 和协议错误显式失败。禁止静默同步回退，也不在第一版建立 Worker pool。
8. 现有同步 CSG API 和语义保持不变。
9. `./geometry` 稳定符号预算由 43 调整为 48；根入口仍严格保持 ADR 0035 的 30 个概念。

## 结果

- TypeScript 用户可以直接命名 Worker 与 prepared handle，不再依赖内部实现或条件类型推导。
- 内部队列、协议和 Worker adapter 可以继续演进，不扩大稳定 API。
- 页面响应性不会因能力降级而被隐式同步计算破坏。
- 此变更是稳定 `./geometry` 的纯新增；没有删除、重命名或改变现有同步 API。

## 验证

- `npm run typecheck -w ./engine`
- `npm run typecheck -w ./examples`
- `npm test -w ./engine`
- `npm run api:check`
- CSG 浏览器 E2E：连续触发 20 次只应用最终 generation，rAF 保持响应且无 CSG 导致的 `>50ms` long task。
