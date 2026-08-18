export interface DistributionMetric {
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export interface FrameFidelityMetrics {
  score: number;
  rgbaSimilarity: number;
  alphaIoU: number;
  normalizedRmse: number;
  closePixelRatio: number;
}

export interface CorpusSummary {
  sampleCount: number;
  referenceFrameCount: number;
  cleanConversionCount: number;
  failedFeatureSampleCount: number;
  unclassifiedFailureCount: number;
  totalLottieBytes: number;
  totalHyaBytes: number;
  totalLottieGzipBytes: number;
  totalHyaGzipBytes: number;
  rawByteSaving: number | null;
  gzipByteSaving: number | null;
  medianFidelity: number | null;
  minimumFidelity: number | null;
  medianParseSpeedup: number;
  firstFrameP50Ms: number | null;
  firstFrameP95Ms: number | null;
  networkP50Ms?: number | null;
  networkP95Ms?: number | null;
  downloadP50Ms?: number | null;
  downloadP95Ms?: number | null;
}

export interface CorpusReport {
  schemaVersion: 2 | 3;
  suiteVersion: string;
  generatedAt: string;
  source: {
    repository: string;
    revision: string;
    dataLicense: string;
    toolingLicense: string;
    rawBaseUrl: string;
  };
  sources?: Record<string, {
    repository: string;
    revision: string;
    dataLicense: string;
    toolingLicense: string;
    rawBaseUrl: string;
  }>;
  environment: {
    node: string;
    platform: string;
    arch: string;
    gitRevision: string;
    browser: BrowserEnvironment | null;
  };
  methodology: Record<string, string | number>;
  summary: CorpusSummary;
  cohorts?: {
    small: CorpusSummary;
    large: CorpusSummary;
  };
  parseStability: {
    runs: number[];
    minimum: number;
    median: number | null;
    maximum: number;
  };
  parseStabilityByCohort?: {
    small: CorpusReport['parseStability'];
    large: CorpusReport['parseStability'];
  };
  featureSummary: FeatureSummary[];
  samples: CorpusSample[];
}

export type FeatureSupportStatus = 'full' | 'partial' | 'unsupported';

export interface CapabilitySupportSnapshot {
  schemaVersion: 1;
  kind: 'hya-capability-support';
  generatedAt: string;
  sourceState: {
    gitRevision: string;
    workingTreeDirty: boolean;
  };
  methodology: string;
  summary: {
    featureCount: number;
    fullCount: number;
    partialCount: number;
    unsupportedCount: number;
    precompStatus: FeatureSupportStatus | 'not-observed';
  };
  features: CapabilitySupportEntry[];
}

export interface CapabilitySupportEntry {
  feature: string;
  label: string;
  status: FeatureSupportStatus;
  sampleCount: number;
  occurrenceCount: number;
  affectedSampleCount: number;
  failureCount: number;
  diagnosticCodes: string[];
  owner: string;
  priority: 'done' | 'P0' | 'P1' | 'P2' | 'source' | 'derived';
  kind: string;
  strategy: string;
}

export interface FeatureFailure {
  feature: string;
  support: Exclude<FeatureSupportStatus, 'full'>;
  impact: 'high' | 'medium' | 'low';
  severity: string;
  code: string;
  path: string;
  message: string;
}

export interface FeatureAnalysisEntry {
  feature: string;
  declared: boolean;
  occurrences: number;
  paths: string[];
  status: FeatureSupportStatus;
  failureCount: number;
  diagnosticCodes: string[];
  failures: FeatureFailure[];
}

export interface FeatureSummary {
  feature: string;
  status: FeatureSupportStatus;
  sampleCount: number;
  occurrenceCount: number;
  affectedSampleCount: number;
  unsupportedSampleCount: number;
  failureCount: number;
  cleanSampleRatio: number;
  averageFidelity: number | null;
  observedFidelityLoss: number | null;
  diagnosticCodes: string[];
}

export interface CorpusSample {
  id: string;
  title: string;
  category: string;
  sizeClass?: 'small' | 'large';
  features: string[];
  expectation: 'supported' | 'degraded' | 'unsupported';
  provenance?: {
    sourceId: string;
    repository: string;
    revision: string;
    dataLicense: string;
  };
  source: {
    bytes: number;
    gzipBytes: number;
    externalResourceBytes?: number;
    deliveryPayloadBytes?: number;
    sha256: string;
    url: string;
  };
  hya: {
    bytes: number;
    gzipBytes: number;
    deliveryPayloadBytes?: number;
    sizeRatio: number | null;
    gzipSizeRatio: number | null;
  };
  parse: {
    iterations: number;
    batchSize: number;
    jsonOnly: DistributionMetric;
    lottieToRuntime: DistributionMetric;
    hyaToRuntime: DistributionMetric;
    speedup: number | null;
  };
  conversion: {
    convertedLayerCount: number;
    skippedLayerCount: number;
    layerCoverage: number;
    nodeCount: number;
    trackCount: number;
    diagnosticCounts: Record<string, number>;
    diagnostics: Array<{ severity: string; code: string; message: string; path: string }>;
    status: 'clean' | 'degraded';
  };
  featureAnalysis: {
    declaredFeatures: string[];
    detectedFeatureCount: number;
    failedFeatureCount: number;
    unclassifiedFailureCount: number;
    primaryFailure: FeatureFailure | null;
    features: FeatureAnalysisEntry[];
  };
  delivery?: BrowserDeliveryMetric | null;
  fidelity: SampleFidelity | null;
  firstFrame: FirstFrameMetric | null;
  frames: Array<{
    frame: number;
    referenceKind?: 'after-effects' | 'lottie-web-canvas';
    referenceUrl: string;
    metrics: FrameFidelityMetrics | null;
  }>;
}

export interface SampleFidelity {
  score: number;
  minimumFrameScore: number;
  rgbaSimilarity: number;
  alphaIoU: number;
}

export interface FirstFrameMetric {
  totalMs: number;
  fetchMs: number;
  parseMs: number;
  runtimeAndGpuMs: number;
  visualCount: number;
  network?: HttpDeliveryMetric;
  pendingResourceCount?: number;
  failedResourceCount?: number;
  externalResourceCount?: number;
  externalResourceBytes?: number;
}

export interface HttpDeliveryMetric {
  requestToHeadersMs: number;
  bodyDownloadMs: number;
  totalMs: number;
  bytes: number;
  chunkCount: number;
  streamed: boolean;
  contentLength: number | null;
  contentEncoding: string | null;
}

export interface BrowserDeliveryMetric {
  source: {
    network: HttpDeliveryMetric;
    jsonParseMs: number;
  };
  hya: {
    network: HttpDeliveryMetric;
    parseMs: number;
  };
  externalResources?: Array<{
    url: string;
    kind: 'asset' | 'font';
    expectedBytes: number;
    network: HttpDeliveryMetric;
  }>;
}

export interface BrowserEnvironment {
  userAgent: string;
  adapter: Record<string, unknown> | null;
  format: GPUTextureFormat;
  devicePixelRatio: number;
}

export interface BrowserInput {
  schemaVersion: 1 | 2;
  corpus: string;
  samples: BrowserInputSample[];
}

export interface BrowserInputSample {
  id: string;
  title: string;
  sizeClass?: 'small' | 'large';
  width: number;
  height: number;
  frameRate: number;
  inFrame: number;
  sourceUrl?: string;
  hyaUrl: string;
  externalResourceUrls?: string[];
  externalResources?: Array<{
    url: string;
    bytes: number;
    kind: 'asset' | 'font';
  }>;
  frames: Array<{
    frame: number;
    referenceKind?: 'after-effects' | 'lottie-web-canvas';
    referenceUrl: string;
  }>;
}

export interface BrowserSampleResult {
  id: string;
  delivery?: BrowserDeliveryMetric;
  firstFrame: FirstFrameMetric;
  fidelity: SampleFidelity;
  frames: Array<{ frame: number; metrics: FrameFidelityMetrics }>;
}

export interface BrowserBenchmarkResult {
  schemaVersion: 1 | 2;
  environment: BrowserEnvironment;
  samples: BrowserSampleResult[];
}
