import { countWords, isQuestion, openerOf, requiresQuestion, SentenceSplitter, words } from '../packages/engine/src/index.ts';
import type { CefrLevel, LanguagePack, Move, TurnResult } from '../packages/engine/src/index.ts';

export interface RecordedTurn extends TurnResult {
  user: string;
  firstSentenceMs: number;
  totalMs: number;
}

export interface Metrics {
  turns: number;
  closingPhrasesAttempted: number;
  closingPhrasesSpoken: number;
  humanClaimsSpoken: number;
  withinLevelPct: number;
  deadEnds: number;
  fallbackPct: number;
  addedHookPct: number;
  rejectedSentencesPerTurn: number;
  distinctOpenersPct: number;
  /** Replies that open by repeating the learner's words back. Some recasting helps; constant echo sounds robotic. */
  parrotPct: number;
  /** Replies containing a question. Far above half and the conversation has become an interview. */
  asksPct: number;
  /** The user asked something and the persona replied with a question of its own, other than "Und du?". */
  dodgedQuestions: number;
  exactRepeats: number;
  meanReplyWords: number;
  userWordSharePct: number;
  /** LIX readability: lower is easier. Roughly under 30 is very easy text. A proxy until the lexicon exists. */
  lix: number;
  firstSentenceMsP50: number;
  firstSentenceMsP95: number;
}

function sentencesOf(text: string): string[] {
  const splitter = new SentenceSplitter();
  return [...splitter.push(text), ...splitter.flush()];
}

function percentile(values: number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const PARROT_SHARE = 0.7;

function isParrot(turn: RecordedTurn): boolean {
  const heard = new Set(words(turn.user).map((w) => w.toLowerCase()));
  const spoken = words(sentencesOf(turn.reply)[0] ?? '').map((w) => w.toLowerCase());
  if (spoken.length < 2) return false;
  return spoken.filter((w) => heard.has(w)).length / spoken.length >= PARROT_SHARE;
}

const SCRIPTED: ReadonlySet<Move> = new Set(['care', 'honest_answer']);

export function computeMetrics(turns: RecordedTurn[], level: CefrLevel, pack: LanguagePack): Metrics {
  const rules = pack.levels[level];
  const generated = turns.filter((t) => !SCRIPTED.has(t.direction.move));
  const replies = generated.map((t) => t.reply);

  const withinLevel = generated.filter((t) => {
    const sentences = sentencesOf(t.reply);
    return (
      sentences.length <= rules.maxSentences &&
      sentences.every((s) => countWords(s) <= rules.maxWordsPerSentence + rules.wordTolerance)
    );
  });

  // A dead end leaves the user with nothing to respond to: a move that had to ask, but didn't.
  const deadEnds = generated.filter((t) => requiresQuestion(t.direction.move) && !sentencesOf(t.reply).some(isQuestion));

  const openers = generated.map((t) => openerOf(t.reply));
  const allWords = replies.flatMap(words);
  const sentenceCount = replies.flatMap(sentencesOf).length;
  const longWords = allWords.filter((w) => w.length > 6).length;
  const userWords = turns.reduce((sum, t) => sum + countWords(t.user), 0);
  const firstSentence = generated.map((t) => t.firstSentenceMs);

  return {
    turns: turns.length,
    closingPhrasesAttempted: generated.reduce(
      (sum, t) => sum + t.rejected.filter((r) => r.violations.includes('closing_phrase')).length,
      0,
    ),
    closingPhrasesSpoken: replies.filter((r) => pack.closingPhrases.some((p) => p.test(r))).length,
    humanClaimsSpoken: replies.filter((r) => pack.humanClaims.some((p) => p.test(r))).length,
    withinLevelPct: round((100 * withinLevel.length) / generated.length),
    deadEnds: deadEnds.length,
    fallbackPct: round((100 * generated.filter((t) => t.usedFallback).length) / generated.length),
    addedHookPct: round((100 * generated.filter((t) => t.addedHook).length) / generated.length),
    rejectedSentencesPerTurn: round(generated.reduce((sum, t) => sum + t.rejected.length, 0) / generated.length, 2),
    distinctOpenersPct: round((100 * new Set(openers).size) / openers.length),
    parrotPct: round((100 * generated.filter(isParrot).length) / generated.length),
    asksPct: round((100 * generated.filter((t) => sentencesOf(t.reply).some(isQuestion)).length) / generated.length),
    dodgedQuestions: generated.filter(
      (t) => t.direction.move === 'answer' && sentencesOf(t.reply).some((s) => isQuestion(s) && !pack.reciprocalQuestion.test(s)),
    ).length,
    exactRepeats: replies.length - new Set(replies).size,
    meanReplyWords: round(allWords.length / replies.length),
    userWordSharePct: round((100 * userWords) / (userWords + allWords.length)),
    lix: round(allWords.length / Math.max(sentenceCount, 1) + (100 * longWords) / Math.max(allWords.length, 1)),
    firstSentenceMsP50: Math.round(percentile(firstSentence, 50)),
    firstSentenceMsP95: Math.round(percentile(firstSentence, 95)),
  };
}
