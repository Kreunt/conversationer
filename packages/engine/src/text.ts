const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;

export function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

export function countWords(text: string): number {
  return words(text).length;
}

/**
 * Incrementally splits streamed text into sentences. A boundary needs following whitespace, so an
 * abbreviation or number can't end a sentence mid-token.
 */
export class SentenceSplitter {
  #buffer = '';

  /** Adds streamed text and returns any sentences it completed. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const sentences: string[] = [];
    let start = 0;
    for (const match of this.#buffer.matchAll(/[.!?…]+["“”'»)]*\s+/g)) {
      const end = match.index + match[0].length;
      const candidate = this.#buffer.slice(start, end).trim();
      if (isNonBoundary(candidate)) continue;
      sentences.push(candidate);
      start = end;
    }
    this.#buffer = this.#buffer.slice(start);
    return sentences;
  }

  /** Returns whatever is left when the stream ends. */
  flush(): string[] {
    const rest = this.#buffer.trim();
    this.#buffer = '';
    return rest ? [rest] : [];
  }
}

const ABBREVIATION = /(?:^|\s)(?:z\.\s?B|d\.\s?h|u\.\s?a|bzw|ca|usw|etc|Dr|Hr|Fr|Nr|Str)\.$/;
const ORDINAL = /(?:^|\s)\d+\.$/;

function isNonBoundary(candidate: string): boolean {
  return ABBREVIATION.test(candidate) || ORDINAL.test(candidate);
}

/**
 * Cleans what speech recognition returned. Returns an empty string if nobody really said anything:
 * Whisper turns silence and noise into bracketed labels like "[MUSIK]" and subtitle phrases like "Amen."
 */
export function cleanTranscript(transcript: string, phantoms: RegExp[]): string {
  const text = transcript
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (countWords(text) === 0) return '';
  const bare = text.replace(/[.!?…,\s]+$/u, '');
  return phantoms.some((p) => p.test(bare)) ? '' : text;
}

/** Removes reasoning blocks some models emit even with thinking disabled. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .replace(/<[^>]*$/, ''); // A tag still arriving from the stream.
}
