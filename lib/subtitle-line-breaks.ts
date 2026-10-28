/**
 * Broadcast subtitles keep a line to about 42 characters, so the eye can take it in
 * without travelling across the whole picture. Many SRT files, machine transcripts in
 * particular, put a whole sentence on one line, and the browser then draws it edge to
 * edge. Splitting is done in the player rather than at upload so files already stored
 * benefit as well.
 */
export const MAX_CUE_LINE_LENGTH = 42;

const CHARACTER_REFERENCE = /&(?:#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/iy;

/**
 * What the viewer sees: no markup, `&amp;` as one character, an emoji as one. The text is
 * measured in place, not stripped, because only its length is needed.
 */
function visibleLength(text: string): number {
  let length = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === '<') {
      const close = text.indexOf('>', index);
      if (close !== -1) {
        index = close + 1;
        continue;
      }
    }
    if (text[index] === '&') {
      CHARACTER_REFERENCE.lastIndex = index;
      if (CHARACTER_REFERENCE.test(text)) {
        length += 1;
        index = CHARACTER_REFERENCE.lastIndex;
        continue;
      }
    }
    const codePoint = text.codePointAt(index) ?? 0;
    index += codePoint > 0xffff ? 2 : 1;
    length += 1;
  }
  return length;
}

/**
 * Splits on spaces and tabs outside `<...>`, so a voice tag like `<v Jane Doe>` stays
 * whole. A no-break space is not a split point: the author asked for those words to stay
 * together.
 */
function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let inTag = false;
  for (const char of text) {
    if (char === '<') inTag = true;
    else if (char === '>') inTag = false;
    if (!inTag && (char === ' ' || char === '\t')) {
      if (current) words.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  // A tag set off by a space, as in `<i> word` or `word </i>`, shows nothing, so it is
  // joined to its neighbour instead of being able to land on a line of its own. The space
  // goes: at the edge of a line it would not show either.
  const merged: string[] = [];
  let pending = '';
  for (const word of words) {
    if (visibleLength(word) > 0) {
      merged.push(pending + word);
      pending = '';
    } else if (merged.length > 0) {
      merged[merged.length - 1] += word;
    } else {
      pending += word;
    }
  }
  if (pending) merged.push(pending);
  return merged;
}

/** Fills lines word by word up to `width`, which gives the fewest lines for that width. */
function fillLines(words: string[], lengths: number[], width: number): string[][] {
  const lines: string[][] = [];
  let line: string[] = [];
  let lineLength = 0;
  words.forEach((word, index) => {
    const added = line.length === 0 ? lengths[index] : lineLength + 1 + lengths[index];
    if (line.length > 0 && added > width) {
      lines.push(line);
      line = [word];
      lineLength = lengths[index];
    } else {
      line.push(word);
      lineLength = added;
    }
  });
  if (line.length > 0) lines.push(line);
  return lines;
}

/**
 * Splits the words into exactly `lineCount` lines no wider than `width` (a word wider than
 * that on a line of its own), choosing the breaks that make the lines most even: the sum of
 * squared line lengths is lowest when they are all alike. Returns null if it cannot be done.
 */
function evenLines(
  words: string[],
  lengths: number[],
  width: number,
  lineCount: number
): string[][] | null {
  const count = words.length;
  // cost[k][i]: best score for the first i words on k lines. from[k][i]: where line k starts.
  const cost: number[][] = Array.from({ length: lineCount + 1 }, () =>
    new Array<number>(count + 1).fill(Infinity)
  );
  const from: number[][] = Array.from({ length: lineCount + 1 }, () =>
    new Array<number>(count + 1).fill(-1)
  );
  cost[0][0] = 0;
  for (let line = 1; line <= lineCount; line += 1) {
    for (let end = 1; end <= count; end += 1) {
      // Walk the line's start backwards until it no longer fits, so the work per word is
      // bounded by how many words fit on one line.
      let lineLength = -1;
      for (let start = end - 1; start >= 0; start -= 1) {
        lineLength += 1 + lengths[start];
        if (lineLength > width && start < end - 1) break;
        const score = cost[line - 1][start] + lineLength * lineLength;
        if (score < cost[line][end]) {
          cost[line][end] = score;
          from[line][end] = start;
        }
      }
    }
  }
  if (!Number.isFinite(cost[lineCount][count])) return null;

  const lines: string[][] = [];
  let end = count;
  for (let line = lineCount; line > 0; line -= 1) {
    const start = from[line][end];
    lines.unshift(words.slice(start, end));
    end = start;
  }
  return lines;
}

/**
 * Breaks a one-line cue into the fewest lines that fit `maxLineLength`, keeps the longest
 * of them as short as it can be, and evens out the rest, so the result is never one long
 * line and a short tail. A word longer than the limit gets a line of its own. A cue that
 * already has a line break is left alone: its author chose it.
 */
export function balanceCueLines(text: string, maxLineLength = MAX_CUE_LINE_LENGTH): string {
  if (text.includes('\n')) return text;
  const words = splitWords(text);
  if (words.length < 2) return text;
  const lengths = words.map(visibleLength);
  const total = lengths.reduce((sum, length) => sum + length, 0) + words.length - 1;
  if (total <= maxLineLength) return text;

  // Greedy filling puts an oversized word on a line of its own, and needs no more lines as
  // the width grows, so it gives the minimum count and a binary search the narrowest width
  // that keeps it.
  const lineCount = fillLines(words, lengths, maxLineLength).length;
  let low = 1;
  let high = maxLineLength;
  while (low < high) {
    const width = Math.floor((low + high) / 2);
    if (fillLines(words, lengths, width).length <= lineCount) high = width;
    else low = width + 1;
  }

  const lines = evenLines(words, lengths, low, lineCount) ?? fillLines(words, lengths, low);
  return lines.map((line) => line.join(' ')).join('\n');
}
