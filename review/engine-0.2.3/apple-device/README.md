# G11 Mac 与物理 iPhone 验收

本轮候选是 Engine `5d8041d` 和 Native `g11-023-native-b0b8e30232fa4e3adbe1d289`。它修复折叠点击导致浏览器把未选拼音写入输入框的问题。准备脚本核对 18.5 MiB 设备包的 SHA-256，再逐文件核对源码、npm 候选包及 Native 工程。此前 Windows 实际设备结果绑定在原候选上。[候选收据](qualification.json)

在 Mac 的 Engine 仓库中执行。需要 Git LFS、Node.js 22 或更新版本，以及 Google Chrome。

```sh
git fetch origin codex/g11-device-focus-023-3e4cbf7
GIT_LFS_SKIP_SMUDGE=1 git worktree add --detach ../Engine-g11-mac FETCH_HEAD
cd ../Engine-g11-mac
git lfs pull --include='review/engine-0.2.3/apple-device/engine-0.2.3-real-devices-5d8041d.tar.gz' --exclude='' origin
checkout="$PWD"
device_dir="$(node "$checkout/review/engine-0.2.3/apple-device/prepare.mjs")"
```

依次运行浏览器验收。每个窗口完成后点“保存本轮记录”，保持终端打开，等终端显示 `Mac 进程退出检查 passed`。

```sh
node "$checkout/review/engine-0.2.3/apple-device/run-mac-physical.mjs" keyboard-ime "$device_dir"
node "$checkout/review/engine-0.2.3/apple-device/run-mac-physical.mjs" audio "$device_dir"
```

新入口运行设备包里的原验收采集器，并附上 `mac-process-cleanup.json`。该报告用本次 `result.json` 的 SHA-256 绑定进程退出结果。

IME 补测先选中「你好」并保存检查点。再输入一段拼音，候选窗出现后直接点 `Play and settings` 折叠。重新展开时，输入框应保持「你好」，随后保存检查点。最后另选一个候选并保存检查点，确认选字仍然生效。

解包目录的 `README-current.md` 列出浏览器检查步骤、Xcode 与物理 iPhone 预检、构建和收集命令。iPhone 工程位于同一解包目录的 `Native/examples/ios-gui-text-input`。先核对系统键盘、旋转、遮挡和后台恢复，再记录音频宿主能力与实际听感。

完成后回到解包目录运行 `node collect-return.mjs`，把生成的 `device-return-*.tar.gz` 和 IME、听音及 iPhone 的实际观察一起回传。发现异常时也保存原始记录。重新运行准备脚本会创建新的验收目录，之前的记录留在原目录。
