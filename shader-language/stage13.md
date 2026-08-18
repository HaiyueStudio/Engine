# 阶段 13：Typed Compute IR 与生产 Compute Family

阶段 13 把剩余五个引擎内建 compute pass 作为一个原子 family 迁移到构建期 Artifact V2。Compute IR v1 显式描述资源访问、`store`/`atomic-add` 副作用、workgroup 大小、dispatch domain 与单次/bitonic-network 调度；错误的原子访问、未声明写入、不可移植 workgroup 或错误调度会在编译期失败。

生产运行时不解析或拼接 WGSL。`InstancedMesh3DRenderer` 直接消费生成 artifact 的 module/layout 缓存；三个延迟创建的 compute pass 通过 reflection-only adapter 取得同一份 code/layout。原有 `ComputeKernel` raw WGSL API 保留为明确逃生口，不进入生产内建 family。

验收以 [stage13-contract.json](./stage13-contract.json) 为准，包括 60/59/1 WGSL 清单、bundle 预算、五个浏览器编译和 draw-command/sort/cull 三类真实 GPU 副作用读回。
