# 故障排查与 issue 信息

先记录稳定错误的 `code`、`path`、`hint`、`docsPath` 和 `context`，再按下面分类排查。不要通过关闭验证、使用软件 adapter 或改用 `file://` 隐藏问题。

## HTTPS、localhost 与局域网

WebGPU 需要 secure context。`http://localhost` 和 `http://127.0.0.1` 可用于本机开发；局域网 IP 必须使用受信任 HTTPS。仓库示例的标准命令是：

```bash
npm run dev:examples
npm run serve:examples:lan
```

HTTPS 服务默认监听 `0.0.0.0:8443`，证书生成、Windows CA 导入、防火墙和 AP isolation 检查见[浏览器与设备要求](./browser-requirements.md#在局域网设备上预览示例)。`--http` 只用于连通性诊断，不用于 WebGPU 验收或性能证据。

## WebGPU adapter 与 profile

`E_WEBGPU_UNSUPPORTED` 表示浏览器没有可用的 WebGPU API；`E_WEBGPU_ADAPTER_UNAVAILABLE` 表示 API 存在但浏览器没有返回 adapter；`E_WEBGPU_CONTEXT_UNAVAILABLE` 通常指 Canvas/context 或页面环境错误。

Haiyue 的 stable 构造参数选择 RenderProfile，不提供绕过浏览器策略的“强制某块显卡”开关。多 GPU 系统应在操作系统或浏览器图形设置中选择高性能/节能 GPU，然后完全重启浏览器，并在诊断中核对实际 adapter。远程桌面、WARP、SwiftShader、llvmpipe 等软件 adapter 不能作为物理设备 evidence。

optional feature 缺失时读取 `engine.capabilities.report` 或 `capabilities-resolved` 事件；不要只根据请求的 profile 名称判断实际启用能力。

## Worker、资源 URL 与部署 base path

- 页面、Worker、Wasm、glTF buffer/texture、HYA resource 和字体都必须由 HTTP(S) 返回正确 MIME；跨源资源同时需要 CORS。
- Worker URL 使用 `new URL('./worker.mjs', import.meta.url)` 或由宿主注入的绝对 URL，并允许 CSP 的 `worker-src`。不要依赖开发服务器根目录的偶然路径。
- 资产 URL 使用 `new URL('./asset.bin', import.meta.url)` 或以已加载文档的最终 URL 为 base。HYA delivery package 的相对资源相对于 fetched HYA URL（包括 redirect 后 URL）解析。
- 应用部署到 `/products/demo/` 等子路径时，应直接验证该 base path；不要只在 `/` 运行成功后假设 Worker 和资源仍可找到。
- `E_WORKER_PROTOCOL_INVALID` 还可能表示 transferable 被重复使用、消息不可结构化克隆或响应 schema 不匹配；对应错误页列出了需检查的具体 path。

在 Network 面板核对失败请求的最终 URL、状态码、Content-Type、CORS/CSP 响应和响应字节数。不要用 catch 后同步执行同一重任务来伪装 Worker 成功。

## Device lost

监听 `device-lost`、`recovery-progress`、`device-restored` 和 `recovery-failed`。恢复期间停止对旧 device GPU 对象的写入，取消上传；恢复后重新读取 capability report，因为 optional feature 可能发生变化。

```ts
engine.on('recovery-progress', ({ detail }) => {
  console.info(detail.phase, detail.completed, detail.total);
});
engine.on('recovery-failed', ({ detail }) => {
  console.error(detail.error.toJSON());
});
```

资源 owner 必须保留可重建的 CPU descriptor。完整生命周期见 [Device recovery](./device-recovery.md)。

## 性能采集

本地定位可以运行 `npm run benchmark`、指定 manifest target 或当前设备的候选命令；报告应同时保留 P50/P95、RSD/cohort、draw/pass/upload、queue wait、allocation 和 resource residual。一次 DevTools profile、单帧尖峰或软件 adapter 结果不能用于调整正式预算。

候选和正式 evidence 的区别、设备身份要求与命令见 [Performance workflow](../for-ai/performance.md)。本页不提供 baseline 更新捷径；正式晋升只由 RC 集成流程执行。

## 报告 issue 时必须附带

1. 最小复现步骤，以及 manifest target ID、编辑器 workflow 或公开 package 入口。
2. Git revision、`git status --short`、是否使用构建产物/发布 tarball，以及 Node 版本。
3. 浏览器名称与完整版本、操作系统 build、GPU adapter 和 driver；说明是否远程会话。
4. 请求和实际启用的 RenderProfile、WebGPU optional features，以及 compatibility/capability report。
5. 完整结构化 diagnostic：`code`、`domain`、`path`、`hint`、`docsPath`、`context` 和 cause；移除 token、私有 URL 与用户内容后再上传。
6. 失败资源/Worker 的最终 URL、部署 base path、HTTP 状态、MIME、CORS/CSP 和 integrity/hash。
7. 可复现的 console/WebGPU validation error、截图或录屏；性能问题附原始机器可读 artifact，不只附汇总数字。
8. 释放问题附操作序列和销毁后的 listener、worker、asset handle、GPU owner 或 residual 计数。
