import { Entity, HaiyueEngine } from '@haiyue/engine';
import { GuiRoot, GuiLabel } from '@haiyue/engine/gui';
import { I18n } from '@haiyue/extensions/i18n';
import { captureShareImage, prepareShareContent, parseChallengeLink, type ShareImage, type PreparedShareContent } from '@haiyue/extensions/share-content';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
async function main(): Promise<void> {
  const engine = new HaiyueEngine({ canvas: '#canvas', clearColor: { r: 0.06, g: 0.10, b: 0.17, a: 1 } });
  const lifetime = new AbortController();
  const i18n = new I18n({ locale: 'zh-CN', fallbackLocale: 'en' });
  i18n.register({ schemaVersion: 1, locale: 'zh-CN', messages: { title: '专家数独 · 最佳纪录', subtitle: '每一道挑战，都有新的可能。', badge: 'HAIYUE / 每日挑战', time: '完成时间', hints: '使用提示', mistakes: '失误次数', streak: '连续完成', footer: '同题挑战 · 规则 v3 · 演示战绩', share: '我用 {time} 完成专家数独，零提示！来挑战同一道题。' } });
  i18n.register({ schemaVersion: 1, locale: 'en', messages: { title: 'Expert Sudoku · Personal Best', subtitle: 'A new challenge. A new possibility.', badge: 'HAIYUE / DAILY CHALLENGE', time: 'Completion time', hints: 'Hints used', mistakes: 'Mistakes', streak: 'Day streak', footer: 'Same puzzle · Rules v3 · Demo result', share: 'Expert Sudoku in {time}, without hints! Try the same puzzle.' } });
  const sourceSamples: number[] = [];
  let current: AbortController | undefined, revision = 0, objectUrl = '', ready: PreparedShareContent | undefined;
  let shareData: ShareData | undefined, pngBlob: Blob | undefined;
  const fail = (error: unknown) => { if (!lifetime.signal.aborted) get('error').textContent = String(error); };
  window.addEventListener('pagehide', () => {
    lifetime.abort(); current?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); i18n.dispose(); engine.destroy();
  }, { once: true });
  const frameCapture = (signal: AbortSignal): Promise<ShareImage> => new Promise((resolve, reject) => {
    const abort = () => { engine.off('after-update', capture); reject(signal.reason); };
    const capture = () => { signal.removeEventListener('abort', abort); void captureShareImage(engine.canvas!, { signal }).then(resolve, reject); };
    engine.once('after-update', capture); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
  const challenge = { gameId: 'sudoku-demo', rulesVersion: 'v3', mode: 'expert', seed: '104729' };
  const policy = { gameId: challenge.gameId, rulesVersion: challenge.rulesVersion, allowedOrigins: [location.origin] };
  const generate = async (): Promise<PreparedShareContent | undefined> => {
    const id = ++revision; current?.abort(); const run = current = new AbortController();
    ready = undefined; shareData = undefined; get<HTMLButtonElement>('share').disabled = true; get<HTMLButtonElement>('download').disabled = true;
    get('error').textContent = ''; get('status').textContent = '正在生成…';
    let bitmap: ImageBitmap | undefined;
    try {
      const locale = get<HTMLSelectElement>('locale').value;
      await i18n.setLocale(locale, run.signal); await document.fonts.ready; run.signal.throwIfAborted();
      const screenshot = await frameCapture(run.signal);
      bitmap = await createImageBitmap(new Blob([new Uint8Array(screenshot.bytes)], { type: screenshot.mimeType }));
      run.signal.throwIfAborted();
      if (new URLSearchParams(location.search).has('verify')) {
        const probe = document.createElement('canvas'); probe.width = bitmap.width; probe.height = bitmap.height;
        const context = probe.getContext('2d')!; context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
        let bright = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 150 && pixels[i + 1]! > 150 && pixels[i + 2]! > 150) bright++;
        probe.width = 0; probe.height = 0;
        if (bright < 50) throw new Error('GPU screenshot is blank or has no board digits');
        sourceSamples.push(bright);
      }
      const portrait = get<HTMLSelectElement>('layout').value === 'portrait';
      const value = await prepareShareContent({ title: { key: 'title' }, text: { key: 'share', params: { time: '06:32' } },
        challenge: { baseUrl: new URL('./index.html', location.href).href, data: challenge },
        card: { width: portrait ? 900 : 1200, height: portrait ? 1200 : 630, title: { key: 'title' }, subtitle: { key: 'subtitle' }, badge: { key: 'badge' }, footer: { key: 'footer' },
          stats: [{ label: { key: 'time' }, value: '06:32' }, { label: { key: 'hints' }, value: '0' }, { label: { key: 'mistakes' }, value: '0' }, { label: { key: 'streak' }, value: '12' }],
          image: { source: bitmap, width: screenshot.width, height: screenshot.height, fit: 'contain' },
        },
      }, { i18n, signal: run.signal });
      if (id !== revision || lifetime.signal.aborted) return;
      ready = value;
      pngBlob = new Blob([new Uint8Array(value.image.bytes)], { type: value.image.mimeType });
      if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = URL.createObjectURL(pngBlob);
      get<HTMLImageElement>('preview').src = objectUrl;
      get<HTMLTextAreaElement>('copy').value = value.text; get<HTMLTextAreaElement>('link').value = value.url!;
      const parsed = parseChallengeLink(value.url!, policy);
      shareData = { title: value.title, text: value.text, url: value.url!, files: [new File([pngBlob], value.image.filename, { type: value.image.mimeType })] };
      get<HTMLButtonElement>('download').disabled = false;
      get<HTMLButtonElement>('share').disabled = !(typeof navigator.share === 'function' && navigator.canShare?.(shareData));
      get('status').textContent = `${value.image.width} × ${value.image.height} · ${Math.round(value.image.bytes.length / 1024)} KiB PNG\n挑战已解析：${JSON.stringify(parsed)}`;
      return value;
    } catch (error) { if (!run.signal.aborted) fail(error); }
    finally { bitmap?.close(); }
    return;
  };
  try {
    await engine.init(); if (lifetime.signal.aborted) return;
    engine.run(); engine.device.pushErrorScope('validation');
    const scene = engine.createScene({ name: 'share-content', render3D: false, render2D: false, gui: { loadOp: 'clear', font: { chars: '123456789', fontFamily: 'sans-serif', atlasSize: 512 } } });
    const root = new GuiRoot(); scene.add(new Entity('demo-board').addComponent(root));
    const digits = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
    for (let i = 0; i < 81; i++) {
      const row = Math.floor(i / 9), column = i % 9;
      const label = root.add(new GuiLabel({ text: digits[i]!, fontSize: 18, textAlign: 'center', style: { color: '#e4f2ff', backgroundColor: (Math.floor(row / 3) + Math.floor(column / 3)) % 2 ? '#284963' : '#1a334b' } }));
      label.layout = bounds => { const size = Math.min(bounds.width, bounds.height) / 9; label.rect = { x: column * size + 1, y: row * size + 1, width: size - 2, height: size - 2 }; };
    }
    engine.switchScene(scene);
    const input = parseChallengeLink(location.href, policy);
    if (input) get('status').textContent = `收到挑战：${JSON.stringify(input)}`;
    get('generate').addEventListener('click', () => void generate(), { signal: lifetime.signal });
    for (const id of ['locale', 'layout']) get(id).addEventListener('change', () => void generate(), { signal: lifetime.signal });
    get('download').addEventListener('click', () => {
      if (!ready) return; const a = document.createElement('a'); a.href = objectUrl; a.download = ready.image.filename; a.click();
    }, { signal: lifetime.signal });
    get('share').addEventListener('click', () => {
      // Example-owned Web host adapter. Games using Native consume this same ready payload via shareContent(ready).
      if (!shareData) return; void navigator.share(shareData).then(() => { get('status').textContent = '系统分享操作已完成'; }, error => { if (error.name !== 'AbortError') fail(error); });
    }, { signal: lifetime.signal });
    await generate();
    if (new URLSearchParams(location.search).has('verify')) {
      const hashes: string[] = [];
      for (const locale of ['zh-CN', 'en']) for (const layout of ['landscape', 'portrait']) {
        get<HTMLSelectElement>('locale').value = locale; get<HTMLSelectElement>('layout').value = layout;
        const value = await generate(); if (!value) throw new Error('Card generation failed');
        const decoded = await createImageBitmap(new Blob([new Uint8Array(value.image.bytes)], { type: 'image/png' }));
        if (decoded.width !== value.image.width || decoded.height !== value.image.height) throw new Error('PNG dimensions mismatch');
        const probe = document.createElement('canvas'); probe.width = decoded.width; probe.height = decoded.height;
        const context = probe.getContext('2d')!; context.drawImage(decoded, 0, 0); decoded.close();
        const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
        let bright = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 100 && pixels[i + 1]! > 100) bright++;
        if (bright < 1000) throw new Error('Card contains no visible content');
        hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value.image.bytes)))).map(b => b.toString(16).padStart(2, '0')).join(''));
        probe.width = 0; probe.height = 0;
      }
      if (new Set(hashes).size !== 4) throw new Error('Locale/layout outputs did not change');
      const validation = await engine.device.popErrorScope(); if (validation) throw validation;
      get('result').textContent = JSON.stringify({ passed: true, checks: ['GPU canvas capture', 'PNG decode', 'Chinese/English', 'landscape/portrait', 'challenge round trip', 'GPU validation'], sourceSamples, hashes });
    } else { const validation = await engine.device.popErrorScope(); if (validation) throw validation; }
  } catch (error) { fail(error); lifetime.abort(); current?.abort(); engine.destroy(); i18n.dispose(); }
}
void main();
