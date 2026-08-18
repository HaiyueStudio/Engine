import { Camera2D, Entity, Mesh2D, Transform2D, HaiyueEngine } from '@haiyue/engine';
import { createSVG2DMeshes } from '@haiyue/engine/geometry';

const SVG_TEXT = `
<svg viewBox="0 0 360 240" xmlns="http://www.w3.org/2000/svg">
  <rect x="18" y="18" width="324" height="204" fill="#101827" opacity="0.92"/>
  <circle cx="96" cy="120" r="56" fill="#38bdf8" opacity="0.92"/>
  <ellipse cx="248" cy="72" rx="58" ry="34" fill="#f97316" opacity="0.9"/>
  <polygon points="214,178 248,128 304,136 318,194 252,212" fill="#84cc16" opacity="0.88"/>
  <path d="M 86 174 C 142 82, 206 82, 268 174 L 236 174 C 194 121, 157 121, 118 174 Z" fill="#f8fafc" opacity="0.95"/>
  <path d="M 118 68 L 150 46 L 182 68 L 170 104 L 130 104 Z" fill="#a855f7" opacity="0.9"/>
  <path d="M 58 206 Q 92 162, 126 206 T 194 206" fill="none" stroke="white" stroke-width="7" stroke-linecap="round"/>
  <path d="M 228 206 C 250 168, 286 168, 308 206 S 344 244, 360 206" fill="none" stroke="rgba(14,165,233,0.75)" stroke-width="7" stroke-linecap="round"/>
  <path d="M 58 54 A 34 22 25 0 1 124 54 A 34 22 25 0 1 58 54" fill="red" opacity="0.52"/>
</svg>`;

async function main() {
  const info = document.getElementById('info')!;
  const uploadButton = document.getElementById('upload-button') as HTMLButtonElement;
  const uploadInput = document.getElementById('upload-input') as HTMLInputElement;
  const fileName = document.getElementById('file-name')!;

  const engine = new HaiyueEngine({
    canvas: 'canvas',
    clearColor: { r: 0.9, g: 0.92, b: 0.94, a: 1 },
  });
  await engine.init();

  const camera = new Entity('Camera');
  camera.addComponent(new Camera2D());
  const scene = engine.createScene({
    name: 'SVGGeometry',
    camera: { type: '2d', entity: camera },
    render3D: false,
    render2D: true,
    pipelineLabel: 'SVGGeometry.render',
  });
  const world = scene.world;

  const shapeTransforms: Transform2D[] = [];
  const shapeEntities: Entity[] = [];

  function loadSVG(svgText: string, label: string): void {
    for (const entity of shapeEntities) world.removeEntity(entity);
    shapeEntities.length = 0;
    shapeTransforms.length = 0;

    const start = performance.now();
    const meshes = createSVG2DMeshes(svgText, { height: 520, curveSegments: 24 });
    const duration = performance.now() - start;
    let vertexCount = 0;
    let triangleCount = 0;
    for (const [index, item] of meshes.entries()) {
      vertexCount += item.geometry.positions.length / 2;
      triangleCount += (item.geometry.indices?.length ?? 0) / 3;
      const entity = new Entity(`SVGShape_${index}`);
      entity.addComponent(new Mesh2D(item.geometry, item.material));
      const transform = new Transform2D();
      entity.addComponent(transform);
      shapeTransforms.push(transform);
      shapeEntities.push(entity);
      world.addEntity(entity);
    }

    fileName.textContent = label;
    info.textContent = `${meshes.length} SVG shapes, ${Math.floor(vertexCount)} vertices, ${Math.floor(triangleCount)} triangles, ${duration.toFixed(2)}ms parse.`;
    console.info(`[svg-geometry] ${label}: ${meshes.length} meshes, ${Math.floor(vertexCount)} vertices, ${Math.floor(triangleCount)} triangles, ${duration.toFixed(2)}ms`);
  }

  uploadButton.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    try {
      loadSVG(await file.text(), file.name);
    } catch (error) {
      console.error(error);
      info.textContent = `Failed to parse SVG: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      uploadInput.value = '';
    }
  });

  loadSVG(SVG_TEXT, 'Built-in SVG');

  engine.on('update', ({ detail: { time } }) => {
    const rotation = Math.sin(time * 0.0004) * 0.08;
    for (const transform of shapeTransforms) transform.rotation = rotation;
  });

  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
