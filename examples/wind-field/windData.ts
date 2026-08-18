export interface WindDataMetadata {
  source: string;
  date: string;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface LoadedWindData {
  metadata: WindDataMetadata;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  coastlineSegments: Float32Array<ArrayBuffer>;
}

export async function loadWindData(signal: AbortSignal): Promise<LoadedWindData> {
  const metadataUrl = new URL('./2016112000.json', import.meta.url);
  const imageUrl = new URL('./2016112000.png', import.meta.url);
  const coastlineUrl = new URL('./ne_110m_coastline.geojson', import.meta.url);
  const [metadataResponse, imageResponse, coastlineResponse] = await Promise.all([
    fetch(metadataUrl, { signal }),
    fetch(imageUrl, { signal }),
    fetch(coastlineUrl, { signal }),
  ]);
  if (!metadataResponse.ok) {
    throw new Error(`Wind metadata request failed (HTTP ${metadataResponse.status}).`);
  }
  if (!imageResponse.ok) {
    throw new Error(`Wind texture request failed (HTTP ${imageResponse.status}).`);
  }
  if (!coastlineResponse.ok) {
    throw new Error(`Coastline request failed (HTTP ${coastlineResponse.status}).`);
  }

  const metadata = validateWindMetadata(await metadataResponse.json());
  const coastlineSegments = parseCoastlineGeoJson(await coastlineResponse.json());
  const image = await createImageBitmap(await imageResponse.blob(), { colorSpaceConversion: 'none' });
  if (image.width !== metadata.width || image.height !== metadata.height) {
    image.close();
    throw new Error(
      `Wind texture dimensions ${image.width}x${image.height} do not match metadata ${metadata.width}x${metadata.height}.`,
    );
  }
  const canvas = document.createElement('canvas');
  canvas.width = metadata.width;
  canvas.height = metadata.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    image.close();
    throw new Error('Wind texture decoding requires a 2D canvas context.');
  }
  context.drawImage(image, 0, 0);
  const decoded = context.getImageData(0, 0, metadata.width, metadata.height).data;
  image.close();
  const pixels = new Uint8ClampedArray(new ArrayBuffer(decoded.byteLength));
  pixels.set(decoded);
  return { metadata, pixels, coastlineSegments };
}

function validateWindMetadata(value: unknown): WindDataMetadata {
  if (!value || typeof value !== 'object') throw new Error('Wind metadata must be an object.');
  const record = value as Record<string, unknown>;
  const source = requireString(record, 'source');
  const date = requireString(record, 'date');
  const width = requirePositiveInteger(record, 'width');
  const height = requirePositiveInteger(record, 'height');
  const uMin = requireFiniteNumber(record, 'uMin');
  const uMax = requireFiniteNumber(record, 'uMax');
  const vMin = requireFiniteNumber(record, 'vMin');
  const vMax = requireFiniteNumber(record, 'vMax');
  if (uMin >= uMax || vMin >= vMax) {
    throw new Error('Wind metadata min/max ranges are invalid.');
  }
  return { source, date, width, height, uMin, uMax, vMin, vMax };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Wind metadata ${key} must be a string.`);
  return value;
}

function requirePositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = requireFiniteNumber(record, key);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Wind metadata ${key} must be a positive integer.`);
  return value;
}

function requireFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Wind metadata ${key} must be a finite number.`);
  }
  return value;
}

function parseCoastlineGeoJson(value: unknown): Float32Array<ArrayBuffer> {
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new Error('Coastline GeoJSON must be a FeatureCollection.');
  }
  const segments: number[] = [];
  for (let featureIndex = 0; featureIndex < value.features.length; featureIndex++) {
    const feature = value.features[featureIndex];
    if (!isRecord(feature) || feature.type !== 'Feature' || !isRecord(feature.geometry)) {
      throw new Error(`Coastline feature ${featureIndex} is invalid.`);
    }
    const { geometry } = feature;
    if (geometry.type === 'LineString') {
      appendLineSegments(geometry.coordinates, segments, `features[${featureIndex}].geometry.coordinates`);
    } else if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
      for (let lineIndex = 0; lineIndex < geometry.coordinates.length; lineIndex++) {
        appendLineSegments(
          geometry.coordinates[lineIndex],
          segments,
          `features[${featureIndex}].geometry.coordinates[${lineIndex}]`,
        );
      }
    } else {
      throw new Error(`Coastline feature ${featureIndex} uses unsupported geometry ${String(geometry.type)}.`);
    }
  }
  if (segments.length === 0) throw new Error('Coastline GeoJSON contains no drawable segments.');
  const result = new Float32Array(new ArrayBuffer(segments.length * Float32Array.BYTES_PER_ELEMENT));
  result.set(segments);
  return result;
}

function appendLineSegments(value: unknown, segments: number[], path: string): void {
  if (!Array.isArray(value) || value.length < 2) throw new Error(`${path} must contain at least two positions.`);
  let previous = parsePosition(value[0], `${path}[0]`);
  for (let index = 1; index < value.length; index++) {
    const current = parsePosition(value[index], `${path}[${index}]`);
    if (Math.abs(current[0] - previous[0]) <= 180) {
      segments.push(...project(previous), ...project(current));
    }
    previous = current;
  }
}

function parsePosition(value: unknown, path: string): readonly [number, number] {
  if (
    !Array.isArray(value)
    || typeof value[0] !== 'number'
    || !Number.isFinite(value[0])
    || typeof value[1] !== 'number'
    || !Number.isFinite(value[1])
    || value[0] < -180
    || value[0] > 180
    || value[1] < -90
    || value[1] > 90
  ) {
    throw new Error(`${path} must be a finite [longitude, latitude] position.`);
  }
  return [value[0], value[1]];
}

function project([longitude, latitude]: readonly [number, number]): readonly [number, number] {
  return [longitude / 180, latitude / 90];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
