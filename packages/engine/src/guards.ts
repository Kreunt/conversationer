import type { CefrLevel, LanguagePack } from './types.ts';
import { countWords, words } from './text.ts';

export type Violation =
  | 'closing_phrase'
  | 'human_claim'
  | 'instruction_echo'
  | 'foreign_language'
  | 'formatting'
  | 'too_long'
  | 'repeated_opener';

export interface GuardContext {
  pack: LanguagePack;
  level: CefrLevel;
  /** Openers of the persona's recent replies, from `openerOf`. An opener used twice has become a tic. */
  recentOpeners: string[];
  /** The first sentence of a reply is the only one that can repeat an opener. */
  isFirstSentence: boolean;
}

// Markdown, list markers, and emoji would all be read aloud or look wrong when spoken.
const FORMATTING = /[*_#`~\[\]{}<>|]|^\s*(?:[-•]|\d+[.)])\s|\p{Extended_Pictographic}/u;
const OPENER_TIC_COUNT = 2;

export function checkSentence(spoken: string, ctx: GuardContext): Violation[] {
  const { pack, level, recentOpeners, isFirstSentence } = ctx;
  // Models write curly apostrophes as often as straight ones, and the patterns expect straight ones.
  const sentence = spoken.replace(/[’‘]/g, "'");
  const violations: Violation[] = [];
  const rules = pack.levels[level];

  if (pack.closingPhrases.some((p) => p.test(sentence))) violations.push('closing_phrase');
  if (pack.humanClaims.some((p) => p.test(sentence))) violations.push('human_claim');
  if (pack.instructionEchoes.some((p) => p.test(sentence))) violations.push('instruction_echo');
  if (FORMATTING.test(sentence)) violations.push('formatting');
  if (isForeign(sentence, pack)) violations.push('foreign_language');
  if (countWords(sentence) > rules.maxWordsPerSentence + rules.wordTolerance) violations.push('too_long');
  // Dropping a first sentence can lose the reaction that connects the reply, so only do it for a real tic.
  const opener = openerOf(sentence);
  if (isFirstSentence && recentOpeners.filter((o) => o === opener).length >= OPENER_TIC_COUNT) {
    violations.push('repeated_opener');
  }

  return violations;
}

function isForeign(sentence: string, pack: LanguagePack): boolean {
  // Small models occasionally slip a word from another script into a sentence.
  if (pack.alienLetters.test(sentence)) return true;
  return words(sentence).some((w) => pack.foreignWords.has(w.toLowerCase()));
}

/**
 * Removes decoration that models add by habit, so one emoji doesn't cost a good sentence.
 * Returns an empty string if nothing else was there.
 */
export function cleanSentence(sentence: string): string {
  return sentence
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\*+|(?<!\w)_+|_+(?!\w)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first two words, normalised. Comparing these catches tics like "Oh, schön!". */
export function openerOf(sentence: string): string {
  return words(sentence).slice(0, 2).join(' ').toLowerCase();
}

export function isQuestion(sentence: string): boolean {
  return /\?["“”'»)]*\s*$/.test(sentence);
}
