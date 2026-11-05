import { chooseDirection, isScripted, requiresQuestion, type Direction } from './director.ts';
import { checkSentence, cleanSentence, isQuestion, openerOf, type Violation } from './guards.ts';
import type { ChatMessage, ChatStream } from './llm.ts';
import { SentenceSplitter, stripThinking } from './text.ts';
import type { CefrLevel, LanguagePack, Memory, Move, Persona, Turn } from './types.ts';

const RECENT_OPENERS = 4;
const HISTORY_TURNS = 16;
const MAX_ATTEMPTS = 2;
const MAX_TOKENS = 160;

export interface TurnRequest {
  history: Turn[];
  level: CefrLevel;
  pack: LanguagePack;
  persona: Persona;
  memory: Memory;
  chat: ChatStream;
  temperature?: number;
  signal?: AbortSignal;
}

export interface TurnEvents {
  /** Called once per accepted sentence, in order, so speech can start before the reply is complete. */
  onSentence?: (sentence: string) => void;
}

export interface TurnResult {
  direction: Direction;
  reply: string;
  /** Everything the guards removed, kept so evals can measure what the model tried to say. */
  rejected: { sentence: string; violations: Violation[] }[];
  attempts: number;
  usedFallback: boolean;
  /** A question the model didn't supply was added to keep the conversation open. */
  addedHook: boolean;
}

/** Rotates through the persona's day, so it tells a new story rather than repeating one. */
export function nextPersonaEvent(history: Turn[], persona: Persona): string | undefined {
  const told = history.filter((t) => t.toldStory).length;
  return persona.todayEvents[told % persona.todayEvents.length];
}

/** The history entry for a finished turn. */
export function personaTurn(result: TurnResult): Turn {
  return { speaker: 'persona', text: result.reply, move: result.direction.move, toldStory: result.direction.tellStory };
}

function recentOpeners(history: Turn[]): string[] {
  return history
    .filter((t) => t.speaker === 'persona')
    .slice(-RECENT_OPENERS)
    .map((t) => openerOf(t.text));
}

export function buildMessages(req: TurnRequest, direction: Direction): ChatMessage[] {
  const { pack, level, persona, memory, history } = req;
  const { move } = direction;
  if (move === 'care' || move === 'honest_answer') throw new Error(`${move} replies are scripted`);

  const note: string[] = [
    move === 'react_and_share' && !direction.tellStory ? pack.relateInstruction : pack.moveInstructions[move],
  ];
  if (direction.tellStory) {
    const event = nextPersonaEvent(history, persona);
    if (event) note.push(`${pack.storyLabel}: ${event}`);
  }
  if (requiresQuestion(move)) note.push(pack.questionStyleInstructions[direction.questionStyle]);
  // Quoting the question beside the instruction stops small models from answering something easier.
  const lastUser = history.findLast((t) => t.speaker === 'user');
  if (move === 'answer' && lastUser) note.push(`${pack.questionLabel}: "${lastUser.text}"`);
  if (move === 'callback' && memory.callback) note.push(`${pack.topicLabel}: ${memory.callback}`);
  const openers = [...new Set(recentOpeners(history))].filter(Boolean);
  if (openers.length > 0) note.push(`${pack.avoidOpenersLabel}: ${openers.map((o) => `"${o}"`).join(', ')}.`);

  // The system prompt never changes, so the server can reuse its cached prompt each turn. The
  // direction goes beside the latest message, where small models follow it most reliably.
  const messages: ChatMessage[] = [
    { role: 'system', content: pack.systemPrompt({ persona, level: pack.levels[level], levelName: level }) },
  ];
  for (const turn of history.slice(-HISTORY_TURNS)) {
    messages.push({ role: turn.speaker === 'user' ? 'user' : 'assistant', content: turn.text });
  }
  const directorNote = `[${pack.directorLabel}: ${note.join(' ')}]`;
  const last = messages.at(-1);
  if (last?.role === 'user') last.content += `\n\n${directorNote}`;
  else messages.push({ role: 'user', content: directorNote });
  return messages;
}

export async function generateTurn(req: TurnRequest, events: TurnEvents = {}): Promise<TurnResult> {
  const { pack, level, persona, history } = req;
  const direction = chooseDirection({
    history,
    level,
    pack,
    hasCallback: Boolean(req.memory.callback),
    hasPersonaEvent: persona.todayEvents.length > 0,
  });
  if (isScripted(direction.move)) {
    const text = direction.move === 'care' ? pack.fallbacks.care : pack.fallbacks.honestAnswer;
    const splitter = new SentenceSplitter();
    const sentences = [...splitter.push(text), ...splitter.flush()];
    for (const sentence of sentences) events.onSentence?.(sentence);
    return { direction, reply: text, rejected: [], attempts: 0, usedFallback: false, addedHook: false };
  }

  const rules = pack.levels[level];
  const needsQuestion = requiresQuestion(direction.move);
  const openers = recentOpeners(history);

  const accepted: string[] = [];
  const rejected: TurnResult['rejected'] = [];
  const emit = (sentence: string) => {
    accepted.push(sentence);
    events.onSentence?.(sentence);
  };
  const hasAskedQuestion = () => accepted.some(isQuestion);

  let attempts = 0;
  while (attempts < MAX_ATTEMPTS && accepted.length === 0) {
    attempts++;
    const abort = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, abort.signal]) : abort.signal;
    const splitter = new SentenceSplitter();

    const consider = (rawSentence: string): boolean => {
      const sentence = cleanSentence(rawSentence);
      if (!sentence) return false;
      const violations = checkSentence(sentence, {
        pack,
        level,
        recentOpeners: openers,
        isFirstSentence: accepted.length === 0,
      });
      if (violations.length > 0) {
        rejected.push({ sentence, violations });
        return false;
      }
      const question = isQuestion(sentence);
      // One question per reply, and only on moves that ask. After answering, a plain "Und du?" is natural.
      const allowed = needsQuestion || (direction.move === 'answer' && pack.reciprocalQuestion.test(sentence));
      if (question && (hasAskedQuestion() || !allowed)) return false;
      // Keep the last slot free so a limit on sentences can't cut off the question.
      const reserved = needsQuestion && !hasAskedQuestion() && !question ? 1 : 0;
      if (accepted.length + reserved >= rules.maxSentences) return false;
      emit(sentence);
      return accepted.length >= rules.maxSentences;
    };

    let raw = '';
    let visible = 0;
    let done = false;
    try {
      for await (const chunk of req.chat(buildMessages(req, direction), {
        temperature: req.temperature ?? 0.6,
        maxTokens: MAX_TOKENS,
        signal,
      })) {
        raw += chunk;
        const clean = stripThinking(raw);
        // The model has started reading out its directions, and nothing after that is conversation.
        const leak = clean.indexOf('[');
        const speakable = leak === -1 ? clean : clean.slice(0, leak);
        const fresh = speakable.slice(visible);
        visible = speakable.length;
        for (const sentence of splitter.push(fresh)) {
          if (consider(sentence)) {
            done = true;
            break;
          }
        }
        if (done || leak !== -1) {
          abort.abort();
          break;
        }
      }
    } catch (error) {
      if (req.signal?.aborted || !abort.signal.aborted) throw error;
    }
    if (!done) for (const sentence of splitter.flush()) consider(sentence);
  }

  const usedFallback = accepted.length === 0;
  if (usedFallback) emit(fallbackFor(direction, pack, history.length + attempts));

  const addedHook = needsQuestion && !hasAskedQuestion();
  if (addedHook) {
    const hooks = pack.fallbacks.hooks[direction.questionStyle];
    emit(pick(hooks, history.length));
  }

  return { direction, reply: accepted.join(' '), rejected, attempts, usedFallback, addedHook };
}

function fallbackFor(direction: Direction, pack: LanguagePack, seed: number): string {
  if (direction.move === 'farewell') return pack.fallbacks.farewell;
  if (direction.move === 'answer') return pack.fallbacks.unsure;
  return pick(pack.fallbacks.reactions, seed);
}

function pick<T>(items: T[], seed: number): T {
  const item = items[seed % items.length];
  if (item === undefined) throw new Error('Language pack has an empty fallback list');
  return item;
}
