import type { ChatStream } from './llm.ts';
import { stripThinking } from './text.ts';
import type { LanguagePack } from './types.ts';

const MAX_TOKENS = 120;

function comparable(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]/gu, '').replace(/\s+/g, ' ').trim();
}
const MAX_SENTENCES = 2;

export interface Feedback {
  /** True when nothing needed changing. */
  natural: boolean;
  text: string;
  /** The better version on its own, when there is one, for showing what changed. */
  suggestion?: string;
  /** Why, when the language's reasons have been found reliable enough to show. */
  reason?: string;
}

/**
 * A private suggestion for one thing the user said, only ever given when they ask. Low temperature,
 * because inventing a mistake that isn't there would be worse than missing one.
 */
export async function askForFeedback(said: string, pack: LanguagePack, chat: ChatStream, signal?: AbortSignal): Promise<Feedback> {
  const coach = pack.feedback;
  if (!coach) throw new Error(`${pack.languageName} has no feedback`);
  let streamed = '';
  for await (const chunk of chat(
    [
      { role: 'system', content: coach.system },
      { role: 'user', content: coach.request(said) },
    ],
    { temperature: 0.1, maxTokens: MAX_TOKENS, signal },
  )) {
    streamed += chunk;
  }
  const reply = stripThinking(streamed).replace(/[*_#`]/g, '').trim();
  if (!reply || reply.toLowerCase().startsWith(coach.natural.toLowerCase().replace(/\.$/, ''))) {
    return { natural: true, text: coach.natural };
  }
  // Speech recognition decides punctuation and capitals, so a "fix" that only changes those isn't one.
  const suggested = /["“]([^"”]+)["”]/.exec(reply)?.[1];
  if (suggested && comparable(suggested) === comparable(said)) return { natural: true, text: coach.natural };
  if (suggested && !coach.showReason) return { natural: false, text: `“${suggested.trim()}”`, suggestion: suggested.trim() };
  const sentences = reply.match(/[^.!?]+[.!?]+["”’']?|[^.!?]+$/g) ?? [reply];
  const text = sentences.slice(0, MAX_SENTENCES).map((s) => s.trim()).join(' ');
  if (!suggested) return { natural: false, text };
  const reason = text.slice(text.indexOf(suggested) + suggested.length).replace(/^["”’'\s.]+/, '').trim();
  return { natural: false, text, suggestion: suggested.trim(), reason: reason || undefined };
}
