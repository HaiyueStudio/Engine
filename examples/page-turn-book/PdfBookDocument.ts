import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type OnProgressParameters,
} from 'pdfjs-dist';
import type { PageTextureProvider } from './PageTurnBook';

const PAGE_TEXTURE_WIDTH = 768;
const PAGE_TEXTURE_HEIGHT = 1024;

export interface PdfBookDocumentOptions {
  onLoadProgress?(loaded: number, total: number | null): void;
  onCacheChange?(residentPages: readonly number[]): void;
}

/**
 * PDF.js-backed texture provider with an explicit retained-page window.
 * PDF pages are one-based in the UI and zero-based internally.
 */
export class PdfBookDocument implements PageTextureProvider {
  readonly placeholder = createPlaceholderTexture();
  readonly pageCount: number;

  private readonly cached = new Map<number, HTMLCanvasElement>();
  private readonly pending = new Map<number, Promise<HTMLCanvasElement>>();
  private retained = new Set<number>();
  private disposed = false;

  private constructor(
    private readonly loadingTask: PDFDocumentLoadingTask,
    private readonly pdf: PDFDocumentProxy,
    private readonly options: PdfBookDocumentOptions,
  ) {
    this.pageCount = pdf.numPages;
  }

  static async open(
    source: string | Blob,
    options: PdfBookDocumentOptions = {},
  ): Promise<PdfBookDocument> {
    GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', window.location.href).href;
    const request = typeof source === 'string'
      ? { url: source }
      : { data: new Uint8Array(await source.arrayBuffer()) };
    const loadingTask = getDocument(request);
    loadingTask.onProgress = (progress: OnProgressParameters) => {
      options.onLoadProgress?.(progress.loaded, progress.total || null);
    };
    const pdf = await loadingTask.promise;
    return new PdfBookDocument(loadingTask, pdf, options);
  }

  get residentPageCount(): number {
    return this.cached.size;
  }

  get residentPages(): readonly number[] {
    return [...this.cached.keys()].sort((a, b) => a - b);
  }

  retainPages(pageIndices: ReadonlySet<number>): void {
    this.assertUsable();
    const next = new Set<number>();
    for (const pageIndex of pageIndices) {
      if (pageIndex >= 0 && pageIndex < this.pageCount) next.add(pageIndex);
    }
    this.retained = next;
    for (const [pageIndex, texture] of this.cached) {
      if (next.has(pageIndex)) continue;
      this.cached.delete(pageIndex);
      releaseCanvas(texture);
    }
    this.emitCacheChange();
  }

  getPageTexture(pageIndex: number): Promise<HTMLCanvasElement> {
    this.assertUsable();
    if (pageIndex < 0 || pageIndex >= this.pageCount) {
      return Promise.resolve(this.placeholder);
    }
    const cached = this.cached.get(pageIndex);
    if (cached) return Promise.resolve(cached);
    const pending = this.pending.get(pageIndex);
    if (pending) return pending;
    const request = this.renderPage(pageIndex).finally(() => {
      this.pending.delete(pageIndex);
    });
    this.pending.set(pageIndex, request);
    return request;
  }

  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.retained.clear();
    for (const texture of this.cached.values()) releaseCanvas(texture);
    this.cached.clear();
    releaseCanvas(this.placeholder);
    await this.loadingTask.destroy();
  }

  private async renderPage(pageIndex: number): Promise<HTMLCanvasElement> {
    const page = await this.pdf.getPage(pageIndex + 1);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const scale = Math.min(
        PAGE_TEXTURE_WIDTH / viewport.width,
        PAGE_TEXTURE_HEIGHT / viewport.height,
      );
      const scaledViewport = page.getViewport({ scale });
      const offsetX = (PAGE_TEXTURE_WIDTH - scaledViewport.width) / 2;
      const offsetY = (PAGE_TEXTURE_HEIGHT - scaledViewport.height) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = PAGE_TEXTURE_WIDTH;
      canvas.height = PAGE_TEXTURE_HEIGHT;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error(`PDF page ${pageIndex + 1} requires a 2D canvas context.`);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvas: null,
        canvasContext: context,
        viewport: scaledViewport,
        transform: [1, 0, 0, 1, offsetX, offsetY],
        background: '#ffffff',
      }).promise;

      if (this.disposed || !this.retained.has(pageIndex)) {
        releaseCanvas(canvas);
        return this.placeholder;
      }
      this.cached.set(pageIndex, canvas);
      this.emitCacheChange();
      return canvas;
    } finally {
      page.cleanup();
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('The PDF book document has been disposed.');
  }

  private emitCacheChange(): void {
    this.options.onCacheChange?.(this.residentPages);
  }
}

function createPlaceholderTexture(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.fillStyle = '#f4ecd9';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 1;
  canvas.height = 1;
}
