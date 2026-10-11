# 独立长诊断入口的权限与后台应用检查

2026-10-11：用户从资源管理器右键管理员运行后报告入口未启动。用户提供的完整输出及 `gpu-batch-long-start-20261011T102724155Z-2700e6.json` 一致：`administrator=true`、PID 18012、`status=blocked-applications`、`dispatch=null`。本次实际拦截来自 ChatGPT/Codex、Epic、Steam、Edge 的后台进程；不是管理员权限误判。没有开始采样，也没有更改设置。

原提示在后台应用未退出时仍统一要求“以管理员身份运行”，容易误认为提权失败。入口现在先独立输出 `G09_ADMIN_OK` 或 `G09_ADMIN_REQUIRED`，应用检查使用 `G09_BACKGROUND_APPS`，并记录实际身份、有效进程令牌检查结果、PID、原生 PowerShell 版本、阻塞名单及启动阶段。隐藏 worker 同样检查并记录权限，失败时不启动采样子进程。

权限依据仍为 `WindowsPrincipal.IsInRole(Administrator)`。没有用账户名称或账户组配置替代有效令牌，没有关闭 UAC、自动修改安全策略或放宽后台应用限制。

仍使用 `D:\HaiyueStudio\start-g09-long-diagnostic.cmd`。先保存工作，从托盘菜单完全退出 Epic、Steam 和聊天应用，退出 Edge 等列出的应用，再从资源管理器右键管理员运行。若名单仍非空，按照提示处理后台进程后重试；退出码 3 表示尚未创建任务，无需等待完成弹窗。关闭窗口不一定退出托盘进程。

需要单独检查权限时，可在终端运行 `D:\HaiyueStudio\start-g09-long-diagnostic.cmd -CheckPermissions`。它只返回当前进程权限 JSON；不检查应用、不创建调度目录、不启动 worker 或采样、不修改设置，也不自动提权。此检查允许聊天应用保持打开。

## 验证

[机器复核](batch-completion-permission-entry-checks.json)绑定用户现场、脚本指纹、原生 Windows PowerShell 5 测试日志及 guard 完成记录。

- 权限专项分别在真实普通令牌和管理员令牌下运行，各 6 项通过；各有 1 项仅适用于另一种令牌的测试，由另一轮执行覆盖。覆盖真实 CMD 转接、隐藏进程继承、只读检查、应用拦截与权限分离、参数冲突、普通进程拒绝、管理员 guard 准备与收尾。
- 既有外部入口 10 项预检/计划检查通过；原 guard 测试由新增的带权限断言的 guard 检查覆盖，避免覆盖旧 guard 证据文件。
- 长诊断协议、进程识别及模拟电源恢复策略共 9 项通过。带中文的入口保留 UTF-8 BOM，兼容原生 Windows PowerShell 5。
- 首次在受限沙箱执行旧外部入口套件时，真实系统进程枚举被拒绝、管理员 guard 被正确拦截；该失败日志保留。对应套件已在真实管理员用户环境复核通过，不能把沙箱权限当成用户资源管理器的权限。

本轮只做入口工程检查；新增 guard 的 `childStarted=false`、`settingsChangedByGuard=false`、`leaseReleased=true`。没有 GPU 长采样或新基线。八次捕获、每次 120000 测量帧、最低 90 秒、8 帧在途上限及原 5% 回归预算保持不变；G09 完整性能资格仍待独立长诊断等后续验收。
