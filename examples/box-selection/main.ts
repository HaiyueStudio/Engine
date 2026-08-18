import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { BoxSelectionControl } from '@haiyue/engine/controls';
import type { BoxSelectionMode } from '@haiyue/engine/controls';

interface SelectableBox {
  entity: Entity;
  material: BasicMaterial;
  base: ColorSRGB;
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const modeEl = document.getElementById('mode') as HTMLSelectElement;
  const countEl = document.getElementById('count') as HTMLElement;
  const namesEl = document.getElementById('names') as HTMLElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.035, g: 0.045, b: 0.07, a: 1 },
  });
  await engine.init();

  const cameraSph = new SphericalTransform3D({
    radius: 18,
    theta: Math.PI * 0.14,
    phi: Math.PI * 0.28,
    target: [0, 0, 0],
  });
  const cameraEntity = new Entity('Camera');
  cameraEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 80 }));
  cameraEntity.addComponent(cameraSph);

  const scene = engine.createScene({
    name: 'BoxSelection',
    camera: cameraEntity,
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'BoxSelection.render',
  });
  const world = scene.world;

  new OrbitControl(canvas, cameraSph, {
    enableRotate: false,
    enablePan: true,
    enableZoom: true,
    minRadius: 7,
    maxRadius: 36,
  });

  const geometry = createBox3D({ width: 1.2, height: 1.2, depth: 1.2 });
  const boxes: SelectableBox[] = [];

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 7; col++) {
      const x = (col - 3) * 2.1;
      const z = (row - 1.5) * 1.9;
      const y = Math.sin(col * 0.7 + row * 0.55) * 0.55;
      const base = new ColorSRGB(
        0.22 + col * 0.055,
        0.42 + row * 0.08,
        0.72 - row * 0.055,
        1,
      );
      const material = new BasicMaterial({ color: base.clone() });
      const entity = new Entity(`Box-${row + 1}-${col + 1}`);
      entity.addComponent(new CartesianTransform3D({ position: [x, y, z] }));
      entity.addComponent(new Mesh3D(geometry, material));
      world.addEntity(entity);
      boxes.push({ entity, material, base });
    }
  }

  function setSelected(selected: Entity[]) {
    const selectedSet = new Set(selected);
    for (const box of boxes) {
      if (selectedSet.has(box.entity)) {
        box.material.color = new ColorSRGB(1, 0.82, 0.18, 1);
      } else {
        box.material.color = box.base;
      }
    }

    countEl.textContent = `Selected: ${selected.length}`;
    namesEl.textContent = selected.length > 0
      ? selected.map(entity => entity.name).join(', ')
      : 'Drag a rectangle over boxes';
  }

  const selectionControl = new BoxSelectionControl(canvas, world, cameraEntity, {
    selectionMode: 'center',
    filter: entity => boxes.some(box => box.entity === entity),
    onSelect: result => setSelected(result.entities),
  });

  modeEl.addEventListener('change', () => {
    selectionControl.selectionMode = modeEl.value as BoxSelectionMode;
    setSelected([]);
  });

  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
