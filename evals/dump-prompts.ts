/** Writes real prompts from a recorded conversation, for timing a server this process can't reach directly. */
import { readFileSync, writeFileSync } from 'node:fs';
import { german, jonas } from '../languages/de/index.ts';
import { buildMessages, personaTurn } from '../packages/engine/src/index.ts';
import type { Turn, TurnResult } from '../packages/engine/src/index.ts';

const [source, destination] = process.argv.slice(2) as [string, string];
const { turns } = JSON.parse(readFileSync(source, 'utf8')) as { turns: (TurnResult & { user: string })[] };
const history: Turn[] = [];
const prompts = [];
for (const turn of turns.slice(0, 14)) {
  history.push({ speaker: 'user', text: turn.user });
  if (turn.direction.move !== 'honest_answer' && turn.direction.move !== 'care') {
    prompts.push(buildMessages({ history, level: 'A2', pack: german, persona: jonas, memory: {}, chat: async function* () {} }, turn.direction));
  }
  history.push(personaTurn(turn));
}
writeFileSync(destination, JSON.stringify(prompts));
