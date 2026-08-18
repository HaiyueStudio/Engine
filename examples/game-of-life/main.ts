import {
  RenderPipeline,
  HaiyueEngine,
  World,
  beginRenderCommandPass,
  type RenderCommandContext,
} from '@haiyue/engine/experimental';
import { ComputeKernel } from '@haiyue/engine/compute';
import { requiredItemAt } from '../arrayAccess';

const GRID_SIZE = 128;
const CELL_COUNT = GRID_SIZE * GRID_SIZE;
const UPDATE_INTERVAL_MS = 90;

const COMPUTE_WGSL = /* wgsl */`
struct Grid {
  size : vec2<u32>,
  _pad : vec2<u32>,
}

@group(0) @binding(0) var<uniform> grid : Grid;
@group(0) @binding(1) var<storage, read> current : array<u32>;
@group(0) @binding(2) var<storage, read_write> next : array<u32>;

fn cellIndex(x: u32, y: u32) -> u32 {
  return y * grid.size.x + x;
}

fn cellAt(x: i32, y: i32) -> u32 {
  let wrappedX = (x + i32(grid.size.x)) % i32(grid.size.x);
  let wrappedY = (y + i32(grid.size.y)) % i32(grid.size.y);
  return current[cellIndex(u32(wrappedX), u32(wrappedY))];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= grid.size.x || gid.y >= grid.size.y) { return; }

  var neighbors = 0u;
  let x = i32(gid.x);
  let y = i32(gid.y);
  for (var oy = -1; oy <= 1; oy = oy + 1) {
    for (var ox = -1; ox <= 1; ox = ox + 1) {
      if (ox != 0 || oy != 0) {
        neighbors += cellAt(x + ox, y + oy);
      }
    }
  }

  let alive = current[cellIndex(gid.x, gid.y)];
  let survives = alive == 1u && (neighbors == 2u || neighbors == 3u);
  let born = alive == 0u && neighbors == 3u;
  next[cellIndex(gid.x, gid.y)] = select(0u, 1u, survives || born);
}
`;

const RENDER_WGSL = /* wgsl */`
struct Grid {
  size : vec2<u32>,
  _pad : vec2<u32>,
}

@group(0) @binding(0) var<uniform> grid : Grid;
@group(0) @binding(1) var<storage, read> cells : array<u32>;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) alive : f32,
  @location(1) local : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  );
  let corner = corners[vi];
  let x = f32(ii % grid.size.x);
  let y = f32(ii / grid.size.x);
  let cell = (vec2<f32>(x, y) + corner) / vec2<f32>(grid.size);
  let clip = cell * 2.0 - vec2<f32>(1.0);

  var out : VOut;
  out.pos = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
  out.alive = f32(cells[ii]);
  out.local = corner;
  return out;
}

@fragment
fn fs_main(input : VOut) -> @location(0) vec4<f32> {
  let gridLine = select(0.0, 1.0, input.local.x < 0.035 || input.local.y < 0.035);
  let dead = vec3<f32>(0.035, 0.052, 0.075) + gridLine * vec3<f32>(0.045);
  let alive = vec3<f32>(0.16, 0.86, 0.48);
  let color = mix(dead, alive, input.alive);
  return vec4<f32>(color, 1.0);
}
`;

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const playButton = document.getElementById('play') as HTMLButtonElement;
  const stepButton = document.getElementById('step') as HTMLButtonElement;
  const randomButton = document.getElementById('random') as HTMLButtonElement;
  const clearButton = document.getElementById('clear') as HTMLButtonElement;
  const meta = document.getElementById('meta')!;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.02, g: 0.027, b: 0.04, a: 1 },
  });
  await engine.init();
  const { device } = engine;
  const world = new World('GameOfLife');

  const gridBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(gridBuffer, 0, new Uint32Array([GRID_SIZE, GRID_SIZE, 0, 0]));

  const cellBuffers = [
    createCellBuffer(device),
    createCellBuffer(device),
  ];
  const firstCellBuffer = requiredItemAt(cellBuffers, 0, 'Game of Life cell buffers');
  const secondCellBuffer = requiredItemAt(cellBuffers, 1, 'Game of Life cell buffers');
  const readbackBuffer = device.createBuffer({
    size: CELL_COUNT * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const compute = new ComputeKernel(engine, {
    label: 'GameOfLife Compute',
    code: COMPUTE_WGSL,
    bindGroupLayoutEntries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });

  const renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [renderBindGroupLayout] }),
    vertex: { module: device.createShaderModule({ code: RENDER_WGSL }), entryPoint: 'vs_main' },
    fragment: {
      module: device.createShaderModule({ code: RENDER_WGSL }),
      entryPoint: 'fs_main',
      targets: [{ format: engine.format }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const computeBindGroups = [
    compute.createBindGroup([
      { binding: 0, resource: { buffer: gridBuffer } },
      { binding: 1, resource: { buffer: firstCellBuffer } },
      { binding: 2, resource: { buffer: secondCellBuffer } },
    ], 'GameOfLife Compute A'),
    compute.createBindGroup([
      { binding: 0, resource: { buffer: gridBuffer } },
      { binding: 1, resource: { buffer: secondCellBuffer } },
      { binding: 2, resource: { buffer: firstCellBuffer } },
    ], 'GameOfLife Compute B'),
  ];
  const renderBindGroups = [
    device.createBindGroup({
      layout: renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: gridBuffer } },
        { binding: 1, resource: { buffer: firstCellBuffer } },
      ],
    }),
    device.createBindGroup({
      layout: renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: gridBuffer } },
        { binding: 1, resource: { buffer: secondCellBuffer } },
      ],
    }),
  ];

  const cells = new Uint32Array(CELL_COUNT);
  let bufferIndex = 0;
  let generation = 0;
  let playing = false;
  let elapsed = 0;
  let cpuStateDirty = false;
  let syncing = false;

  function uploadCells(): void {
    device.queue.writeBuffer(requiredItemAt(cellBuffers, bufferIndex, 'Game of Life cell buffers'), 0, cells);
  }

  function randomize(): void {
    for (let i = 0; i < cells.length; i++) cells[i] = Math.random() > 0.72 ? 1 : 0;
    generation = 0;
    cpuStateDirty = false;
    uploadCells();
    updateMeta();
  }

  function clear(): void {
    cells.fill(0);
    generation = 0;
    cpuStateDirty = false;
    uploadCells();
    updateMeta();
  }

  function step(target: GPUCommandEncoder | RenderCommandContext): void {
    compute.dispatch(target, requiredItemAt(computeBindGroups, bufferIndex, 'Game of Life compute bind groups'), Math.ceil(GRID_SIZE / 8), Math.ceil(GRID_SIZE / 8));
    bufferIndex = 1 - bufferIndex;
    generation++;
    cpuStateDirty = true;
    updateMeta();
  }

  function render(context: RenderCommandContext): void {
    const { passEncoder: pass, ownsPass } = beginRenderCommandPass(context);
    pass.setPipeline(renderPipeline);
    pass.setBindGroup(0, requiredItemAt(renderBindGroups, bufferIndex, 'Game of Life render bind groups'));
    pass.draw(6, CELL_COUNT);
    if (ownsPass) pass.end();
  }

  function updateMeta(): void {
    meta.textContent = `Gen ${generation}`;
    playButton.textContent = playing ? 'Pause' : 'Play';
    playButton.dataset.active = String(playing);
  }

  async function syncCellsFromGpu(): Promise<void> {
    if (!cpuStateDirty || syncing) return;
    syncing = true;
    const commandEncoder = device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(requiredItemAt(cellBuffers, bufferIndex, 'Game of Life cell buffers'), 0, readbackBuffer, 0, CELL_COUNT * 4);
    device.queue.submit([commandEncoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    cells.set(new Uint32Array(readbackBuffer.getMappedRange()).slice());
    readbackBuffer.unmap();
    cpuStateDirty = false;
    syncing = false;
  }

  async function toggleCell(event: PointerEvent): Promise<void> {
    if (playing) return;
    await syncCellsFromGpu();
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / rect.width * GRID_SIZE);
    const y = Math.floor((event.clientY - rect.top) / rect.height * GRID_SIZE);
    if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return;
    const index = y * GRID_SIZE + x;
    cells[index] = cells[index] ? 0 : 1;
    uploadCells();
  }

  playButton.addEventListener('click', () => {
    playing = !playing;
    if (!playing) void syncCellsFromGpu();
    updateMeta();
  });
  stepButton.addEventListener('click', () => {
    if (playing) return;
    const commandEncoder = device.createCommandEncoder();
    step(commandEncoder);
    device.queue.submit([commandEncoder.finish()]);
  });
  randomButton.addEventListener('click', randomize);
  clearButton.addEventListener('click', clear);
  canvas.addEventListener('pointerdown', toggleCell);

  randomize();
  const pipeline = new RenderPipeline(engine);
  pipeline
    .add({
      record(_world: World, delta: number, context: RenderCommandContext): void {
        if (playing) {
          elapsed += delta;
          while (elapsed >= UPDATE_INTERVAL_MS) {
            step(context);
            elapsed -= UPDATE_INTERVAL_MS;
          }
        } else {
          elapsed = 0;
        }
      },
    }, { passType: 'compute', recordMode: 'delta' })
    .add({
      record(_world: World, context: RenderCommandContext): void {
        render(context);
      },
    }, { passType: 'render', pass: 'shared', loadOp: 'clear', depth: false });

  engine.on('update', ({ detail: { time, delta } }) => {
    pipeline.execute(world, time, delta, { label: 'GameOfLife.pipeline' });
  });

  engine.run();
}

function createCellBuffer(device: GPUDevice): GPUBuffer {
  return device.createBuffer({
    size: CELL_COUNT * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
}

main().catch(console.error);
