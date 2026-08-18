import { EngineError, EngineErrorCode } from './EngineError';
import type {
  RenderCapabilities,
  RenderCapabilityDecision,
} from './RenderProfile';

export const WebGpuCompatibilityStatus = {
  Supported: 'supported',
  Unsupported: 'unsupported',
  AdapterUnavailable: 'adapter-unavailable',
  ContextUnavailable: 'context-unavailable',
  OptionalFeatureDegraded: 'optional-feature-degraded',
} as const;

export type WebGpuCompatibilityStatus =
  typeof WebGpuCompatibilityStatus[keyof typeof WebGpuCompatibilityStatus];

export interface WebGpuCompatibilityDegradation {
  readonly feature: string;
  readonly fallback: string | null;
  readonly reason: string;
}

export interface WebGpuCompatibilityReport {
  readonly api: 'webgpu';
  readonly status: WebGpuCompatibilityStatus;
  readonly fatal: boolean;
  readonly code:
    | typeof EngineErrorCode.WebGpuUnsupported
    | typeof EngineErrorCode.WebGpuAdapterUnavailable
    | typeof EngineErrorCode.WebGpuContextUnavailable
    | null;
  readonly title: string;
  readonly message: string;
  readonly action: string;
  readonly docsPath: string | null;
  readonly degradations: readonly WebGpuCompatibilityDegradation[];
}

export interface WebGpuCompatibilityPageOptions {
  readonly productName?: string;
}

const NO_DEGRADATIONS: readonly WebGpuCompatibilityDegradation[] = Object.freeze([]);

const SUPPORTED_REPORT = report({
  status: WebGpuCompatibilityStatus.Supported,
  fatal: false,
  code: null,
  title: 'WebGPU is ready',
  message: 'This runtime is using its required WebGPU rendering path.',
  action: '',
  docsPath: null,
});

const FATAL_REPORTS = Object.freeze({
  [WebGpuCompatibilityStatus.Unsupported]: report({
    status: WebGpuCompatibilityStatus.Unsupported,
    fatal: true,
    code: EngineErrorCode.WebGpuUnsupported,
    title: 'WebGPU is not supported',
    message: 'This runtime requires WebGPU and does not provide a WebGL fallback.',
    action: 'Use a current browser with WebGPU enabled, then reload this page.',
    docsPath: 'errors/E_WEBGPU_UNSUPPORTED',
  }),
  [WebGpuCompatibilityStatus.AdapterUnavailable]: report({
    status: WebGpuCompatibilityStatus.AdapterUnavailable,
    fatal: true,
    code: EngineErrorCode.WebGpuAdapterUnavailable,
    title: 'No WebGPU adapter is available',
    message: 'The browser exposes WebGPU, but it could not acquire a suitable GPU adapter.',
    action: 'Enable hardware acceleration, update the GPU driver, and reload this page.',
    docsPath: 'errors/E_WEBGPU_ADAPTER_UNAVAILABLE',
  }),
  [WebGpuCompatibilityStatus.ContextUnavailable]: report({
    status: WebGpuCompatibilityStatus.ContextUnavailable,
    fatal: true,
    code: EngineErrorCode.WebGpuContextUnavailable,
    title: 'The WebGPU canvas context is unavailable',
    message: 'A GPU adapter was acquired, but the target canvas could not create a WebGPU context.',
    action: 'Check the canvas target and browser WebGPU policy, then reload this page.',
    docsPath: 'errors/E_WEBGPU_CONTEXT_UNAVAILABLE',
  }),
});

export function getWebGpuCompatibilityReport(
  capabilities?: RenderCapabilities | null,
): WebGpuCompatibilityReport {
  if (!capabilities?.report.degraded) return SUPPORTED_REPORT;
  return createWebGpuDegradedReport(
    capabilities.report.decisions
      .filter(decision => decision.requested && !decision.enabled)
      .map(capabilityDegradation),
  );
}

export function createWebGpuDegradedReport(
  degradations: readonly WebGpuCompatibilityDegradation[],
): WebGpuCompatibilityReport {
  const normalized = Object.freeze(degradations.map(degradation => Object.freeze({
    feature: degradation.feature,
    fallback: degradation.fallback,
    reason: degradation.reason,
  })));
  if (normalized.length === 0) return SUPPORTED_REPORT;
  return report({
    status: WebGpuCompatibilityStatus.OptionalFeatureDegraded,
    fatal: false,
    code: null,
    title: 'Running with reduced graphics features',
    message: 'Required WebGPU support is available. Optional features were replaced by supported fallbacks.',
    action: 'The runtime can continue; visual quality, diagnostics, or performance may be reduced.',
    docsPath: null,
    degradations: normalized,
  });
}

export function classifyWebGpuCompatibilityError(
  error: unknown,
): WebGpuCompatibilityReport | null {
  if (!(error instanceof EngineError)) return null;
  switch (error.code) {
    case EngineErrorCode.WebGpuUnsupported:
      return FATAL_REPORTS[WebGpuCompatibilityStatus.Unsupported];
    case EngineErrorCode.WebGpuAdapterUnavailable:
      return FATAL_REPORTS[WebGpuCompatibilityStatus.AdapterUnavailable];
    case EngineErrorCode.WebGpuContextUnavailable:
      return FATAL_REPORTS[WebGpuCompatibilityStatus.ContextUnavailable];
    default:
      return null;
  }
}

export function createWebGpuCompatibilityError(
  status:
    | typeof WebGpuCompatibilityStatus.Unsupported
    | typeof WebGpuCompatibilityStatus.AdapterUnavailable
    | typeof WebGpuCompatibilityStatus.ContextUnavailable,
  cause?: unknown,
): EngineError {
  const compatibility = FATAL_REPORTS[status];
  return new EngineError(compatibility.code!, compatibility.message, {
    hint: compatibility.action,
    ...(compatibility.docsPath === null ? {} : { docsPath: compatibility.docsPath }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export function renderWebGpuCompatibilityPage(
  container: HTMLElement,
  compatibility: WebGpuCompatibilityReport,
  options: WebGpuCompatibilityPageOptions = {},
): void {
  container.replaceChildren();
  resetContainerStyles(container);
  container.dataset.webgpuCompatibility = compatibility.status;
  if (compatibility.status === WebGpuCompatibilityStatus.Supported) {
    container.style.display = 'none';
    container.removeAttribute('role');
    container.removeAttribute('aria-live');
    return;
  }

  const document = container.ownerDocument;
  const panel = document.createElement('section');
  const eyebrow = document.createElement('div');
  const title = document.createElement('h1');
  const message = document.createElement('p');
  const action = document.createElement('p');
  const productName = options.productName?.trim() || 'Haiyue runtime';
  eyebrow.textContent = `${productName} · WebGPU only`;
  title.textContent = compatibility.title;
  message.textContent = compatibility.message;
  action.textContent = compatibility.action;

  applyStyles(container, compatibility.fatal ? FATAL_CONTAINER_STYLES : DEGRADED_CONTAINER_STYLES);
  applyStyles(panel, PANEL_STYLES);
  applyStyles(eyebrow, EYEBROW_STYLES);
  applyStyles(title, TITLE_STYLES);
  applyStyles(message, TEXT_STYLES);
  applyStyles(action, ACTION_STYLES);
  container.setAttribute('role', compatibility.fatal ? 'alert' : 'status');
  container.setAttribute('aria-live', compatibility.fatal ? 'assertive' : 'polite');
  panel.append(eyebrow, title, message);

  if (compatibility.degradations.length > 0) {
    const list = document.createElement('ul');
    applyStyles(list, LIST_STYLES);
    for (const degradation of compatibility.degradations) {
      const item = document.createElement('li');
      item.textContent = degradation.fallback
        ? `${degradation.feature}: ${degradation.reason} Fallback: ${degradation.fallback}.`
        : `${degradation.feature}: ${degradation.reason}`;
      list.append(item);
    }
    panel.append(list);
  }
  panel.append(action);

  if (compatibility.code) {
    const code = document.createElement('code');
    code.textContent = compatibility.code;
    applyStyles(code, CODE_STYLES);
    panel.append(code);
  }
  container.append(panel);
}

export const WebGpuCompatibility = Object.freeze({
  Status: WebGpuCompatibilityStatus,
  classifyError: classifyWebGpuCompatibilityError,
  createError: createWebGpuCompatibilityError,
  degraded: createWebGpuDegradedReport,
  report: getWebGpuCompatibilityReport,
  renderPage: renderWebGpuCompatibilityPage,
});

function capabilityDegradation(
  decision: RenderCapabilityDecision,
): WebGpuCompatibilityDegradation {
  return {
    feature: decision.capability,
    fallback: decision.fallback,
    reason: decision.reason,
  };
}

function report(
  input: Omit<WebGpuCompatibilityReport, 'api' | 'degradations'> & {
    degradations?: readonly WebGpuCompatibilityDegradation[];
  },
): WebGpuCompatibilityReport {
  return Object.freeze({
    api: 'webgpu',
    ...input,
    degradations: input.degradations ?? NO_DEGRADATIONS,
  });
}

function applyStyles(element: HTMLElement, styles: Readonly<Record<string, string>>): void {
  Object.assign(element.style, styles);
}

function resetContainerStyles(container: HTMLElement): void {
  for (const property of COMPATIBILITY_CONTAINER_STYLE_PROPERTIES) {
    container.style.removeProperty(property);
  }
}

const FATAL_CONTAINER_STYLES = Object.freeze({
  display: 'grid',
  position: 'absolute',
  inset: '0',
  placeItems: 'center',
  boxSizing: 'border-box',
  padding: '24px',
  color: '#e6edf7',
  background: 'rgba(5, 8, 14, 0.96)',
  zIndex: '1000',
});

const DEGRADED_CONTAINER_STYLES = Object.freeze({
  display: 'block',
  position: 'absolute',
  left: '16px',
  right: '16px',
  bottom: '16px',
  maxWidth: '620px',
  color: '#fff4cf',
  background: 'transparent',
  zIndex: '1000',
  pointerEvents: 'none',
});

const COMPATIBILITY_CONTAINER_STYLE_PROPERTIES = Object.freeze([
  ...new Set(
    [...Object.keys(FATAL_CONTAINER_STYLES), ...Object.keys(DEGRADED_CONTAINER_STYLES)]
      .map(property => property.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)),
  ),
]);

const PANEL_STYLES = Object.freeze({
  boxSizing: 'border-box',
  width: 'min(620px, 100%)',
  padding: '20px 22px',
  border: '1px solid rgba(122, 151, 191, 0.38)',
  borderRadius: '10px',
  background: 'rgba(14, 20, 31, 0.96)',
  boxShadow: '0 22px 70px rgba(0, 0, 0, 0.45)',
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
});

const EYEBROW_STYLES = Object.freeze({
  marginBottom: '8px',
  color: '#7fb7ff',
  fontSize: '11px',
  fontWeight: '700',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
});

const TITLE_STYLES = Object.freeze({
  margin: '0 0 10px',
  color: 'inherit',
  fontSize: '22px',
  lineHeight: '1.2',
});

const TEXT_STYLES = Object.freeze({
  margin: '0 0 8px',
  color: 'inherit',
  fontSize: '14px',
  lineHeight: '1.55',
});

const ACTION_STYLES = Object.freeze({
  margin: '12px 0 0',
  color: '#aebbd0',
  fontSize: '13px',
  lineHeight: '1.5',
});

const LIST_STYLES = Object.freeze({
  margin: '12px 0 0',
  paddingLeft: '20px',
  color: '#f1d995',
  fontSize: '12px',
  lineHeight: '1.5',
});

const CODE_STYLES = Object.freeze({
  display: 'inline-block',
  marginTop: '14px',
  padding: '3px 6px',
  borderRadius: '4px',
  color: '#a9cfff',
  background: 'rgba(78, 121, 178, 0.18)',
  fontSize: '11px',
});
