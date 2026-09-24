# Browser and device requirements

最低要求是 WebGPU、ES modules、Workers、AbortController 和现代 TypedArray。正式支持矩阵的唯一机器可读来源是 [`config/release-matrix.json`](../../config/release-matrix.json)。

0.2.0 发布可选择一条完整资格路径：macOS 14+ 上的 Chrome/Metal（Apple Silicon、Intel 或 AMD 原生 GPU），或 Windows 10 22H2+ 上的 Chrome 与 Edge（NVIDIA GeForce 或 AMD Radeon RX 独显）。满足所选路径全部 required 项即可，不要求两种操作系统同时可用。Safari/macOS、Chrome Android 和 ChromeOS 继续属于 extended。决策见 [ADR 0107](../for-ai/adr/0107-native-macos-release-qualification.md)。

真实同步门禁包含 120 帧短跑和候选版 1800 帧长期 churn，使用所选路径的真实硬件。所有路径都上传机器可读 artifact，不把软件 adapter、远程虚拟渲染或 backend fallback 冒充硬件 GPU 证据。报告标明实测平台，Mac 通过不代表 Windows 已通过。

引擎默认 `batched` profile，不依赖 optional WebGPU feature。`gpu-driven` 和 `diagnostic` 会协商 `indirect-first-instance` / `timestamp-query`，不支持时提供报告并降级。纹理压缩必须准备 BC、ETC2/ASTC 或未压缩 fallback。浏览器缺少 WebGPU 时会产生带恢复建议的 `EngineError`，应用应展示不支持页面而不是继续创建场景。

## 在局域网设备上预览示例

`npm run dev:examples` 只负责初次构建和持续监听源码，不创建 HTTP 端口。需要从另一台设备访问时，保留该命令运行，并在第二个终端启动局域网静态服务：

```bash
npm run serve:examples:lan
```

服务默认监听所有 IPv4 网络接口的 `8443` 端口，只开放 `/examples`、`engine/extensions/ui` 构建产物和示例依赖的少量 fixture、Draco decoder 与 corpus 路由；仓库配置、Git 数据和其他源码不在静态服务范围内。

WebGPU 要求 secure context；另一台设备通过局域网 IP 访问普通 HTTP 不等同于本机的 `localhost` 特例。因此该命令默认要求 `.cert/haiyue-lan.pem` 与 `.cert/haiyue-lan-key.pem`，不会在证书缺失时静默降级。可以使用 `mkcert` 创建证书：

```bash
mkdir -p .cert
mkcert -install
mkcert -cert-file .cert/haiyue-lan.pem -key-file .cert/haiyue-lan-key.pem localhost 127.0.0.1 ::1 192.168.1.23
```

将示例中的 `192.168.1.23` 换成服务端实际局域网 IPv4。Windows 客户端还需要把同一个 mkcert CA 的 `rootCA.pem` 导入“受信任的根证书颁发机构”；不要复制或分享 `rootCA-key.pem`。之后访问日志打印的地址，例如 `https://192.168.1.23:8443/examples/`。

证书位置和监听参数可以覆盖：

```bash
npm run serve:examples:lan -- --host 0.0.0.0 --port 9443 --cert path/to/cert.pem --key path/to/key.pem
```

仅排查网络连通性时可以显式运行 `npm run serve:examples:lan -- --http --port 3000`。服务会输出安全上下文警告；这个模式不用于 WebGPU 验收或正式性能证据。若客户端无法连接，先在 Windows PowerShell 运行 `Test-NetConnection <服务端IP> -Port 8443`，再检查服务端防火墙和路由器的 client/AP isolation。
