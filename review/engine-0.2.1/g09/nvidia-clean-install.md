# NVIDIA 582.78 驱动恢复与系统盘空间

日期：2026-10-09。用户已授权继续执行官方 582.78 清洁安装，接续[驱动保存失败诊断](nvidia-settings-save-failure.md)。当前 GTX 1070 Ti 已运行 582.78，设备错误码 0，Chrome 电源策略保存、回读与恢复测试通过；尚未重启，未产生新性能资格。

后续：用户已重启，[重启后功能验证与 GPU 对照准备](post-reboot-gpu-power.md)记录最新状态。下文为重启前证据，安装器失败不改写为成功。

## 安装结果与恢复

NVIDIA 清洁安装器在移除旧组件后，以 0x80070005（访问被拒绝）退出。日志涉及旧 nvcpl.dll 清理及注册表处理；部分旧缓存另有文件占用错误。失败后设备短暂为 Code 28，不能将这次安装器调用记为成功。

随后使用 Windows 官方 PnPUtil，对同一个已验证官方包中的 Display.Driver/nv_dispi.inf 执行 add-driver /install，返回 0。系统重新绑定 GTX 1070 Ti，驱动版本 32.0.15.8278；nvidia-smi 显示 582.78，nvapi64.dll 同版，设备状态 OK / Code 0。两个 NVIDIA Container 服务均 Running / Auto。NVIDIA 控制面板 Appx 8.1.969.0 已存在，包状态正常；尚未进行控制面板界面点击验证。清洁过程移除的 PhysX 已通过官方包补回 9.23.1019，注册项和 64 位加载库存在。补全安装同时处理了显示驱动依赖，但在 AfterInstall 注册表步骤再次以 0x80070005 退出；因此完整官方安装器仍未通过，须在重启后继续检查。补全后再次确认显卡 Code 0、版本 582.78，并重新通过两种电源策略恢复测试。未修改系统 ACL、关闭安全软件或自动重启。

Chrome 专属电源控制进行了正常结束、模拟异常两种工程测试。两次均成功写入 prefer-maximum（Value 1），通过新会话回读，再删除临时覆盖并恢复原无显式条目的状态。最终 restored=true。此结果证明此前 NVAPI SaveSettings 失败的阻塞已解除，不证明 GPU 频率已经稳定。证据见[检查索引](nvidia-clean-install-checks.json)。

官方桌面版包为 912739352 字节，SHA-256 为 B1E687CC29392DE4338831FAB23D66B4A331FB2EE0F4CA1E4901D38FD48E8DAE。外层包和 setup.exe 的 NVIDIA 签名有效，驱动目录的 Microsoft WHQL 签名有效；INF 包含本机 DEV_1B82。下载、解压和 NVIDIA 安装器临时目录在 D 盘；Windows PnP 安装仍按系统规则使用系统驱动仓库和临时位置。旧 560.94 驱动包、DRS 原样备份及失败日志完整保留。

首次启动器在 Get-FileHash 不可用处退出，尚未运行安装器；随后使用本机已验证的 PowerShell 7.6.5 完整路径运行，未依赖 pwsh PATH。后续只读检查证实，Windows PowerShell 5.1 设置自身 Modules 路径后可正常加载 Appx；故第一次失败不能认定为系统模块被删除。

## C 盘与缓存迁移

初始 C 盘约 100.1 GiB，剩余约 3.3 GiB。扫描为文件逻辑字节，NTFS 硬链接可能重复计数，父子目录也不能相加当作实际磁盘使用量。主要可见数据包括 AppData 31.7 GiB、Windows 搜索索引约 6.0 GiB、休眠文件约 6.4 GiB。

按用户最新要求，pip 缓存已由 D:\HaiyueStudio\Cache\pip 改到 D 盘根目录 D:\pip-cache；npm 缓存位于 D:\npm-cache。pip 同盘移动后核对了 522 个文件的相对路径和大小，默认路径回读正确，旧位置保留兼容目录连接。已完成：pip 522 个文件、5648865740 字节；npm 45883 个文件、2278063334 字节。复制后逐文件 SHA-256 校验，并在释放原文件前复核源文件未变；默认路径已切换，旧路径为兼容目录连接。原 Python 安装包与项目 node_modules 未移动。两项缓存合计约 7.38 GiB；驱动安装后的最终 C 盘可用约 5.91 GiB，不能把缓存迁移量直接当作整轮安装的净释放量。

WPS 的 kingsoft 用户目录约 3.27 GiB：addons 约 2.07 GiB（同一组件有多版并存），download 约 553 MiB（存在 2019–2024 年的历史文件），office6 约 360 MiB，日志约 190 MiB。它主要体现组件和历史下载积累，与打开文档次数不成比例。整个目录不能统一视为可丢弃缓存。本次只统计文件元数据，未读取文档内容或清理 WPS。

## 验收边界与下一步

CPU 保持原平衡方案最低 5%，Windows Search 保持本轮开始时 Stopped / Disabled。自建安装器进程已退出，Chrome 临时电源策略已恢复。旧驱动模块有等待重启释放的记录，需先保存工作并重启，再复核驱动与设置、运行原生正确性及短时 GPU 状态对照。

原 5% 回归预算、20% spread / 10% CV、完整样本人口和历史失败均不变；本轮 performanceQualified=false。582.78 的数据不能与旧 560.94 混算。统一 GPU 条件通过验证后，才冻结协议并重新建立同机 A0/B4 基线。
