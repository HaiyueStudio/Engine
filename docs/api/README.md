# API Reference

本目录只提供可查询的 API 事实：包入口、类型、参数、返回值、稳定性和错误码。如何组合这些 API 完成开发任务，请阅读 [Engine Guide](../engine-guide/README.md) 或 [Editor Guide](../editor-guide/README.md)。

## 权威来源

1. 各 workspace `package.json#exports` 决定可导入入口。
2. 构建产物中的 `.d.ts` 决定公开类型签名。
3. `scripts/api-surface.mjs` 和 API baseline 决定 stable surface 是否发生变化。
4. 本目录维护入口索引、稳定性说明和无法从类型声明表达的错误语义。

不要把源码目录中可见的类视为公共 API。未被 exports 暴露的文件属于 private。

## 包入口

- [`@haiyue/engine`](./engine.md)
- [`@haiyue/extensions`](./extensions.md)
- [`@haiyue/animation-spec`](./animation-spec.md)
- [`@haiyue/engine/navigation`](./navigation.md)
- [`@haiyue/engine/physics` 与 backend SPI](./physics.md)
- [错误码](./errors/README.md)

`@haiyue/engine/experimental` 是显式选择的低层入口，不提供稳定性承诺。详细规则见 [API stability](../for-ai/api-stability.md)。

## 更新 API 文档

```bash
npm run build
npm run api:check
```

只有经过 API 评审后才运行 `npm run api:update`。后续引入自动 API 页面生成时，应从构建后的声明文件生成到本目录的生成子目录，手写入口和错误码页面继续保留。
