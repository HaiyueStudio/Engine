# ADR 0058：Typed Compute 副作用与生产 Compute Family

状态：Accepted（阶段 13）

## 决策

将五个引擎内建 compute shader 迁入 `shader-language` 的 production compute family。IR 必须显式声明 buffer 访问模式、写入/原子副作用、workgroup 和 dispatch schedule；构建期生成 Artifact V2，运行时只物化 module、bind-group layout 和 pipeline layout。

`GpuDrawCommandComputePass`、`GpuSortComputePass`、`Mesh3DGpuCullComputePass` 与 `InstancedMesh3DRenderer` 不再维护独立 binding ABI。`ComputeKernel` 继续承载用户 raw WGSL，避免阶段 13 将一个生产迁移隐式变成公共 API breaking change。

## 结果

五个内建 compute pass 的资源和调度 ABI 有可复现哈希、编译期诊断及 WebGPU 副作用证据；引擎 WGSL 清单只剩 custom-pass support 为手写源。GLSL ES 300、WebGL2 fallback 和公共 shader API 仍属后续独立决策。
