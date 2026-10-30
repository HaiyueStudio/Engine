import {segmentGraphemes} from './DeterministicTextShaper.js';
import type {RuntimeTextBlock} from './runtime-types.js';

export function textRunValue(block: RuntimeTextBlock, index: number, strings?: Readonly<Record<string, string>>): string {
  const run = block.runs[index]!;
  return index === 0 && block.input && strings?.[block.input.valuePort] !== undefined ? strings[block.input.valuePort]!
    : run.valuePort && strings?.[run.valuePort] !== undefined ? strings[run.valuePort]! : run.text;
}
export function textContent(block: RuntimeTextBlock, strings?: Readonly<Record<string, string>>): string {
  const value = block.input && strings?.[block.input.valuePort];
  return value !== undefined ? value : block.runs.map(run => run.valuePort && strings?.[run.valuePort] !== undefined ? strings[run.valuePort]! : run.text).join('');
}
/** Editing boundaries are block-wide, independent of authored style/run boundaries. */
export function textClusters(block: RuntimeTextBlock, strings?: Readonly<Record<string, string>>): readonly Readonly<{start: number; end: number; sequence: string}>[] {
  let start = 0;
  return segmentGraphemes(textContent(block, strings)).map(cluster => {
    const end = start + cluster.sequence.length, value = {start, end, sequence: cluster.sequence};
    start = end;
    return value;
  });
}

/** Production input ports replace a whole plain value, never just the first authored run.
 * Preserve unchanged grapheme prefix/suffix styles; replacement inherits the first
 * replaced cluster, insertion the preceding cluster (first cluster at the start).
 * This is a pure authored-style projection, not another editor or mutable style buffer. */
export function textShapingRuns(block: RuntimeTextBlock, strings?: Readonly<Record<string, string>>): readonly Readonly<{style: string; text: string}>[] {
  const value = block.input && strings?.[block.input.valuePort];
  const runs = block.runs.map((run, index) => ({style: run.style, text:
    value !== undefined && (index === 0 || run.valuePort === block.input!.valuePort) ? run.text
      : run.valuePort && strings?.[run.valuePort] !== undefined ? strings[run.valuePort]! : run.text}));
  const authored = runs.map(run => run.text).join(''), clusters = segmentGraphemes(authored);
  if (!runs.length) return [];
  const owners: string[] = []; let run = 0, end = runs[0]!.text.length, offset = 0;
  for (const cluster of clusters) {
    while (run < runs.length - 1 && offset >= end) end += runs[++run]!.text.length;
    owners.push(runs[run]!.style); offset += cluster.sequence.length;
  }
  const current = value === undefined || value === authored ? clusters : segmentGraphemes(value);
  let prefix = 0, suffix = 0;
  while (prefix < clusters.length && prefix < current.length && clusters[prefix]!.sequence === current[prefix]!.sequence) prefix++;
  while (suffix < clusters.length - prefix && suffix < current.length - prefix && clusters[clusters.length - 1 - suffix]!.sequence === current[current.length - 1 - suffix]!.sequence) suffix++;
  const replaced = clusters.length - prefix - suffix;
  const inherited = owners[replaced ? prefix : Math.max(0, prefix - 1)] ?? runs[0]!.style;
  const output: {style: string; text: string}[] = []; let style: string | undefined, pieces: string[] = [];
  const flush = () => {if (style !== undefined) output.push({style, text: pieces.join('')}); pieces = [];};
  for (let i = 0; i < current.length; i++) {
    const owner = i < prefix ? owners[i]! : i >= current.length - suffix ? owners[clusters.length - current.length + i]! : inherited;
    if (owner !== style) {flush(); style = owner;}
    pieces.push(current[i]!.sequence);
  }
  flush();
  return output.length ? output : [{style: runs[0]!.style, text: ''}];
}
