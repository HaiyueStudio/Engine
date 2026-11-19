/** The host supplies the original GUI font metrics. Offsets refer to the intact paragraph. */
export interface ReadingLine { readonly start: number; readonly end: number; readonly text: string }

export function readingOffsets(text: string, locale: string): number[] {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  return [...Array.from(segmenter.segment(text), segment => segment.index), text.length];
}

export function wrapReadingText(
  text: string, offsets: readonly number[], width: number, measure: (text: string) => number,
): ReadingLine[] {
  const lines: ReadingLine[] = [];
  let start = 0;
  const slice = (from: number, to: number) => text.slice(offsets[from], offsets[to]);
  const add = (end: number) => { lines.push({ start, end, text: slice(start, end) }); };
  // Break at a word boundary when it fits. CJK and long words can break between graphemes.
  while (start < offsets.length - 1) {
    let end = start, space = -1;
    while (end < offsets.length - 1 && !/^\r?\n$|^\r$/u.test(slice(end, end + 1))) {
      if (end > start && measure(slice(start, end + 1)) > width) break;
      if (/^\s$/u.test(slice(end, end + 1))) space = end;
      end++;
    }
    const newline = /^\r?\n$|^\r$/u.test(slice(end, end + 1));
    if (!newline && end < offsets.length - 1 && space > start) end = space + 1;
    add(end);
    start = end + (newline ? 1 : 0);
    if (newline && start === offsets.length - 1) add(start);
  }
  if (!lines.length) add(0);
  return lines;
}
