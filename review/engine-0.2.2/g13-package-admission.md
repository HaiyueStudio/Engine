# G13 公开入口集成

问题：共享布局、GUI 适配器和已实现的 GUI／区域合同尚未全部进入正式包入口，Games 默认依赖仍为 0.2.1。

方法：注册 G01 已冻结的 `/layout`（13 符号）和 `/gui-layout`（11 符号），复用原求解器与 GUI owner。编译后闭包诊断分别为 8,964／33,251 gzip 字节；容量分别为 11,000／40,000，保留 2,036／6,749 字节储备。真实安装 tarball 的消费检查另行报告，诊断不作为正式包资格。原根入口和已有能力容量保持。

具名补齐提案：`engine/src/core.ts` 导出既有 RegionUpdateMode、RenderRegionOptions、RenderRegion；`engine/src/gui.ts` 导出 G01 的二十项 GUI 合同（原 86→106），仅新增具名导出，不更改实现。`review/baselines/api-surface.json` 仅接受本次 47 项冻结符号和两个子路径的差异，根入口保持 30。

Games 提案仅更新 `package.json`、`package-lock.json`、`vendor/haiyue-engine-0.2.2.tgz`、`vendor/haiyue-animation-spec-0.2.2.tgz`、`vendor/haiyue-extensions-0.2.2.tgz`。三份公开包及既有 gamepad／controls 包别名一起对齐实际候选。旧 vendor 文件保留；Sokoban 的用户改动保持。修改后执行完整类型检查、游戏测试及构建，不能把退出码为零但含未解析导入的产物算通过。

结论：入口实现与算法无重复；公开准入、安装消费、包容量、设备与全局资格以 G13 最终记录为准。当前仍不可发布。
