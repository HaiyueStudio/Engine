export async function loadExampleCatalog({
  fetchImpl = globalThis.fetch,
  manifestUrl = './manifest.json',
} = {}) {
  return (await loadExampleCatalogReport({ fetchImpl, manifestUrl })).catalog;
}

export async function loadExampleCatalogReport({
  fetchImpl = globalThis.fetch,
  manifestUrl = './manifest.json',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Example catalog requires a fetch implementation.');
  const response = await fetchImpl(manifestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load examples manifest (HTTP ${response.status}).`);
  return createExampleCatalogReport(await response.json());
}

export function createExampleCatalog(manifest) {
  return createExampleCatalogReport(manifest).catalog;
}

export function createExampleCatalogReport(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== 'examples' || !Array.isArray(manifest.entries)) {
    throw new Error('Invalid examples manifest header.');
  }
  const groups = manifest.catalog?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('Examples manifest has no catalog groups.');
  }

  const groupById = new Map();
  const entriesByGroup = new Map();
  const groupOrders = new Set();
  for (const group of groups) {
    if (
      !group?.id
      || typeof group.title !== 'string'
      || !group.title.trim()
      || groupById.has(group.id)
      || !Number.isInteger(group.order)
      || group.order < 0
      || groupOrders.has(group.order)
    ) {
      throw new Error(`Invalid or duplicate catalog group: ${group?.id ?? '<missing>'}.`);
    }
    groupById.set(group.id, group);
    groupOrders.add(group.order);
    entriesByGroup.set(group.id, []);
  }

  const entryIds = new Set();
  const entryOrdersByGroup = new Map(groups.map(group => [group.id, new Set()]));
  const diagnostics = [];
  let skippedEntryCount = 0;

  const skipEntry = (entry, code, message) => {
    skippedEntryCount++;
    diagnostics.push(Object.freeze({
      code,
      entryId: typeof entry?.id === 'string' && entry.id ? entry.id : undefined,
      message,
    }));
  };

  for (const entry of manifest.entries) {
    if (
      !entry?.id
      || typeof entry.title !== 'string'
      || !entry.title.trim()
      || !isLocalTypeScriptEntry(entry.entry, entry.id)
    ) {
      const id = entry?.id ?? '<missing>';
      skipEntry(entry, 'invalid-entry', `Skipped example "${id}": invalid title, id, or local TypeScript entry.`);
      continue;
    }
    if (entryIds.has(entry.id)) {
      skipEntry(entry, 'duplicate-entry-id', `Skipped example "${entry.id}": duplicate example id.`);
      continue;
    }

    const catalog = entry.catalog;
    const target = catalog && entriesByGroup.get(catalog.group);
    const orders = catalog && entryOrdersByGroup.get(catalog.group);
    if (!target || !orders) {
      skipEntry(entry, 'unknown-group', `Skipped example "${entry.id}": unknown catalog group "${catalog?.group ?? '<missing>'}".`);
      continue;
    }
    if (!Number.isInteger(catalog.order) || catalog.order < 0) {
      skipEntry(entry, 'invalid-order', `Skipped example "${entry.id}": catalog order must be a non-negative integer.`);
      continue;
    }
    if (orders.has(catalog.order)) {
      skipEntry(
        entry,
        'duplicate-order',
        `Skipped example "${entry.id}": catalog order ${catalog.order} is already used in group "${catalog.group}".`,
      );
      continue;
    }

    entryIds.add(entry.id);
    orders.add(catalog.order);
    target.push(entry);
  }

  const catalog = [...groups]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .filter(group => {
      if (entriesByGroup.get(group.id).length > 0) return true;
      diagnostics.push(Object.freeze({
        code: 'empty-group',
        groupId: group.id,
        message: `Omitted empty example catalog group "${group.id}".`,
      }));
      return false;
    })
    .map(group => ({
      id: `group-${group.id}`,
      label: group.title,
      icon: group.icon,
      expanded: group.expanded !== false,
      children: entriesByGroup.get(group.id)
        .sort((a, b) => a.catalog.order - b.catalog.order || a.id.localeCompare(b.id))
        .map(entry => ({
          id: entry.id,
          label: entry.title,
          icon: '•',
          url: `./${encodeURIComponent(entry.id)}/index.html`,
          sourceUrl: `./${encodePath(entry.entry)}`,
        })),
    }));

  return Object.freeze({
    catalog,
    diagnostics: Object.freeze(diagnostics),
    acceptedEntryCount: entryIds.size,
    skippedEntryCount,
  });
}

function encodePath(path) {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function isLocalTypeScriptEntry(path, id) {
  if (typeof path !== 'string' || !path.endsWith('.ts') || !path.startsWith(`${id}/`)) return false;
  return path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}
