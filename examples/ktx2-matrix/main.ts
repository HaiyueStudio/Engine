import {
  inspectKtx2Texture,
  uploadKtx2Texture,
  type Ktx2TextureInfo,
} from '@haiyue/engine/experimental';
import { requiredItemAt } from '../arrayAccess';

type MatrixStatus = 'pending' | 'ok' | 'fail' | 'unsupported';

interface MatrixRow {
  file: File;
  name: string;
  status: MatrixStatus;
  info?: Ktx2TextureInfo;
  category: string;
  featureState: string;
  previewUrl?: string | undefined;
  error?: string | undefined;
}

const COMPRESSED_FEATURES: GPUFeatureName[] = [
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
];

let adapter: GPUAdapter | null = null;
let device: GPUDevice | null = null;
let rows: MatrixRow[] = [];

async function main(): Promise<void> {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const directoryInput = document.getElementById('directory-input') as HTMLInputElement;
  const clearButton = document.getElementById('clear-button') as HTMLButtonElement;

  await initWebGPU();
  render();

  fileInput.addEventListener('change', () => {
    void runFiles(fileInput.files);
    fileInput.value = '';
  });
  directoryInput.addEventListener('change', () => {
    void runFiles(directoryInput.files);
    directoryInput.value = '';
  });
  clearButton.addEventListener('click', () => {
    for (const row of rows) {
      if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    }
    rows = [];
    setStatus('Waiting for KTX2 files.');
    render();
  });
}

async function initWebGPU(): Promise<void> {
  if (!navigator.gpu) {
    setStatus('WebGPU is not available in this browser.');
    return;
  }
  adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    setStatus('No WebGPU adapter is available.');
    return;
  }
  const requiredFeatures = COMPRESSED_FEATURES.filter(feature => adapter?.features.has(feature));
  device = await adapter.requestDevice({ requiredFeatures });
  device.lost.then(info => {
    setStatus(`WebGPU device lost: ${info.message || info.reason}`);
  }).catch(() => undefined);
}

async function runFiles(fileList: FileList | null): Promise<void> {
  const files = Array.from(fileList ?? [])
    .filter(file => file.name.toLowerCase().endsWith('.ktx2'))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (files.length < 1) {
    setStatus('No .ktx2 files selected.');
    return;
  }

  for (const row of rows) {
    if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
  }
  rows = files.map(file => ({
    file,
    name: displayName(file),
    status: 'pending',
    category: classifyName(file.name),
    featureState: 'pending',
  }));
  render();

  for (let i = 0; i < rows.length; i++) {
    const row = requiredItemAt(rows, i, 'KTX2 matrix rows');
    setStatus(`Testing ${i + 1}/${rows.length}: ${row.name}`);
    await testRow(row);
    render();
  }
  setStatus(`Completed ${rows.length} KTX2 files.`);
}

async function testRow(row: MatrixRow): Promise<void> {
  try {
    const buffer = await row.file.arrayBuffer();
    row.info = inspectKtx2Texture(buffer, row.name);
    row.category = classifyInfo(row.info, row.file.name);
    row.featureState = getFeatureState(row.info);

    if (!row.info.supportedByBuiltInLoader) {
      row.status = 'unsupported';
      row.error = row.info.unsupportedReason;
      return;
    }
    if (!device) {
      row.status = 'fail';
      row.error = 'WebGPU device is not available.';
      return;
    }

    const texture = await uploadKtx2Texture(device, buffer.slice(0), row.name);
    try {
      row.previewUrl = await renderPreview(device, texture, row.info);
      row.status = 'ok';
    } finally {
      texture.destroy();
    }
  } catch (error) {
    row.status = 'fail';
    row.error = formatError(error);
  }
}

async function renderPreview(device: GPUDevice, texture: GPUTexture, info: Ktx2TextureInfo): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  const is3D = info.dimension === '3d';
  const scale = Math.min(1, 96 / Math.max(info.width, info.height, 1));
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  const format: GPUTextureFormat = 'rgba8unorm';
  const output = device.createTexture({
    label: 'KTX2Matrix.preview.output',
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  try {

    const shader = device.createShaderModule({
      label: 'KTX2Matrix.preview.shader',
      code: createPreviewShader(is3D, getPreviewMode(info.gpuFormat)),
    });
    const bindGroupLayout = device.createBindGroupLayout({
      label: 'KTX2Matrix.preview.bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: is3D ? '3d' : '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
      ],
    });
    const pipeline = device.createRenderPipeline({
      label: 'KTX2Matrix.preview.pipeline',
      layout: device.createPipelineLayout({
        label: 'KTX2Matrix.preview.layout',
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: { module: shader, entryPoint: 'vs' },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const bindGroup = device.createBindGroup({
      label: 'KTX2Matrix.preview.bindGroup',
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: is3D
          ? texture.createView({ dimension: '3d', baseMipLevel: 0, mipLevelCount: 1 })
          : texture.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 }),
      }, {
        binding: 1,
        resource: device.createSampler({
          magFilter: 'nearest',
          minFilter: 'nearest',
          mipmapFilter: 'nearest',
        }),
      }],
    });

    const encoder = device.createCommandEncoder({ label: 'KTX2Matrix.preview.encoder' });
    const pass = encoder.beginRenderPass({
      label: 'KTX2Matrix.preview.pass',
      colorAttachments: [{
        view: output.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    const paddedBytesPerRow = alignUp(width * 4, 256);
    const readback = device.createBuffer({
      label: 'KTX2Matrix.preview.readback',
      size: paddedBytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      { texture: output },
      { buffer: readback, bytesPerRow: paddedBytesPerRow, rowsPerImage: height },
      [width, height],
    );
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPUMapMode.READ);
    try {
      const mapped = new Uint8Array(readback.getMappedRange());
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        const srcOffset = y * paddedBytesPerRow;
        const dstOffset = y * width * 4;
        pixels.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return undefined;
      context.putImageData(new ImageData(pixels, width, height), 0, 0);
      return canvas.toDataURL('image/png');
    } finally {
      readback.unmap();
      readback.destroy();
    }
  } finally {
    output.destroy();
  }
}

function render(): void {
  renderSummary();
  const body = document.getElementById('rows')!;
  body.textContent = '';
  for (const row of rows) body.appendChild(renderRow(row));
}

function renderSummary(): void {
  const summary = document.getElementById('summary')!;
  summary.textContent = '';
  const counts = rows.reduce((acc, row) => {
    acc.total += 1;
    acc[row.status] += 1;
    return acc;
  }, { total: 0, pending: 0, ok: 0, fail: 0, unsupported: 0 });
  const features = COMPRESSED_FEATURES.map(feature => `${feature}:${device?.features.has(feature) ? 'on' : adapter?.features.has(feature) ? 'adapter-only' : 'off'}`).join('  ');
  const stats: Array<[string, string]> = [
    ['Adapter', adapter ? 'available' : 'missing'],
    ['Features', features || 'none'],
    ['Total', String(counts.total)],
    ['Passed', String(counts.ok)],
    ['Failed / Unsupported', `${counts.fail} / ${counts.unsupported}`],
  ];
  for (const [label, value] of stats) {
    const item = document.createElement('div');
    item.className = 'stat';
    item.innerHTML = `<div class="stat-label"></div><div class="stat-value"></div>`;
    const labelElement = item.children.item(0);
    const valueElement = item.children.item(1);
    if (labelElement) labelElement.textContent = label;
    if (valueElement) valueElement.textContent = value;
    summary.appendChild(item);
  }
}

function renderRow(row: MatrixRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.appendChild(cell(renderPreviewCell(row)));
  tr.appendChild(cell(renderNameCell(row)));
  tr.appendChild(textCell(row.info ? `${row.info.dimension} ${row.info.width}x${row.info.height}${row.info.depth ? `x${row.info.depth}` : ''} L${row.info.layers} F${row.info.faces} M${row.info.levels}` : 'pending'));
  tr.appendChild(textCell(row.info?.gpuFormat ?? `vkFormat ${row.info?.vkFormat ?? '-'}`));
  tr.appendChild(textCell(row.info?.supercompression ?? row.category));
  tr.appendChild(textCell(row.featureState));
  tr.appendChild(textCell(row.info?.uploadPath ?? 'pending'));
  tr.appendChild(cell(renderResultCell(row)));
  return tr;
}

function renderPreviewCell(row: MatrixRow): Node {
  if (!row.previewUrl) return document.createTextNode(row.status === 'pending' ? '...' : '-');
  const img = document.createElement('img');
  img.className = 'preview';
  img.src = row.previewUrl;
  img.alt = row.name;
  return img;
}

function renderNameCell(row: MatrixRow): Node {
  const wrapper = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = row.name;
  const category = document.createElement('div');
  category.className = 'muted';
  category.textContent = row.category;
  wrapper.append(name, category);
  return wrapper;
}

function renderResultCell(row: MatrixRow): Node {
  const wrapper = document.createElement('div');
  const pill = document.createElement('span');
  pill.className = `pill ${row.status === 'ok' ? 'ok' : row.status === 'pending' ? 'warn' : 'fail'}`;
  pill.textContent = row.status;
  wrapper.appendChild(pill);
  if (row.error) {
    const error = document.createElement('div');
    error.className = 'error';
    error.textContent = row.error;
    wrapper.appendChild(error);
  }
  return wrapper;
}

function cell(child: Node): HTMLTableCellElement {
  const td = document.createElement('td');
  td.appendChild(child);
  return td;
}

function textCell(text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function setStatus(text: string): void {
  const status = document.getElementById('status');
  if (status) status.textContent = text;
}

function displayName(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative || file.name;
}

function classifyInfo(info: Ktx2TextureInfo, name: string): string {
  const lower = name.toLowerCase();
  const family = info.uploadPath === 'basis-transcode'
    ? lower.includes('uastc') ? 'UASTC' : 'BasisLZ'
    : info.gpuFormat?.startsWith('bc') ? 'BC'
    : info.gpuFormat?.startsWith('etc') || lower.includes('etc') ? 'ETC2'
    : info.gpuFormat?.startsWith('astc') ? 'ASTC'
    : 'GPU-native';
  return `${family} / ${info.dimension}`;
}

function classifyName(name: string): string {
  const lower = name.toLowerCase();
  const family = lower.includes('bc') ? 'BC'
    : lower.includes('etc') ? 'ETC2'
    : lower.includes('astc') ? 'ASTC'
    : lower.includes('uastc') ? 'UASTC'
    : lower.includes('zlib') ? 'zlib'
    : 'KTX2';
  const shape = lower.includes('array') ? 'array'
    : lower.includes('cube') ? 'cubemap'
    : lower.includes('3d') ? '3D'
    : '2D';
  return `${family} / ${shape}`;
}

function getFeatureState(info: Ktx2TextureInfo): string {
  if (!info.requiredFeature) return 'none';
  if (device?.features.has(info.requiredFeature)) return `${info.requiredFeature}: enabled`;
  if (adapter?.features.has(info.requiredFeature)) return `${info.requiredFeature}: adapter-only`;
  return `${info.requiredFeature}: missing`;
}

function formatError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(' Cause: ');
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function getPreviewMode(format: GPUTextureFormat | null): number {
  if (!format) return 0;
  if (
    format.startsWith('bc4-') ||
    format.startsWith('eac-r11') ||
    format.startsWith('r8') ||
    format.startsWith('r16')
  ) {
    return 1;
  }
  if (
    format.startsWith('bc5-') ||
    format.startsWith('eac-rg11') ||
    format.startsWith('rg8') ||
    format.startsWith('rg16')
  ) {
    return 2;
  }
  return 0;
}

function createPreviewShader(isTexture3D: boolean, previewMode: number): string {
  return `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

const PREVIEW_MODE: u32 = ${previewMode}u;

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );
  var out: VertexOut;
  out.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}

@group(0) @binding(0) var previewTexture: texture_${isTexture3D ? '3d' : '2d'}<f32>;
@group(0) @binding(1) var previewSampler: sampler;

fn visualize(raw: vec4f) -> vec4f {
  if (PREVIEW_MODE == 1u) {
    return vec4f(vec3f(raw.r), 1.0);
  }
  if (PREVIEW_MODE == 2u) {
    return vec4f(raw.r, raw.g, 0.5, 1.0);
  }
  let maxRgb = max(max(raw.r, raw.g), raw.b);
  if (maxRgb < 0.015 && raw.a > 0.015) {
    return vec4f(vec3f(raw.a), 1.0);
  }
  return vec4f(raw.rgb, 1.0);
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let dimensions = vec${isTexture3D ? '3' : '2'}f(textureDimensions(previewTexture));
  let uv = clamp(in.uv, vec2f(0.0), vec2f(1.0));
  ${isTexture3D
    ? `let z = 0.5 / max(dimensions.z, 1.0) + 0.5 * (dimensions.z - 1.0) / max(dimensions.z, 1.0);
  return visualize(textureSampleLevel(previewTexture, previewSampler, vec3f(uv, z), 0.0));`
    : `return visualize(textureSampleLevel(previewTexture, previewSampler, uv, 0.0));`}
}
`;
}

void main();
