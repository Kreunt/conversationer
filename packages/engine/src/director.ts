import type { CefrLevel, LanguagePack, Move, QuestionStyle, Turn } from './types.ts';
import { countWords } from './text.ts';

/** A long-running topic only ends once the user has also stopped saying much about it. */
const MAX_TURNS_ON_TOPIC = 12;
const FADING_ANSWER_WORDS = 4;
const SHORT_ANSWER_WORDS = 2;
const SHORT_ANSWERS_BEFORE_NEW_TOPIC = 3;

export interface DirectorInput {
  history: Turn[];
  level: CefrLevel;
  pack: LanguagePack;
  hasCallback: boolean;
  hasPersonaEvent: boolean;
}

export interface Direction {
  move: Move;
  questionStyle: QuestionStyle;
  /** Tell a story from the persona's day. Only when the user gave nothing to relate to. */
  tellStory?: boolean;
}

const ASKING_MOVES: ReadonlySet<Move> = new Set(['opening', 'follow_up', 'callback', 'new_topic']);

export function requiresQuestion(move: Move): boolean {
  return ASKING_MOVES.has(move);
}

/** Moves too important to leave to a small model: their replies are hand-written in the language pack. */
export function isScripted(move: Move): boolean {
  return move === 'care' || move === 'honest_answer';
}

/**
 * Decides what kind of turn the persona takes. Two people talking take turns at everything: answering
 * comes first, and asking alternates with telling, so the conversation never becomes an interview.
 */
export function chooseDirection(input: DirectorInput): Direction {
  const { history, level, pack, hasCallback, hasPersonaEvent } = input;
  const rules = pack.levels[level];
  const personaTurns = history.filter((t) => t.speaker === 'persona');
  const personaMoves = personaTurns.flatMap((t) => (t.move ? [t.move] : []));
  const lastUser = history.findLast((t) => t.speaker === 'user');
  const lastMove = personaMoves.at(-1);
  const style = rules.defaultQuestionStyle;

  if (lastUser) {
    // Safety and honesty come before every conversational goal.
    if (pack.distress.test(lastUser.text)) return { move: 'care', questionStyle: 'open' };
    if (pack.askedIfAi.test(lastUser.text)) return { move: 'honest_answer', questionStyle: style };
    if (pack.goodbye.test(lastUser.text)) return { move: 'farewell', questionStyle: style };
    // Ignoring a question is the fastest way to sound like a machine, so it outranks everything below.
    if (pack.userQuestion.test(lastUser.text)) return { move: 'answer', questionStyle: style };
  }

  if (personaMoves.length === 0 && hasCallback) return { move: 'callback', questionStyle: style };
  if (!lastUser) return { move: 'opening', questionStyle: style };

  const userWords = countWords(lastUser.text);
  const shortAnswers = countTrailingShortAnswers(history);
  const justAsked = personaTurns.at(-1)?.text.includes('?') ?? false;

  if (shortAnswers >= SHORT_ANSWERS_BEFORE_NEW_TOPIC && lastMove !== 'new_topic') {
    return { move: 'new_topic', questionStyle: 'either_or', tellStory: hasPersonaEvent };
  }
  if (turnsOnTopic(personaMoves) >= MAX_TURNS_ON_TOPIC && userWords <= FADING_ANSWER_WORDS) {
    return { move: 'new_topic', questionStyle: style, tellStory: hasPersonaEvent };
  }

  // Their answer earns something back. A story only fits if they gave nothing to relate to.
  if (justAsked) return { move: 'react_and_share', questionStyle: style, tellStory: shortAnswers > 0 && hasPersonaEvent };

  // "Danke" or "ach so" after the persona told something: they're listening, so keep talking.
  if (pack.acknowledgement.test(lastUser.text)) {
    return { move: 'react_and_share', questionStyle: style, tellStory: hasPersonaEvent };
  }

  if (userWords >= rules.longAnswerWords && lastMove !== 'react_and_share') {
    return { move: 'react_and_share', questionStyle: style };
  }

  return { move: 'follow_up', questionStyle: shortAnswers > 0 ? 'either_or' : style };
}

function countTrailingShortAnswers(history: Turn[]): number {
  let count = 0;
  for (const turn of history.toReversed()) {
    if (turn.speaker !== 'user') continue;
    if (countWords(turn.text) > SHORT_ANSWER_WORDS) break;
    count++;
  }
  return count;
}

function turnsOnTopic(moves: Move[]): number {
  const lastChange = moves.lastIndexOf('new_topic');
  return moves.length - lastChange - 1;
}
