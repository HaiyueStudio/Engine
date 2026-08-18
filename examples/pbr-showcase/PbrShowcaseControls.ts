import {
  PBR_COMPATIBILITY_CONTRACT,
  PBR_TEXTURE_SLOTS,
  type PbrAlphaMode,
  type PbrMaterialState,
  type PbrTextureSlot,
} from '@haiyue/engine/material';
import type { DirectionalLight, EnvironmentLight, PbrMaterial } from '@haiyue/engine';

interface PbrShowcaseControlsOptions {
  materials: readonly PbrMaterial[];
  colorTexture: HTMLCanvasElement;
  dataTexture: HTMLCanvasElement;
  sun: DirectionalLight;
  environment: EnvironmentLight;
}

type MaterialNumberReader = (material: PbrMaterial) => number;
type MaterialNumberWriter = (material: PbrMaterial, value: number) => void;

const DEFAULT_SAMPLER: Required<Pick<
  GPUSamplerDescriptor,
  'addressModeU' | 'addressModeV' | 'magFilter' | 'minFilter' | 'mipmapFilter' | 'lodMinClamp' | 'lodMaxClamp' | 'maxAnisotropy'
>> = Object.freeze({
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
  magFilter: 'linear',
  minFilter: 'linear',
  mipmapFilter: 'linear',
  lodMinClamp: 0,
  lodMaxClamp: 32,
  maxAnisotropy: 1,
});

export function setupPbrShowcaseControls(options: PbrShowcaseControlsOptions): void {
  const { materials, colorTexture, dataTexture, sun, environment } = options;
  if (materials.length === 0) return;

  const initialStates: readonly PbrMaterialState[] = materials.map(material => material.snapshot());
  const targetSelect = element<HTMLSelectElement>('material-target');
  const targetSummary = element<HTMLElement>('target-summary');
  const variantSelect = element<HTMLSelectElement>('variant');
  const textureSlotSelect = element<HTMLSelectElement>('texture-slot');
  const textureMeta = element<HTMLElement>('texture-meta');
  const customMaterials = new Set<number>();
  const refreshers: Array<() => void> = [];
  let selectedMaterial: number | null = null;
  let syncing = false;

  materials.forEach((_material, index) => {
    const row = Math.floor(index / 5);
    const column = index % 5;
    targetSelect.add(new Option(`球体 ${row}:${column}`, String(index)));
  });
  for (const slot of PBR_TEXTURE_SLOTS) textureSlotSelect.add(new Option(textureSlotLabel(slot), slot));

  const targetIndices = (): number[] => selectedMaterial === null
    ? materials.map((_material, index) => index)
    : [selectedMaterial];
  const representative = (): PbrMaterial => materials[selectedMaterial ?? 0]!;
  const selectedTextureSlot = (): PbrTextureSlot => textureSlotSelect.value as PbrTextureSlot;

  const markCustom = (): void => {
    for (const index of targetIndices()) customMaterials.add(index);
    variantSelect.value = 'custom';
  };
  const mutateMaterials = (mutate: (material: PbrMaterial) => void): void => {
    if (syncing) return;
    for (const index of targetIndices()) mutate(materials[index]!);
    markCustom();
  };

  const syncVariant = (): void => {
    const indices = targetIndices();
    const first = materials[indices[0]!]!;
    const active = customMaterials.has(indices[0]!) ? 'custom' : (first.activeVariant ?? '');
    variantSelect.value = indices.every(index =>
      (customMaterials.has(index) ? 'custom' : (materials[index]!.activeVariant ?? '')) === active,
    ) ? active : 'custom';
  };
  const syncAll = (): void => {
    syncing = true;
    for (const refresh of refreshers) refresh();
    syncVariant();
    targetSummary.textContent = selectedMaterial === null
      ? `全部 ${materials.length} 个 · 显示 0:0`
      : `球体 ${Math.floor(selectedMaterial / 5)}:${selectedMaterial % 5}`;
    syncing = false;
  };

  targetSelect.addEventListener('change', () => {
    selectedMaterial = targetSelect.value === 'all' ? null : Number(targetSelect.value);
    syncAll();
  });
  variantSelect.addEventListener('change', () => {
    if (variantSelect.value === 'custom') return;
    const name = variantSelect.value || null;
    for (const index of targetIndices()) {
      materials[index]!.setVariant(name);
      customMaterials.delete(index);
    }
    syncAll();
  });
  element<HTMLButtonElement>('reset-material').addEventListener('click', () => {
    for (const index of targetIndices()) {
      materials[index]!.applyState(initialStates[index]!);
      materials[index]!.setVariant(null);
      customMaterials.delete(index);
    }
    syncAll();
  });

  bindMaterialColor('base-color',
    material => colorToHex(material.baseColor),
    (material, rgb) => material.baseColor = [...rgb, material.baseColor.a],
  );
  bindMaterialNumber('base-alpha',
    material => material.baseColor.a,
    (material, value) => {
      const rgb = readSrgb(material.baseColor);
      material.baseColor = [rgb[0], rgb[1], rgb[2], value];
    },
  );
  bindMaterialNumber('metallic', material => material.metallic, (material, value) => material.metallic = value);
  bindMaterialNumber('roughness', material => material.roughness, (material, value) => material.roughness = value);
  bindMaterialNumber('normal-scale', material => material.normalScale, (material, value) => material.normalScale = value);
  bindMaterialNumber('occlusion-strength', material => material.occlusionStrength, (material, value) => material.occlusionStrength = value);
  bindVectorChannel('emissive-r', 0, material => material.emissiveFactor, (material, value) => material.emissiveFactor = value);
  bindVectorChannel('emissive-g', 1, material => material.emissiveFactor, (material, value) => material.emissiveFactor = value);
  bindVectorChannel('emissive-b', 2, material => material.emissiveFactor, (material, value) => material.emissiveFactor = value);

  bindMaterialNumber('clearcoat-factor', material => material.clearcoatFactor, (material, value) => material.clearcoatFactor = value);
  bindMaterialNumber('clearcoat-roughness', material => material.clearcoatRoughnessFactor, (material, value) => material.clearcoatRoughnessFactor = value);
  bindMaterialNumber('clearcoat-normal-scale', material => material.clearcoatNormalScale, (material, value) => material.clearcoatNormalScale = value);

  bindMaterialNumber('ior', material => material.ior, (material, value) => material.ior = value);
  bindMaterialNumber('specular-factor', material => material.specularFactor, (material, value) => material.specularFactor = value);
  bindVectorChannel('specular-r', 0, material => material.specularColorFactor, (material, value) => material.specularColorFactor = value);
  bindVectorChannel('specular-g', 1, material => material.specularColorFactor, (material, value) => material.specularColorFactor = value);
  bindVectorChannel('specular-b', 2, material => material.specularColorFactor, (material, value) => material.specularColorFactor = value);

  bindVectorChannel('sheen-r', 0, material => material.sheenColorFactor, (material, value) => material.sheenColorFactor = value);
  bindVectorChannel('sheen-g', 1, material => material.sheenColorFactor, (material, value) => material.sheenColorFactor = value);
  bindVectorChannel('sheen-b', 2, material => material.sheenColorFactor, (material, value) => material.sheenColorFactor = value);
  bindMaterialNumber('sheen-roughness', material => material.sheenRoughnessFactor, (material, value) => material.sheenRoughnessFactor = value);

  bindMaterialNumber('transmission-factor', material => material.transmissionFactor, (material, value) => material.transmissionFactor = value);
  bindMaterialNumber('thickness-factor', material => material.thicknessFactor, (material, value) => material.thicknessFactor = value);
  const attenuationInfinite = bindMaterialCheckbox(
    'attenuation-infinite',
    material => material.attenuationDistance === Infinity,
    (material, checked) => material.attenuationDistance = checked ? Infinity : 1,
  );
  const attenuationDistance = element<HTMLInputElement>('attenuation-distance');
  bindMaterialNumber(
    'attenuation-distance',
    material => material.attenuationDistance === Infinity ? 1 : material.attenuationDistance,
    (material, value) => material.attenuationDistance = value,
  );
  refreshers.push(() => {
    attenuationDistance.disabled = attenuationInfinite.checked;
    const output = document.querySelector<HTMLOutputElement>('output[for="attenuation-distance"]');
    if (output && attenuationInfinite.checked) output.value = '∞';
  });
  bindVectorChannel('attenuation-r', 0, material => material.attenuationColor, (material, value) => material.attenuationColor = value);
  bindVectorChannel('attenuation-g', 1, material => material.attenuationColor, (material, value) => material.attenuationColor = value);
  bindVectorChannel('attenuation-b', 2, material => material.attenuationColor, (material, value) => material.attenuationColor = value);

  bindMaterialSelect<PbrAlphaMode>('alpha-mode', material => material.alphaMode, (material, value) => material.alphaMode = value);
  const alphaCutoff = element<HTMLInputElement>('alpha-cutoff');
  bindMaterialNumber('alpha-cutoff', material => material.alphaCutoff, (material, value) => material.alphaCutoff = value);
  refreshers.push(() => alphaCutoff.disabled = representative().alphaMode !== 'mask');
  bindMaterialCheckbox('double-sided', material => material.doubleSided, (material, value) => material.doubleSided = value);

  textureSlotSelect.addEventListener('change', syncAll);
  bindMaterialCheckbox(
    'texture-enabled',
    material => getTexture(material, selectedTextureSlot()) !== null,
    (material, enabled) => setTexture(
      material,
      selectedTextureSlot(),
      enabled ? textureForSlot(selectedTextureSlot(), colorTexture, dataTexture) : null,
    ),
  );
  bindTextureMappingSelect('texture-texcoord', mapping => String(mapping.texCoord), (material, value) => {
    const mapping = material.getTextureMapping(selectedTextureSlot());
    material.setTextureMapping(selectedTextureSlot(), { ...mapping, texCoord: Number(value) as 0 | 1 });
  });
  bindTextureMappingNumber('texture-offset-x', mapping => mapping.offset[0], (material, value) => {
    const mapping = material.getTextureMapping(selectedTextureSlot());
    material.setTextureMapping(selectedTextureSlot(), { ...mapping, offset: [value, mapping.offset[1]] });
  });
  bindTextureMappingNumber('texture-offset-y', mapping => mapping.offset[1], (material, value) => {
    const mapping = material.getTextureMapping(selectedTextureSlot());
    material.setTextureMapping(selectedTextureSlot(), { ...mapping, offset: [mapping.offset[0], value] });
  });
  bindTextureMappingNumber('texture-rotation', mapping => mapping.rotation, (material, value) => {
    material.setTextureMapping(selectedTextureSlot(), { ...material.getTextureMapping(selectedTextureSlot()), rotation: value });
  });
  bindTextureMappingNumber('texture-scale-x', mapping => mapping.scale[0], (material, value) => {
    const mapping = material.getTextureMapping(selectedTextureSlot());
    material.setTextureMapping(selectedTextureSlot(), { ...mapping, scale: [value, mapping.scale[1]] });
  });
  bindTextureMappingNumber('texture-scale-y', mapping => mapping.scale[1], (material, value) => {
    const mapping = material.getTextureMapping(selectedTextureSlot());
    material.setTextureMapping(selectedTextureSlot(), { ...mapping, scale: [mapping.scale[0], value] });
  });

  const samplerOverride = bindMaterialCheckbox(
    'sampler-override',
    material => material.getTextureSampler(selectedTextureSlot()) !== null,
    (material, enabled) => material.setTextureSampler(selectedTextureSlot(), enabled ? DEFAULT_SAMPLER : null),
  );
  const samplerElements = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-sampler]')];
  refreshers.push(() => {
    for (const input of samplerElements) input.disabled = !samplerOverride.checked;
    const slot = selectedTextureSlot();
    const contract = PBR_COMPATIBILITY_CONTRACT.textureSlots[slot];
    textureMeta.textContent = `${contract.colorSpace.toUpperCase()} · ${contract.format} · ${textureChannelHint(slot)}`;
  });
  bindSamplerSelect('sampler-address-u', 'addressModeU');
  bindSamplerSelect('sampler-address-v', 'addressModeV');
  bindSamplerSelect('sampler-mag', 'magFilter');
  bindSamplerSelect('sampler-min', 'minFilter');
  bindSamplerSelect('sampler-mipmap', 'mipmapFilter');
  bindSamplerNumber('sampler-lod-min', 'lodMinClamp');
  bindSamplerNumber('sampler-lod-max', 'lodMaxClamp');
  bindSamplerNumber('sampler-anisotropy', 'maxAnisotropy');

  bindSceneColor('sun-color', () => colorToHex(sun.color), rgb => sun.color = rgb);
  bindSceneNumber('sun-intensity', () => sun.intensity, value => sun.intensity = value);
  bindSceneNumber('sun-direction-x', () => sun.direction[0], value => sun.setDirection(value, sun.direction[1], sun.direction[2]));
  bindSceneNumber('sun-direction-y', () => sun.direction[1], value => sun.setDirection(sun.direction[0], value, sun.direction[2]));
  bindSceneNumber('sun-direction-z', () => sun.direction[2], value => sun.setDirection(sun.direction[0], sun.direction[1], value));
  bindSceneCheckbox('sun-cast-shadow', () => sun.castShadow, value => { sun.castShadow = value; sun.markDirty(); });
  bindSceneSelect('shadow-map-size', () => String(sun.shadow.mapSize), value => {
    sun.shadow.mapSize = Number(value) as 512 | 1024 | 2048;
    sun.markDirty();
  });
  bindSceneNumber('shadow-extent', () => sun.shadow.extent, value => { sun.shadow.extent = value; sun.markDirty(); });
  bindSceneNumber('shadow-near', () => sun.shadow.near, value => { sun.shadow.near = value; sun.markDirty(); });
  bindSceneNumber('shadow-far', () => sun.shadow.far, value => { sun.shadow.far = value; sun.markDirty(); });
  bindSceneNumber('shadow-bias', () => sun.shadow.bias, value => { sun.shadow.bias = value; sun.markDirty(); });
  bindSceneNumber('shadow-normal-bias', () => sun.shadow.normalBias, value => { sun.shadow.normalBias = value; sun.markDirty(); });

  bindSceneNumber('environment-intensity', () => environment.intensity, value => environment.intensity = Math.max(0, value));
  bindSceneNumber('environment-rotation', () => environment.rotation, value => environment.rotation = value);
  bindSceneColor('environment-diffuse', () => colorToHex(environment.diffuseColor), rgb => environment.diffuseColor = rgb);
  bindSceneColor('environment-specular', () => colorToHex(environment.specularColor), rgb => environment.specularColor = rgb);

  syncAll();

  function bindMaterialNumber(id: string, read: MaterialNumberReader, write: MaterialNumberWriter): HTMLInputElement {
    const input = element<HTMLInputElement>(id);
    const output = document.querySelector<HTMLOutputElement>(`output[for="${id}"]`);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      mutateMaterials(material => write(material, value));
      if (output) output.value = formatNumber(value);
    });
    refreshers.push(() => {
      const value = read(representative());
      input.value = String(value);
      if (output) output.value = formatNumber(value);
    });
    return input;
  }

  function bindVectorChannel(
    id: string,
    channel: 0 | 1 | 2,
    read: (material: PbrMaterial) => readonly [number, number, number],
    write: (material: PbrMaterial, value: readonly [number, number, number]) => void,
  ): void {
    bindMaterialNumber(id, material => read(material)[channel], (material, channelValue) => {
      const vector = [...read(material)] as [number, number, number];
      vector[channel] = channelValue;
      write(material, vector);
    });
  }

  function bindMaterialCheckbox(
    id: string,
    read: (material: PbrMaterial) => boolean,
    write: (material: PbrMaterial, value: boolean) => void,
  ): HTMLInputElement {
    const input = element<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      mutateMaterials(material => write(material, input.checked));
      syncAll();
    });
    refreshers.push(() => input.checked = read(representative()));
    return input;
  }

  function bindMaterialSelect<T extends string>(
    id: string,
    read: (material: PbrMaterial) => T,
    write: (material: PbrMaterial, value: T) => void,
  ): void {
    const input = element<HTMLSelectElement>(id);
    input.addEventListener('change', () => {
      mutateMaterials(material => write(material, input.value as T));
      syncAll();
    });
    refreshers.push(() => input.value = read(representative()));
  }

  function bindMaterialColor(
    id: string,
    read: (material: PbrMaterial) => string,
    write: (material: PbrMaterial, value: readonly [number, number, number]) => void,
  ): void {
    const input = element<HTMLInputElement>(id);
    input.addEventListener('input', () => mutateMaterials(material => write(material, hexToRgb(input.value))));
    refreshers.push(() => input.value = read(representative()));
  }

  function bindTextureMappingNumber(
    id: string,
    read: (mapping: ReturnType<PbrMaterial['getTextureMapping']>) => number,
    write: MaterialNumberWriter,
  ): void {
    bindMaterialNumber(id, material => read(material.getTextureMapping(selectedTextureSlot())), write);
  }

  function bindTextureMappingSelect(
    id: string,
    read: (mapping: ReturnType<PbrMaterial['getTextureMapping']>) => string,
    write: (material: PbrMaterial, value: string) => void,
  ): void {
    const input = element<HTMLSelectElement>(id);
    input.addEventListener('change', () => mutateMaterials(material => write(material, input.value)));
    refreshers.push(() => input.value = read(representative().getTextureMapping(selectedTextureSlot())));
  }

  function bindSamplerSelect(
    id: string,
    key: 'addressModeU' | 'addressModeV' | 'magFilter' | 'minFilter' | 'mipmapFilter',
  ): void {
    const input = element<HTMLSelectElement>(id);
    input.addEventListener('change', () => {
      mutateMaterials(material => updateSampler(material, { [key]: input.value }));
      syncAll();
    });
    refreshers.push(() => input.value = String(resolvedSampler(representative())[key]));
  }

  function bindSamplerNumber(
    id: string,
    key: 'lodMinClamp' | 'lodMaxClamp' | 'maxAnisotropy',
  ): void {
    const input = element<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      mutateMaterials(material => updateSampler(material, { [key]: value }));
      syncAll();
    });
    refreshers.push(() => input.value = String(resolvedSampler(representative())[key]));
  }

  function updateSampler(material: PbrMaterial, patch: Partial<GPUSamplerDescriptor>): void {
    const slot = selectedTextureSlot();
    const sampler: GPUSamplerDescriptor = { ...resolvedSampler(material), ...patch };
    if (patch.magFilter === 'nearest' || patch.minFilter === 'nearest' || patch.mipmapFilter === 'nearest') {
      sampler.maxAnisotropy = 1;
    }
    const anisotropy = Number(sampler.maxAnisotropy ?? 1);
    if (anisotropy > 1) {
      sampler.magFilter = 'linear';
      sampler.minFilter = 'linear';
      sampler.mipmapFilter = 'linear';
    }
    const minLod = Number(sampler.lodMinClamp ?? 0);
    const maxLod = Number(sampler.lodMaxClamp ?? 32);
    if (minLod > maxLod) {
      if ('lodMinClamp' in patch) sampler.lodMaxClamp = minLod;
      else sampler.lodMinClamp = maxLod;
    }
    material.setTextureSampler(slot, sampler);
  }

  function resolvedSampler(material: PbrMaterial): typeof DEFAULT_SAMPLER {
    return { ...DEFAULT_SAMPLER, ...(material.getTextureSampler(selectedTextureSlot()) ?? {}) };
  }

  function bindSceneNumber(id: string, read: () => number, write: (value: number) => void): void {
    const input = element<HTMLInputElement>(id);
    const output = document.querySelector<HTMLOutputElement>(`output[for="${id}"]`);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      write(value);
      if (output) output.value = formatNumber(value);
    });
    refreshers.push(() => {
      const value = read();
      input.value = String(value);
      if (output) output.value = formatNumber(value);
    });
  }

  function bindSceneCheckbox(id: string, read: () => boolean, write: (value: boolean) => void): void {
    const input = element<HTMLInputElement>(id);
    input.addEventListener('change', () => write(input.checked));
    refreshers.push(() => input.checked = read());
  }

  function bindSceneSelect(id: string, read: () => string, write: (value: string) => void): void {
    const input = element<HTMLSelectElement>(id);
    input.addEventListener('change', () => write(input.value));
    refreshers.push(() => input.value = read());
  }

  function bindSceneColor(id: string, read: () => string, write: (value: readonly [number, number, number]) => void): void {
    const input = element<HTMLInputElement>(id);
    input.addEventListener('input', () => write(hexToRgb(input.value)));
    refreshers.push(() => input.value = read());
  }
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`PBR showcase control #${id} is missing.`);
  return value as T;
}

function readSrgb(color: { writeSRGB(out: Float32Array): Float32Array }): readonly [number, number, number] {
  const value = color.writeSRGB(new Float32Array(4));
  return [value[0]!, value[1]!, value[2]!];
}

function colorToHex(color: { writeSRGB(out: Float32Array): Float32Array }): string {
  const value = color.writeSRGB(new Float32Array(4));
  const hex = (channel: number): string => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0');
  return `#${hex(value[0]!)}${hex(value[1]!)}${hex(value[2]!)}`;
}

function hexToRgb(hex: string): readonly [number, number, number] {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}

function formatNumber(value: number): string {
  if (value === Infinity) return '∞';
  if (Math.abs(value) >= 10) return value.toFixed(1);
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(1);
  return value.toFixed(2);
}

function textureForSlot(
  slot: PbrTextureSlot,
  colorTexture: HTMLCanvasElement,
  dataTexture: HTMLCanvasElement,
): HTMLCanvasElement {
  return PBR_COMPATIBILITY_CONTRACT.textureSlots[slot].colorSpace === 'srgb' ? colorTexture : dataTexture;
}

function getTexture(material: PbrMaterial, slot: PbrTextureSlot): unknown {
  switch (slot) {
    case 'baseColor': return material.baseColorTexture;
    case 'metallicRoughness': return material.metallicRoughnessTexture;
    case 'normal': return material.normalTexture;
    case 'occlusion': return material.occlusionTexture;
    case 'emissive': return material.emissiveTexture;
    case 'clearcoat': return material.clearcoatTexture;
    case 'clearcoatRoughness': return material.clearcoatRoughnessTexture;
    case 'clearcoatNormal': return material.clearcoatNormalTexture;
    case 'specular': return material.specularTexture;
    case 'specularColor': return material.specularColorTexture;
    case 'sheenColor': return material.sheenColorTexture;
    case 'sheenRoughness': return material.sheenRoughnessTexture;
    case 'transmission': return material.transmissionTexture;
    case 'thickness': return material.thicknessTexture;
  }
}

function setTexture(material: PbrMaterial, slot: PbrTextureSlot, value: HTMLCanvasElement | null): void {
  switch (slot) {
    case 'baseColor': material.baseColorTexture = value; break;
    case 'metallicRoughness': material.metallicRoughnessTexture = value; break;
    case 'normal': material.normalTexture = value; break;
    case 'occlusion': material.occlusionTexture = value; break;
    case 'emissive': material.emissiveTexture = value; break;
    case 'clearcoat': material.clearcoatTexture = value; break;
    case 'clearcoatRoughness': material.clearcoatRoughnessTexture = value; break;
    case 'clearcoatNormal': material.clearcoatNormalTexture = value; break;
    case 'specular': material.specularTexture = value; break;
    case 'specularColor': material.specularColorTexture = value; break;
    case 'sheenColor': material.sheenColorTexture = value; break;
    case 'sheenRoughness': material.sheenRoughnessTexture = value; break;
    case 'transmission': material.transmissionTexture = value; break;
    case 'thickness': material.thicknessTexture = value; break;
  }
}

function textureSlotLabel(slot: PbrTextureSlot): string {
  return slot.replace(/[A-Z]/g, match => ` ${match.toLowerCase()}`);
}

function textureChannelHint(slot: PbrTextureSlot): string {
  const hints: Record<PbrTextureSlot, string> = {
    baseColor: 'RGBA',
    metallicRoughness: 'G roughness · B metallic',
    normal: 'RGB tangent-space normal',
    occlusion: 'R occlusion',
    emissive: 'RGB emission',
    clearcoat: 'R factor',
    clearcoatRoughness: 'G roughness',
    clearcoatNormal: 'RGB tangent-space normal',
    specular: 'A factor',
    specularColor: 'RGB color',
    sheenColor: 'RGB color',
    sheenRoughness: 'A roughness',
    transmission: 'R factor',
    thickness: 'G thickness',
  };
  return hints[slot];
}
