/**
 * Talk to Jonas in the terminal, to judge how a model and level actually feel.
 *
 *   npm run chat -- --model gemma4:e4b-it-qat --level A2
 *
 * Add --debug to see the Director's move and anything the guards removed.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { german, jonas } from '../languages/de/index.ts';
import { generateTurn, openAiCompatibleChat, personaTurn } from '../packages/engine/src/index.ts';
import type { CefrLevel, Turn } from '../packages/engine/src/index.ts';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gemma4:e4b-it-qat' },
    level: { type: 'string', default: 'A2' },
    base: { type: 'string', default: 'http://localhost:11434' },
    debug: { type: 'boolean', default: false },
  },
});

const chat = openAiCompatibleChat(values.base, values.model);
const level = values.level as CefrLevel;
const history: Turn[] = [];

async function personaSpeaks(): Promise<void> {
  const result = await generateTurn({ history, level, pack: german, persona: jonas, memory: {}, chat });
  console.log(`\nJonas: ${result.reply}\n`);
  if (values.debug) {
    console.log(`  (${result.direction.move}, ${result.direction.questionStyle})`);
    for (const { sentence, violations } of result.rejected) console.log(`  removed [${violations.join(', ')}]: ${sentence}`);
  }
  history.push(personaTurn(result));
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Talking to Jonas at ${level} on ${values.model}. An empty line quits.`);
await personaSpeaks();
while (true) {
  const line = (await terminal.question('Du: ')).trim();
  if (!line) break;
  history.push({ speaker: 'user', text: line });
  await personaSpeaks();
}
terminal.close();
