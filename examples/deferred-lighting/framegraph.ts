import { createFrameGraphInspector, type FrameGraphSnapshot } from '@haiyue/engine/experimental/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bytes = (value: number) => `${(value / 1048576).toFixed(2)} MiB`;
function table(parent: HTMLElement, headers: string[], rows: (string | number)[][]) {
  const element = document.createElement('table');
  const head = element.createTHead().insertRow();
  for (const value of headers) { const cell = document.createElement('th'); cell.textContent = value; head.append(cell); }
  for (const values of rows) { const row = element.insertRow(); for (const value of values) row.insertCell().textContent = String(value); }
  const scroll = document.createElement('div'); scroll.className = 'fg-scroll'; scroll.append(element); parent.append(scroll);
}
function heading(parent: HTMLElement, text: string) { const h = document.createElement('h3'); h.textContent = text; parent.append(h); }
function bar(parent: HTMLElement, name: string, first: number, last: number, end: number) {
  const row = document.createElement('div'); row.className = 'fg-lifetime';
  const label = document.createElement('span'); label.textContent = `${name} [${first}, ${last}]`;
  const track = document.createElement('div'); track.className = 'fg-track';
  const span = document.createElement('i'); span.style.marginLeft = `${first / end * 100}%`; span.style.width = `${(last - first + 1) / end * 100}%`;
  track.append(span); row.append(label, track); parent.append(row);
}

/** The panel renders only on an explicit capture or graph selection, never every frame. */
export function mountFrameGraphPanel(system: Parameters<typeof createFrameGraphInspector>[0], signal: AbortSignal) {
  const inspector = createFrameGraphInspector(system);
  let pending = false, snapshot: FrameGraphSnapshot | null = null;
  const urls = new Set<string>();
  const select = $<HTMLSelectElement>('fg-plan');
  const json = $<HTMLButtonElement>('fg-json'), png = $<HTMLButtonElement>('fg-png');
  function detail() {
    const area = $('fg-detail'); area.replaceChildren();
    const plan = snapshot?.plans[Number(select.value)]; if (!plan) return;
    heading(area, '逻辑依赖：保留 / 裁剪');
    table(area, ['节点', '状态 / 原因', '读', '写', '依赖节点'], plan.nodes.map(n => [n.name, `${n.live ? '保留' : '裁剪'} · ${n.reason}`, n.reads.join(', ') || '—', n.writes.join(', ') || '—', n.dependsOn.join(', ') || '—']));
    heading(area, '逻辑生命周期 · 本图局部步骤，端点包含');
    const end = Math.max(1, ...plan.lifetimes.map(r => r.lastUse + 1));
    for (const r of plan.lifetimes) bar(area, `${r.name}${r.observable ? ' · 可观察' : ''}`, r.firstUse, r.lastUse, end);
  }
  function render() {
    select.replaceChildren(); const resources = $('fg-resources'); resources.replaceChildren();
    json.disabled = png.disabled = !snapshot;
    if (!snapshot) { $('fg-summary').textContent = pending ? '等待所选系统的下一帧…' : '尚未捕获。选择效果与渲染路径，再点击「捕获下一帧」。'; detail(); return; }
    const s = snapshot, w = s.work;
    $('fg-summary').textContent = `冻结帧 #${s.frame} · ${s.status} · ${s.plans.length} 个局部图；实际编码：render ${w.renderPasses} / compute ${w.computePasses} / draw ${w.drawCalls} / dispatch ${w.dispatchCalls} / copy ${w.copies} / resolve ${w.resolves} / submit ${w.submissions ?? '不可观测'}；bundle ${w.bundleExecutions}（内部 draw ${w.bundledDraws ?? '不可观测'}）。元数据复制 ${s.overhead.metadataCopyMs.toFixed(3)} ms（仅部分观测 CPU 开销）；额外 GPU pass / 读回 / 保留字节均为 0。${s.truncated ? ' 数据超过上限，已截断。' : ''}${s.error ? ` 失败：${s.error}` : ''}`;
    s.plans.forEach((plan, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = `#${plan.id} ${plan.domain} · ${plan.view ?? '全局'} · ${plan.nodes.filter(n => !n.live).length} 裁剪`; select.append(option); });
    // Show the graph that explains culling; otherwise prefer actual postprocessing.
    const culled = s.plans.findIndex(p => p.nodes.some(n => !n.live));
    const preferred = culled >= 0 ? culled : s.plans.findIndex(p => p.domain === 'postprocess'); select.value = String(preferred < 0 ? 0 : preferred); detail();
    heading(resources, '逻辑 → 物理纹理 · 区间仅在同一分配批次内可比较');
    for (const a of s.allocations) {
      heading(resources, `批次 ${a.id} / 池 ${a.pool} · ${a.owner} · ${a.view ?? '全局'}`);
      table(resources, ['逻辑资源', '物理 ID（池内）', '估算字节', '区间', '复用 / 拒绝原因', '描述符'], a.mappings.map(m => [m.name, `${a.pool}:${m.physicalId}`, bytes(m.bytes), `[${m.firstUse}, ${m.lastUse}]`, m.decision, m.descriptor]));
      const end = Math.max(1, ...a.mappings.map(m => m.lastUse + 1));
      for (const m of a.mappings) bar(resources, `${m.name} → ${a.pool}:${m.physicalId}`, m.firstUse, m.lastUse, end);
    }
    heading(resources, '参与捕获的临时池 · record 结束时采样，非整台 GPU 驻留显存');
    table(resources, ['池 / 所有者', '当前物理 / 高水位', 'pending / 高水位', 'active / idle', '累计分配 / 复用'], s.pools.map(p => { const c = p.counters; return [`${p.id} / ${p.owner}`, `${bytes(c.physicalBytes ?? 0)} / ${bytes(c.peakBytes ?? 0)}`, `${bytes(c.pendingBytes ?? 0)} / ${bytes(c.pendingPeakBytes ?? 0)}`, `${bytes(c.activeBytes ?? 0)} / ${bytes(c.idleBytes ?? 0)}`, `${c.allocations} / ${c.reuses}`]; }));
    heading(resources, '缓存 · 累计命中 / 未命中 / 淘汰 / 失效及本次结果');
    table(resources, ['范围', 'hit / miss / eviction / invalidation', '条目数', '本次结果 / 最近失效原因'], [...s.plans.map(p => ({ name: `图 ${p.id} ${p.domain}`, cache: p.cache })), ...s.allocations.map(a => ({ name: `批次 ${a.id} ${a.owner}`, cache: a.cache }))].map(({ name, cache: c }) => [name, `${c.hits} / ${c.misses} / ${c.evictions} / ${c.invalidations}`, c.size, `${c.lastReason} / ${c.lastInvalidationReason}`]));
  }
  function request() { inspector.clear(); snapshot = null; pending = true; inspector.requestCapture(); render(); }
  function clear() { inspector.clear(); pending = false; snapshot = null; render(); }
  function download(blob: Blob, extension: string) {
    if (signal.aborted) return;
    const url = URL.createObjectURL(blob); urls.add(url);
    const link = document.createElement('a'); link.href = url; link.download = `framegraph-${snapshot?.frame ?? 0}.${extension}`; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 0);
  }
  $('fg-capture').addEventListener('click', request, { signal });
  $('fg-clear').addEventListener('click', clear, { signal });
  select.addEventListener('change', detail, { signal });
  json.addEventListener('click', () => { if (snapshot) download(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }), 'json'); }, { signal });
  png.addEventListener('click', () => {
    if (!snapshot) return;
    // A diagram of already captured metadata; never reads the scene canvas or GPU textures.
    const plan = snapshot.plans[Number(select.value)]; if (!plan) return;
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 110 + plan.nodes.length * 58;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#0b101a'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.font = '16px system-ui'; ctx.fillStyle = '#e0e9f5';
    ctx.fillText(`FrameGraph #${snapshot.frame} · ${plan.domain} · ${plan.view ?? 'global'}`, 24, 32);
    ctx.fillText('Logical nodes, not GPU passes. Exported from frozen metadata; no GPU readback.', 24, 62);
    plan.nodes.forEach((n, i) => { const y = 95 + i * 58; ctx.fillStyle = n.live ? '#59ddd0' : '#ffcb83'; ctx.fillText(`${n.live ? 'LIVE' : 'CULLED'} ${n.name} · ${n.reason}`, 24, y); ctx.fillStyle = '#9baec7'; ctx.fillText(`depends on: ${n.dependsOn.join(', ') || '—'}`, 40, y + 23); });
    canvas.toBlob(blob => { if (blob) download(blob, 'png'); });
  }, { signal });
  render();
  return { request, clear, snapshot: () => snapshot, afterFrame() { if (!pending) return; const captured = inspector.snapshot(); if (captured) { snapshot = captured; pending = false; render(); } }, dispose() { pending = false; snapshot = null; inspector.dispose(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); } };
}
