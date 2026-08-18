import type {
  CapabilitySupportSnapshot,
  CorpusReport,
  CorpusSample,
  CorpusSummary,
  FeatureSummary,
  FeatureSupportStatus,
} from './types';

type ExpectationFilter = 'all' | CorpusSample['expectation'];
type SizeClassFilter = 'all' | 'small' | 'large';

export async function renderDashboard(): Promise<void> {
  const [report, capabilities] = await Promise.all([fetchReport(), fetchCapabilities()]);
  renderMeta(report);
  renderKpis(report);
  renderCohorts(report);
  renderCapabilitySupport(capabilities);
  renderFeatureSummary(report.featureSummary);
  const categories = [...new Set(report.samples.map(sample => sample.category))].sort();
  const category = requiredElement<HTMLSelectElement>('category-filter');
  for (const value of categories) category.add(new Option(value, value));

  const search = requiredElement<HTMLInputElement>('search');
  const expectation = requiredElement<HTMLSelectElement>('expectation-filter');
  const sizeClass = requiredElement<HTMLSelectElement>('size-class-filter');
  const refresh = (): void => {
    const term = search.value.trim().toLocaleLowerCase();
    const expectationValue = expectation.value as ExpectationFilter;
    const visible = report.samples.filter(sample => {
      const analyzedFeatures = sample.featureAnalysis.features.map(feature => feature.feature);
      const matchesText = term.length === 0 || [sample.id, sample.title, ...sample.features, ...analyzedFeatures]
        .some(value => value.toLocaleLowerCase().includes(term));
      const matchesExpectation = expectationValue === 'all' || sample.expectation === expectationValue;
      const matchesCategory = category.value === 'all' || sample.category === category.value;
      const sizeClassValue = sizeClass.value as SizeClassFilter;
      const matchesSizeClass = sizeClassValue === 'all' || (sample.sizeClass ?? 'small') === sizeClassValue;
      return matchesText && matchesExpectation && matchesCategory && matchesSizeClass;
    });
    renderScatter(visible);
    renderTable(visible);
    requiredElement('visible-count').textContent = `${visible.length} / ${report.samples.length}`;
  };
  search.addEventListener('input', refresh);
  expectation.addEventListener('change', refresh);
  sizeClass.addEventListener('change', refresh);
  category.addEventListener('change', refresh);
  requiredElement('export-json').addEventListener('click', () => downloadJson(report));
  refresh();

  const detail = requiredElement<HTMLDialogElement>('sample-detail');
  requiredElement('detail-close').addEventListener('click', () => detail.close());
  detail.addEventListener('click', event => {
    if (event.target === detail) detail.close();
  });
}

async function fetchReport(): Promise<CorpusReport> {
  const requested = new URLSearchParams(window.location.search).get('report') ?? './report.json';
  const reportUrl = new URL(requested, window.location.href);
  if (reportUrl.origin !== window.location.origin) throw new Error('仪表盘报告必须与页面同源。');
  const response = await fetch(reportUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`无法读取仪表盘报告：HTTP ${response.status}`);
  const report = await response.json() as CorpusReport;
  if (![2, 3].includes(report.schemaVersion) || !Array.isArray(report.samples) || !Array.isArray(report.featureSummary)) {
    throw new Error('仪表盘报告格式不正确。');
  }
  return report;
}

async function fetchCapabilities(): Promise<CapabilitySupportSnapshot> {
  const response = await fetch('./capabilities.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`无法读取当前能力矩阵：HTTP ${response.status}`);
  const snapshot = await response.json() as CapabilitySupportSnapshot;
  if (
    snapshot.schemaVersion !== 1
    || snapshot.kind !== 'hya-capability-support'
    || !Array.isArray(snapshot.features)
  ) throw new Error('HYA 当前能力矩阵格式不正确。');
  return snapshot;
}

function renderMeta(report: CorpusReport): void {
  const generated = new Date(report.generatedAt);
  requiredElement('report-meta').textContent = [
    `suite ${report.suiteVersion}`,
    Number.isNaN(generated.getTime()) ? report.generatedAt : generated.toLocaleString('zh-CN'),
    report.environment.browser ? browserLabel(report.environment.browser.adapter) : '未执行浏览器测量',
  ].join(' · ');
  const revision = requiredElement<HTMLAnchorElement>('source-revision');
  revision.href = `${report.source.repository}/tree/${report.source.revision}`;
  revision.textContent = report.source.revision.slice(0, 8);
}

function renderKpis(report: CorpusReport): void {
  const acceptance = report.cohorts?.small ?? report.summary;
  const values: Record<string, { value: string; note: string }> = {
    'kpi-fidelity': {
      value: percent(acceptance.medianFidelity, 2),
      note: `legacy 最低 ${percent(acceptance.minimumFidelity, 2)}`,
    },
    'kpi-size': {
      value: percent(acceptance.gzipByteSaving, 1),
      note: `${bytes(acceptance.totalLottieGzipBytes)} → ${bytes(acceptance.totalHyaGzipBytes)}`,
    },
    'kpi-parse': {
      value: `${format(acceptance.medianParseSpeedup, 2)}×`,
      note: `${report.parseStability.runs.length} 轮最低 ${format(report.parseStability.minimum, 2)}×`,
    },
    'kpi-first-frame': {
      value: milliseconds(acceptance.firstFrameP50Ms),
      note: `legacy p95 ${milliseconds(acceptance.firstFrameP95Ms)}`,
    },
  };
  for (const [id, metric] of Object.entries(values)) {
    const card = requiredElement(id);
    requiredDescendant(card, '.metric-value').textContent = metric.value;
    requiredDescendant(card, '.metric-note').textContent = metric.note;
  }
  const largeCount = report.cohorts?.large.sampleCount ?? report.samples.filter(sample => sample.sizeClass === 'large').length;
  requiredElement('corpus-count').textContent = [
    `${report.summary.sampleCount} 个真实素材`,
    `${report.cohorts?.small.sampleCount ?? report.summary.sampleCount} small`,
    `${largeCount} large`,
    `${report.summary.referenceFrameCount} 张固定参考帧`,
  ].join(' · ');
}

function renderCohorts(report: CorpusReport): void {
  const small = report.cohorts?.small ?? report.summary;
  const large = report.cohorts?.large ?? emptySummary();
  renderCohort('cohort-small', 'LEGACY / SMALL', small);
  renderCohort('cohort-large', 'LARGE / DELIVERY', large);
}

function renderCohort(id: string, label: string, summary: CorpusSummary): void {
  const target = requiredElement(id);
  requiredDescendant(target, '.cohort-label').textContent = `${label} · ${summary.sampleCount}`;
  requiredDescendant(target, '.cohort-fidelity').textContent = percent(summary.medianFidelity, 2);
  requiredDescendant(target, '.cohort-size').textContent = percent(summary.gzipByteSaving, 1);
  requiredDescendant(target, '.cohort-parse').textContent = `${format(summary.medianParseSpeedup, 2)}×`;
  requiredDescendant(target, '.cohort-network').textContent = milliseconds(summary.networkP50Ms ?? null);
  requiredDescendant(target, '.cohort-first-frame').textContent = milliseconds(summary.firstFrameP50Ms);
}

function renderCapabilitySupport(snapshot: CapabilitySupportSnapshot): void {
  const revision = snapshot.sourceState.gitRevision === 'unknown'
    ? 'unknown'
    : snapshot.sourceState.gitRevision.slice(0, 8);
  requiredElement('capability-meta').textContent = [
    `${snapshot.summary.featureCount} features`,
    `${snapshot.summary.fullCount} full`,
    `${snapshot.summary.partialCount} partial`,
    `${snapshot.summary.unsupportedCount} unsupported`,
    `precomp ${snapshot.summary.precompStatus}`,
    `${revision}${snapshot.sourceState.workingTreeDirty ? ' + working tree' : ''}`,
  ].join(' · ');
  const body = requiredElement<HTMLTableSectionElement>('capability-rows');
  body.replaceChildren();
  for (const feature of snapshot.features) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const label = document.createElement('strong');
    label.textContent = feature.label;
    const code = document.createElement('code');
    code.textContent = feature.feature;
    name.append(label, code);
    const status = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = `feature-status feature-status--${feature.status}`;
    statusBadge.textContent = featureStatusLabel(feature.status);
    status.append(statusBadge);
    const owner = document.createElement('td');
    const ownerBadge = document.createElement('span');
    ownerBadge.className = `capability-kind capability-kind--${feature.kind}`;
    ownerBadge.textContent = feature.owner;
    owner.append(ownerBadge);
    const priority = document.createElement('td');
    const priorityBadge = document.createElement('span');
    priorityBadge.className = `capability-priority capability-priority--${feature.priority.toLowerCase()}`;
    priorityBadge.textContent = feature.priority;
    priority.append(priorityBadge);
    const strategy = document.createElement('td');
    strategy.className = 'capability-strategy';
    strategy.textContent = feature.strategy;
    row.append(
      name,
      status,
      metricCell(`${feature.sampleCount} / ${feature.occurrenceCount}`, `${feature.affectedSampleCount} affected`),
      metricCell(String(feature.failureCount), feature.diagnosticCodes.join(', ') || '无 diagnostic'),
      owner,
      priority,
      strategy,
    );
    body.append(row);
  }
}

function renderFeatureSummary(features: FeatureSummary[]): void {
  const body = requiredElement<HTMLTableSectionElement>('feature-rows');
  body.replaceChildren();
  for (const feature of features) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.title = `筛选包含 ${feature.feature} 的素材`;
    const filter = (): void => {
      const search = requiredElement<HTMLInputElement>('search');
      search.value = feature.feature;
      search.dispatchEvent(new Event('input'));
      requiredElement('sample-rows').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    row.addEventListener('click', filter);
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') filter();
    });
    const name = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = feature.feature;
    name.append(code);
    const status = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `feature-status feature-status--${feature.status}`;
    badge.textContent = featureStatusLabel(feature.status);
    status.append(badge);
    row.append(
      name,
      status,
      metricCell(`${feature.sampleCount} / ${feature.occurrenceCount}`, 'samples / occurrences'),
      metricCell(String(feature.affectedSampleCount), `${feature.unsupportedSampleCount} unsupported`),
      metricCell(String(feature.failureCount), feature.diagnosticCodes.join(', ') || '无'),
      metricCell(percent(feature.cleanSampleRatio, 0), '按素材'),
      metricCell(percent(feature.averageFidelity, 2), `loss ${percent(feature.observedFidelityLoss, 2)}`),
    );
    body.append(row);
  }
}

function renderScatter(samples: CorpusSample[]): void {
  const svg = requiredElement<SVGSVGElement>('scatter');
  svg.replaceChildren();
  const width = 760;
  const height = 280;
  const margin = { left: 50, right: 20, top: 18, bottom: 42 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const ratios = samples.map(sample => sample.hya.gzipSizeRatio).filter(isNumber);
  const maxRatio = Math.max(1, ...ratios) * 1.05;
  const x = (value: number): number => margin.left + Math.min(value, maxRatio) / maxRatio * chartWidth;
  const y = (value: number): number => margin.top + (1 - Math.min(1, Math.max(0, value))) * chartHeight;
  for (let step = 0; step <= 4; step++) {
    const fidelity = step / 4;
    svg.append(svgElement('line', { x1: margin.left, x2: width - margin.right, y1: y(fidelity), y2: y(fidelity), class: 'chart-grid' }));
    const label = svgElement('text', { x: margin.left - 10, y: y(fidelity) + 4, class: 'chart-label', 'text-anchor': 'end' });
    label.textContent = `${Math.round(fidelity * 100)}%`;
    svg.append(label);
  }
  for (let step = 0; step <= 4; step++) {
    const ratio = maxRatio * step / 4;
    const label = svgElement('text', { x: x(ratio), y: height - 15, class: 'chart-label', 'text-anchor': 'middle' });
    label.textContent = `${Math.round(ratio * 100)}%`;
    svg.append(label);
  }
  const axis = svgElement('text', { x: width / 2, y: height - 1, class: 'chart-axis', 'text-anchor': 'middle' });
  axis.textContent = 'HYA / Lottie gzip 体积（越左越小）';
  svg.append(axis);
  for (const sample of samples) {
    if (!isNumber(sample.hya.gzipSizeRatio) || !isNumber(sample.fidelity?.score)) continue;
    const dot = svgElement('circle', {
      cx: x(sample.hya.gzipSizeRatio),
      cy: y(sample.fidelity.score),
      r: sample.expectation === 'supported' ? 6 : 5,
      class: `chart-dot chart-dot--${sample.expectation}`,
      tabindex: 0,
    });
    const title = svgElement('title', {});
    title.textContent = `${sample.title}\nFidelity ${percent(sample.fidelity.score, 2)}\ngzip ratio ${percent(sample.hya.gzipSizeRatio, 1)}`;
    dot.append(title);
    dot.addEventListener('click', () => showDetail(sample));
    svg.append(dot);
  }
  if (samples.every(sample => sample.fidelity === null)) {
    const empty = svgElement('text', { x: width / 2, y: height / 2, class: 'chart-empty', 'text-anchor': 'middle' });
    empty.textContent = '当前报告未执行 WebGPU fidelity 测量';
    svg.append(empty);
  }
}

function renderTable(samples: CorpusSample[]): void {
  const body = requiredElement<HTMLTableSectionElement>('sample-rows');
  body.replaceChildren();
  for (const sample of samples) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.title = '查看完整指标与转换诊断';
    row.addEventListener('click', () => showDetail(sample));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') showDetail(sample);
    });

    const asset = document.createElement('td');
    const assetCell = document.createElement('div');
    assetCell.className = 'asset-cell';
    const image = document.createElement('img');
    image.src = resolveReportAssetUrl(sample.frames[0]?.referenceUrl ?? '');
    image.alt = `${sample.title} reference`;
    image.loading = 'lazy';
    const identity = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = sample.title;
    const code = document.createElement('code');
    code.textContent = `${sample.sizeClass ?? 'small'} · ${sample.id}`;
    identity.append(strong, code);
    assetCell.append(image, identity);
    asset.append(assetCell);

    const status = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status-badge status-badge--${sample.expectation}`;
    badge.textContent = expectationLabel(sample.expectation);
    status.append(badge);

    row.append(
      asset,
      status,
      metricCell(sample.fidelity ? percent(sample.fidelity.score, 2) : '—', sample.fidelity ? `min ${percent(sample.fidelity.minimumFrameScore, 2)}` : '未测'),
      metricCell(percent(sample.hya.gzipSizeRatio, 1), `${bytes(sample.source.gzipBytes)} → ${bytes(sample.hya.gzipBytes)}`),
      metricCell(`${format(sample.parse.speedup, 2)}×`, `${format(sample.parse.hyaToRuntime.medianMs, 3)} ms HYA`),
      metricCell(
        milliseconds(sample.firstFrame?.totalMs ?? null),
        sample.delivery
          ? `net ${milliseconds(sample.delivery.hya.network.totalMs)} · body ${milliseconds(sample.delivery.hya.network.bodyDownloadMs)}`
          : sample.firstFrame ? `${sample.firstFrame.visualCount} visuals` : '未测',
      ),
      metricCell(percent(sample.conversion.layerCoverage, 0), `${sample.featureAnalysis.failedFeatureCount} failed features`),
    );
    body.append(row);
  }
  if (samples.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'empty-row';
    cell.textContent = '没有匹配当前筛选条件的素材。';
    row.append(cell);
    body.append(row);
  }
}

function showDetail(sample: CorpusSample): void {
  const dialog = requiredElement<HTMLDialogElement>('sample-detail');
  requiredElement('detail-title').textContent = sample.title;
  requiredElement('detail-id').textContent = sample.id;
  const metrics = requiredElement('detail-metrics');
  metrics.replaceChildren(
    detailMetric('Fidelity', sample.fidelity ? percent(sample.fidelity.score, 3) : '未测'),
    detailMetric('gzip ratio', percent(sample.hya.gzipSizeRatio, 2)),
    detailMetric('Parse speedup', `${format(sample.parse.speedup, 2)}×`),
    detailMetric('First frame', milliseconds(sample.firstFrame?.totalMs ?? null)),
    detailMetric('Source HTTP', milliseconds(sample.delivery?.source.network.totalMs ?? null)),
    detailMetric('Source JSON parse', milliseconds(sample.delivery?.source.jsonParseMs ?? null)),
    detailMetric('HYA headers', milliseconds(sample.delivery?.hya.network.requestToHeadersMs ?? null)),
    detailMetric('HYA stream body', milliseconds(sample.delivery?.hya.network.bodyDownloadMs ?? null)),
    detailMetric(
      'HYA HTTP bytes',
      sample.delivery
        ? `${bytes(sample.delivery.hya.network.bytes)} / ${sample.delivery.hya.network.chunkCount} chunks`
        : '未测',
    ),
    detailMetric('HYA runtime + GPU', milliseconds(sample.firstFrame?.runtimeAndGpuMs ?? null)),
    detailMetric('Layer coverage', percent(sample.conversion.layerCoverage, 1)),
    detailMetric('Nodes / tracks', `${sample.conversion.nodeCount} / ${sample.conversion.trackCount}`),
  );
  const frames = requiredElement('detail-frames');
  frames.replaceChildren();
  for (const frame of sample.frames) {
    const card = document.createElement('figure');
    const image = document.createElement('img');
    image.src = resolveReportAssetUrl(frame.referenceUrl);
    image.alt = `${sample.title} frame ${frame.frame}`;
    const caption = document.createElement('figcaption');
    caption.textContent = `f${frame.frame} · ${frame.metrics ? percent(frame.metrics.score, 3) : '未测'}`;
    card.append(image, caption);
    frames.append(card);
  }
  const featureFailures = requiredElement('detail-feature-failures');
  featureFailures.replaceChildren();
  const failedFeatures = sample.featureAnalysis.features.filter(feature => feature.failureCount > 0);
  if (failedFeatures.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'feature-failure-empty';
    empty.textContent = '未检测到特性级转换失败。';
    featureFailures.append(empty);
  } else {
    for (const feature of failedFeatures) {
      const card = document.createElement('article');
      card.className = `feature-failure feature-failure--${feature.status}`;
      const head = document.createElement('div');
      const name = document.createElement('code');
      name.textContent = feature.feature;
      const badge = document.createElement('span');
      badge.className = `feature-status feature-status--${feature.status}`;
      badge.textContent = `${featureStatusLabel(feature.status)} · ${feature.failureCount}`;
      head.append(name, badge);
      const list = document.createElement('ul');
      for (const failure of feature.failures) {
        const item = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = failure.code;
        item.append(code, document.createTextNode(` [${failure.impact}] ${failure.message} · ${failure.path}`));
        list.append(item);
      }
      card.append(head, list);
      featureFailures.append(card);
    }
  }
  const diagnostics = requiredElement('detail-diagnostics');
  diagnostics.replaceChildren();
  if (sample.conversion.diagnostics.length === 0) {
    const item = document.createElement('li');
    item.textContent = '无转换诊断。';
    diagnostics.append(item);
  } else {
    for (const diagnostic of sample.conversion.diagnostics) {
      const item = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = diagnostic.code;
      item.append(code, document.createTextNode(` ${diagnostic.message} · ${diagnostic.path}`));
      diagnostics.append(item);
    }
  }
  const source = requiredElement<HTMLAnchorElement>('detail-source');
  source.href = sample.source.url;
  if (!dialog.open) dialog.showModal();
}

function metricCell(value: string, note: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  const primary = document.createElement('span');
  primary.className = 'table-metric';
  primary.textContent = value;
  const secondary = document.createElement('small');
  secondary.textContent = note;
  cell.append(primary, secondary);
  return cell;
}

function detailMetric(label: string, value: string): HTMLElement {
  const item = document.createElement('div');
  const term = document.createElement('span');
  term.textContent = label;
  const data = document.createElement('strong');
  data.textContent = value;
  item.append(term, data);
  return item;
}

/**
 * Formal reports store repository-root asset paths so browser gates can serve
 * them from `/`. VS Code Live Preview commonly mounts this repository below a
 * workspace prefix (for example `/_AI/GameEngine/`), so resolve local report
 * assets relative to the dashboard's known two-level location instead of the
 * HTTP origin. Absolute upstream reference URLs remain unchanged.
 */
function resolveReportAssetUrl(url: string): string {
  if (!url.startsWith('/') || url.startsWith('//')) return url;
  return new URL(`../../${url.slice(1)}`, window.location.href).href;
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function downloadJson(report: CorpusReport): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `hya-lottie-corpus-${report.generatedAt.slice(0, 10)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function expectationLabel(value: CorpusSample['expectation']): string {
  return value === 'supported' ? '目标支持' : value === 'degraded' ? '能力降级' : '待支持';
}

function featureStatusLabel(value: FeatureSupportStatus): string {
  return value === 'full' ? '完整' : value === 'partial' ? '部分降级' : '不支持';
}

function browserLabel(adapter: Record<string, unknown> | null): string {
  const description = adapter?.description;
  return typeof description === 'string' && description.length > 0 ? description : 'WebGPU browser';
}

function percent(value: number | null | undefined, digits: number): string {
  return isNumber(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function milliseconds(value: number | null): string {
  return isNumber(value) ? `${value.toFixed(value < 10 ? 2 : 1)} ms` : '—';
}

function bytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} kB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function format(value: number | null | undefined, digits: number): string {
  return isNumber(value) ? value.toFixed(digits) : '—';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function emptySummary(): CorpusSummary {
  return {
    sampleCount: 0,
    referenceFrameCount: 0,
    cleanConversionCount: 0,
    failedFeatureSampleCount: 0,
    unclassifiedFailureCount: 0,
    totalLottieBytes: 0,
    totalHyaBytes: 0,
    totalLottieGzipBytes: 0,
    totalHyaGzipBytes: 0,
    rawByteSaving: null,
    gzipByteSaving: null,
    medianFidelity: null,
    minimumFidelity: null,
    medianParseSpeedup: 0,
    firstFrameP50Ms: null,
    firstFrameP95Ms: null,
    networkP50Ms: null,
    networkP95Ms: null,
    downloadP50Ms: null,
    downloadP95Ms: null,
  };
}

function requiredElement<T extends Element = HTMLElement>(id: string): T {
  const element = document.querySelector<T>(`#${CSS.escape(id)}`);
  if (!element) throw new Error(`Missing #${id}.`);
  return element;
}

function requiredDescendant(parent: HTMLElement, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector} within #${parent.id}.`);
  return element;
}
