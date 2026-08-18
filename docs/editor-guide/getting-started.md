# 启动编辑器

## 环境要求

- 使用仓库 `.node-version` 指定的 Node.js。
- 使用支持 WebGPU 的现代浏览器。
- 首次运行前在仓库根目录安装依赖。

```bash
npm install
npm run build
python3 -m http.server 8080
```

然后访问 `http://localhost:8080/editor/`。开发编辑器代码时可运行 `npm run dev:editor` 持续构建，并保持静态服务器运行。

## 第一次打开

编辑器会显示 Hierarchy、Systems、Viewport、Resources 和 Inspector。可以从顶部 **Kits** 选择起始内容，也可以通过 **Open** 打开已有场景 JSON。

建议第一次操作按以下顺序进行：

1. 从 Kits 创建一个起始场景，或打开现有场景。
2. 在 Hierarchy 中选择实体。
3. 在 Viewport 中使用 `W`、`E`、`R` 切换位移、旋转和缩放工具。
4. 在 Inspector 中修改 Transform 或添加组件。
5. 点击 **Save As** 保存场景文件。
6. 点击 **Play** 检查运行结果。

浏览器缺少 WebGPU 时应先查看 [浏览器与设备要求](../engine-guide/browser-requirements.md)，不要在不支持的环境中继续调试场景内容。
