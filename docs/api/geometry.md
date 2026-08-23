# `@haiyue/engine/geometry`

稳定的几何体生成入口。沿路径挤出使用 `createPathExtrusion3D`：

```ts
import { createPathExtrusion3D } from '@haiyue/engine/geometry';

const road = createPathExtrusion3D({
  path: centerLine.map(point => ({
    position: [point.x, point.y, point.z],
    roll: point.bank,
  })),
  shape: [
    [-8, 0.5],
    [8, 0.5],
    [8, -0.5],
    [-8, -0.5],
  ],
  closedPath: true,
  uvScale: [0.02, 0.05],
});
```

## 路径帧

- `position` 是每个挤出环的中心位置。
- `roll` 绕路径切线旋转截面，可用于道路倾斜、管线扭转等效果。
- 闭合路径不应在末尾重复第一个点；生成器会自动连接并为 UV 接缝复制输出环。
- 截面坐标使用局部“右/上”轴。闭合截面按顺时针排列时法线朝外。
- `closedShape: false` 可用两个截面点生成无厚度带状表面。

无效、非有限或相邻重叠的路径/截面数据会抛出 `E_GEOMETRY_INVALID_PARAMETER`。
