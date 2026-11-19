import ts from 'typescript';

/** Strict JSON with TypeScript's existing JSON syntax tree used only for source mapping. */
export function jsonSource(file, raw) {
  const text = raw.replace(/^\uFEFF/, '');
  const tree = ts.parseJsonText(file, text);
  const diagnostics = [];
  const offsets = new Map();
  const locate = (path, offset) => {
    let nearest = path;
    while (nearest.length && !offsets.has(JSON.stringify(nearest))) nearest = nearest.slice(0, -1);
    const { line, character } = tree.getLineAndCharacterOfPosition(offset ?? offsets.get(JSON.stringify(nearest)) ?? 0);
    return { file, line: line + 1, column: character + 1, path };
  };
  const report = (path, offset, code, message) => {
    diagnostics.push({ ...locate(path, offset), severity: 'error', code, message });
  };
  let data;
  try { data = JSON.parse(text); }
  catch (error) {
    const position = /(?:at position|position) (\d+)/.exec(error.message);
    const parseError = tree.parseDiagnostics[0];
    report([], position ? Number(position[1]) : parseError?.start ?? text.length, 'invalid-json', error.message);
    return { file, diagnostics, locate };
  }
  const scan = (node, path) => {
    offsets.set(JSON.stringify(path), node.getStart(tree));
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set();
      for (const property of node.properties) {
        const key = property.name.text;
        const child = [...path, key];
        if (keys.has(key)) report(child, property.name.getStart(tree), 'duplicate-key', `Duplicate key "${key}".`);
        keys.add(key);
        scan(property.initializer, child);
      }
    }
    if (ts.isArrayLiteralExpression(node)) node.elements.forEach((entry, index) => scan(entry, [...path, index]));
  };
  const root = tree.statements[0]?.expression;
  if (root) scan(root, []);
  return { file, data, diagnostics, locate };
}
