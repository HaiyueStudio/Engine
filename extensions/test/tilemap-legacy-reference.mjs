// Frozen pre-G08 palette vertex implementation; compatibility oracle only.
// Original method SHA-256: b013895f2ae5ceb497d05a4910ea205b537b7f976cffdc46cc763beb6ca5ec94
export class FrozenPaletteGeometry {
    buildVertices(tilemap, entityGpu) {
        let count = 0;
        for (const cell of tilemap.cells) {
            if (cell > 0)
                count++;
        }
        if (count === 0) {
            entityGpu.vertexByteLength = 0;
            entityGpu.vertexCount = 0;
            return;
        }
        const requiredFloats = count * 6 * 6;
        if (entityGpu.vertexData.length < requiredFloats) {
            entityGpu.vertexData = new Float32Array(Math.max(requiredFloats, entityGpu.vertexData.length * 2, 36));
        }
        const vertices = entityGpu.vertexData;
        let offset = 0;
        const gap = tilemap.gap;
        const w = Math.max(0, tilemap.cellWidth - gap);
        const h = Math.max(0, tilemap.cellHeight - gap);
        const push = (x, y, color) => {
            vertices[offset++] = x;
            vertices[offset++] = y;
            vertices[offset++] = color[0] ?? 1;
            vertices[offset++] = color[1] ?? 1;
            vertices[offset++] = color[2] ?? 1;
            vertices[offset++] = color[3] ?? 1;
        };
        for (let row = 0; row < tilemap.rows; row++) {
            for (let column = 0; column < tilemap.columns; column++) {
                const value = tilemap.getCell(column, row);
                if (value <= 0)
                    continue;
                const color = tilemap.palette[value] ?? tilemap.palette[1] ?? [1, 1, 1, 1];
                const x0 = tilemap.originX + column * tilemap.cellWidth + gap * 0.5;
                const y0 = tilemap.originY + row * tilemap.cellHeight + gap * 0.5;
                const x1 = x0 + w;
                const y1 = y0 + h;
                push(x0, y0, color);
                push(x1, y0, color);
                push(x1, y1, color);
                push(x0, y0, color);
                push(x1, y1, color);
                push(x0, y1, color);
            }
        }
        entityGpu.vertexByteLength = requiredFloats * 4;
        entityGpu.vertexCount = count * 6;
    }
}

export function legacyPaletteVertices(map){const gpu={vertexData:new Float32Array(36),vertexByteLength:0,vertexCount:0};new FrozenPaletteGeometry().buildVertices(map,gpu);return gpu.vertexData.subarray(0,gpu.vertexByteLength/4); }
