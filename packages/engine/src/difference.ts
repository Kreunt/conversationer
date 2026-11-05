export interface Segment {
  text: string;
  /** Not in what the learner said, so it's part of the correction. */
  changed: boolean;
}

const normal = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Marks which words of a suggestion differ from what was said, so the change is visible without an
 * explanation. Plain code, so unlike a model's reason, it can't be wrong.
 */
export function markChanges(said: string, suggestion: string): Segment[] {
  const before = said.split(/\s+/).filter(Boolean).map(normal);
  const after = suggestion.split(/\s+/).filter(Boolean);
  const afterNormal = after.map(normal);

  // Longest common subsequence of words: everything outside it is a change.
  const table = Array.from({ length: before.length + 1 }, () => new Array<number>(afterNormal.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = afterNormal.length - 1; j >= 0; j--) {
      table[i]![j] = before[i] === afterNormal[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const kept = new Set<number>();
  for (let i = 0, j = 0; i < before.length && j < afterNormal.length; ) {
    if (before[i] === afterNormal[j]) {
      kept.add(j);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }

  const segments: Segment[] = [];
  after.forEach((word, index) => {
    const changed = !kept.has(index) && afterNormal[index] !== '';
    const last = segments.at(-1);
    if (last && last.changed === changed) last.text += ` ${word}`;
    else segments.push({ text: segments.length > 0 ? ` ${word}` : word, changed });
  });
  // Spaces belong outside a highlight.
  return segments.flatMap((segment) =>
    segment.text.startsWith(' ') && segment.changed ? [{ text: ' ', changed: false }, { text: segment.text.slice(1), changed: true }] : [segment],
  );
}
