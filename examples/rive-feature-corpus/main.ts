type Status = 'full' | 'partial' | 'missing';
type Kind = 'object' | 'property' | 'asset' | 'script-module' | 'script-symbol';
interface RecordEntry {
  kind: Kind; key: number; name: string; owner?: string; extends?: string; source: string;
  evidenceClass: string; binaryEvidenceEligible: boolean; behavioralEvidenceEligible?: boolean;
  serialized?: boolean; family: string; hyaStatus: Status; goal: string; diagnostic: string;
}
interface FamilySummary { goal: string; status: Status; total: number; full: number; partial: number; missing: number }
interface CorpusSnapshot {
  kind: string; compatibilityTupleId: string; recordCount: number; records: RecordEntry[];
  source: { repository: string; publicCommit: string; riveHead: string; censusSha256: string };
  familySummary: Record<string, FamilySummary>;
}

const KIND_LABELS: Record<Kind, string> = {
  object: 'Runtime object', property: 'Property', asset: 'Asset type',
  'script-module': 'Luau module', 'script-symbol': 'Luau symbol',
};
const STATUS_LABELS: Record<Status, string> = { full: '完整', partial: '部分', missing: '缺失' };

async function main(): Promise<void> {
  const snapshot = await fetch('./corpus.json', { cache: 'no-store' }).then(requireOk).then(response => response.json()) as CorpusSnapshot;
  if (snapshot.kind !== 'haiyue-rive-feature-corpus-snapshot' || snapshot.recordCount !== snapshot.records.length) throw new Error('Rive feature corpus snapshot 无效。');
  const counts = countStatuses(snapshot.records);
  setText('total-count', String(snapshot.recordCount)); setText('full-count', String(counts.full));
  setText('partial-count', String(counts.partial)); setText('missing-count', String(counts.missing));
  setText('source-meta', `${snapshot.compatibilityTupleId} · rive-runtime ${snapshot.source.publicCommit.slice(0, 12)}… · .rive_head ${snapshot.source.riveHead.slice(0, 12)}… · census ${snapshot.source.censusSha256.slice(0, 12)}…`);
  populateSelect(query<HTMLSelectElement>('#kind'), [...new Set(snapshot.records.map(value => value.kind))], value => KIND_LABELS[value as Kind]);
  populateSelect(query<HTMLSelectElement>('#family'), Object.keys(snapshot.familySummary), humanize);
  renderFamilies(snapshot.familySummary);

  for (const selector of ['#search', '#kind', '#family', '#status-filter', '#binary-only']) query(selector).addEventListener('input', render);
  render();
  const result = query<HTMLElement>('#result'); result.dataset.status = 'passed';
  result.textContent = JSON.stringify({ status: 'passed', recordCount: snapshot.recordCount, counts, familyCount: Object.keys(snapshot.familySummary).length });

  function render(): void {
    const search = normalize(query<HTMLInputElement>('#search').value);
    const kind = query<HTMLSelectElement>('#kind').value;
    const family = query<HTMLSelectElement>('#family').value;
    const status = query<HTMLSelectElement>('#status-filter').value;
    const binaryOnly = query<HTMLInputElement>('#binary-only').checked;
    const visible = snapshot.records.filter(value => (
      (kind === 'all' || value.kind === kind)
      && (family === 'all' || value.family === family)
      && (status === 'all' || value.hyaStatus === status)
      && (!binaryOnly || value.binaryEvidenceEligible)
      && (!search || searchable(value).includes(search))
    ));
    setText('visible-count', `${visible.length} / ${snapshot.recordCount}`);
    renderRows(visible);
  }

  function renderFamilies(families: Record<string, FamilySummary>): void {
    const grid = query('#family-grid'); grid.replaceChildren();
    for (const [id, family] of Object.entries(families)) {
      const card = document.createElement('article'); card.className = 'family-card'; card.tabIndex = 0;
      const badge = document.createElement('span'); badge.className = `family-status family-status--${family.status}`; badge.textContent = STATUS_LABELS[family.status];
      const title = document.createElement('h3'); title.textContent = humanize(id); title.append(badge);
      const counts = document.createElement('div'); counts.className = 'family-counts'; counts.textContent = `${family.total} total · ${family.full} full · ${family.partial} partial · ${family.missing} missing`;
      const owner = document.createElement('small'); owner.textContent = family.goal;
      card.append(title, counts, owner);
      const select = (): void => { const field = query<HTMLSelectElement>('#family'); field.value = id; field.dispatchEvent(new Event('input')); query('.corpus-section').scrollIntoView({ behavior: 'smooth' }); };
      card.addEventListener('click', select); card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') select(); });
      grid.append(card);
    }
  }
}

function renderRows(records: RecordEntry[]): void {
  const body = query<HTMLTableSectionElement>('#feature-rows'); body.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const value of records) {
    const row = document.createElement('tr');
    row.append(
      cell(value.name, value.source, 'strong'),
      cell(KIND_LABELS[value.kind], `#${value.key}`),
      cell(humanize(value.family), value.family),
      statusCell(value.hyaStatus),
      cell(value.evidenceClass, `${value.binaryEvidenceEligible ? 'binary' : value.behavioralEvidenceEligible ? 'behavioral' : 'source-only'}${value.serialized === undefined ? '' : value.serialized ? ' · serialized' : ' · source-only'}`, 'code', 'evidence'),
      cell(value.owner ?? value.extends ?? '—', value.goal),
      cell(value.diagnostic, value.goal, 'code'),
    );
    fragment.append(row);
  }
  if (records.length === 0) { const row = document.createElement('tr'); const item = document.createElement('td'); item.colSpan = 7; item.className = 'empty'; item.textContent = '没有符合当前筛选的特性。'; row.append(item); fragment.append(row); }
  body.append(fragment);
}
function cell(primary: string, secondary: string, tag: 'span' | 'strong' | 'code' = 'span', className = ''): HTMLTableCellElement { const item = document.createElement('td'); if (className) item.className = className; const main = document.createElement(tag); main.textContent = primary; const note = document.createElement('small'); note.textContent = secondary; item.append(main, note); return item; }
function statusCell(status: Status): HTMLTableCellElement { const item = document.createElement('td'); const badge = document.createElement('span'); badge.className = `badge badge--${status}`; badge.textContent = STATUS_LABELS[status]; item.append(badge); return item; }
function countStatuses(records: RecordEntry[]): Record<Status, number> { return { full: records.filter(value => value.hyaStatus === 'full').length, partial: records.filter(value => value.hyaStatus === 'partial').length, missing: records.filter(value => value.hyaStatus === 'missing').length }; }
function populateSelect(select: HTMLSelectElement, values: string[], label: (value: string) => string): void { for (const value of values) select.add(new Option(label(value), value)); }
function searchable(value: RecordEntry): string { return normalize([value.name, value.owner, value.extends, value.source, value.evidenceClass, value.family, value.goal, value.diagnostic, value.kind, value.key].filter(item => item !== undefined).join(' ')); }
function normalize(value: unknown): string { return String(value ?? '').trim().toLocaleLowerCase(); }
function humanize(value: string): string { return value.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' '); }
function setText(id: string, value: string): void { query(`#${id}`).textContent = value; }
function requireOk(response: Response): Response { if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`); return response; }
function query<T extends Element = HTMLElement>(selector: string): T { const value = document.querySelector<T>(selector); if (!value) throw new ReferenceError(`Missing ${selector}`); return value; }

void main().catch(error => { const result = document.querySelector<HTMLElement>('#result'); if (result) { result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', error: String(error) }); } console.error(error); });
