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
}

/**
 * A private suggestion for one thing the user said, only ever given when they ask. Low temperature,
 * because inventing a mistake that isn't there would be worse than missing one.
 */
export async function askForFeedback(said: string, pack: LanguagePack, chat: ChatStream, signal?: AbortSignal): Promise<Feedback> {
  const coach = pack.feedback;
  if (!coach) throw new Error(`${pack.languageName} has no feedback`);
  let text = '';
  for await (const chunk of chat(
    [
      { role: 'system', content: coach.system },
      { role: 'user', content: coach.request(said) },
    ],
    { temperature: 0.1, maxTokens: MAX_TOKENS, signal },
  )) {
    text += chunk;
  }
  const reply = stripThinking(text).replace(/[*_#`]/g, '').trim();
  if (!reply || reply.toLowerCase().startsWith(coach.natural.toLowerCase().replace(/\.$/, ''))) {
    return { natural: true, text: coach.natural };
  }
  // Speech recognition decides punctuation and capitals, so a "fix" that only changes those isn't one.
  const suggested = /["“]([^"”]+)["”]/.exec(reply)?.[1];
  if (suggested && comparable(suggested) === comparable(said)) return { natural: true, text: coach.natural };
  const sentences = reply.match(/[^.!?]+[.!?]+["”’']?|[^.!?]+$/g) ?? [reply];
  return { natural: false, text: sentences.slice(0, MAX_SENTENCES).map((s) => s.trim()).join(' ') };
}
