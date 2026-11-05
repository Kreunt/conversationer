/**
 * Replays the exact moment a conversation went wrong, several times per model, to read how the
 * persona handles it. Unlike the scripted learners, each case carries its own history.
 *
 *   npx tsx evals/probe.ts --models gemma4:e4b-it-qat,gemma4:12b-it-qat [--samples 5]
 */
import { parseArgs } from 'node:util';
import { german, jonas } from '../languages/de/index.ts';
import { generateTurn, openAiCompatibleChat } from '../packages/engine/src/index.ts';
import type { Turn } from '../packages/engine/src/index.ts';

const { values } = parseArgs({
  options: {
    models: { type: 'string', default: 'gemma4:e4b-it-qat' },
    samples: { type: 'string', default: '5' },
    base: { type: 'string', default: 'http://localhost:11434' },
  },
});

const user = (text: string): Turn => ({ speaker: 'user', text });
const persona = (text: string): Turn => ({ speaker: 'persona', text, move: 'answer' });

const opening = [user('Hallo, er war gut, und deins?'), persona('Mein Tag war auch okay. Ich war heute in der Bäckerei.')];

const cases: { name: string; wanted: string; history: Turn[] }[] = [
  {
    name: 'false premise: he works there',
    wanted: 'says he bought nothing, he works there',
    history: [...opening, user('ach so, was hast du da gekauft?')],
  },
  {
    name: 'false premise: a pet he does not have',
    wanted: 'says he has a dog, not a cat',
    history: [user('Wie heißt deine Katze?')],
  },
  {
    name: 'false premise: somewhere he has not been',
    wanted: 'says no, or that he was at work',
    history: [user('Wie war dein Urlaub in Spanien gestern?')],
  },
  {
    name: 'challenged on a contradiction',
    wanted: 'admits the mix-up and clears it up',
    history: [
      ...opening,
      user('ach so, was hast du da gekauft?'),
      persona('Ich habe frische Brötchen gekauft. Ich brauche sie für Bruno.'),
      user('Bruno? du meinst deinen Hund? isst er Brot gern?'),
      persona('Nein, Bruno isst kein Brot. Er mag nur Käse sehr gerne.'),
      user('warum hast du denn für ihn Brötchen gekauft'),
    ],
  },
  {
    name: 'pressed a second time',
    wanted: 'stays on it, does not change the subject',
    history: [
      ...opening,
      user('ach so, was hast du da gekauft?'),
      persona('Ich habe frische Brötchen gekauft. Ich brauche sie für Bruno.'),
      user('warum hast du denn für ihn Brötchen gekauft'),
      persona('Ich brauche sie für das Abendbrot. Ich koche oft einfache Nudeln.'),
      user('du warst aber in der Bäckerei, ja? und du hast frische Brötchen für Bruno gekauft'),
    ],
  },
  {
    name: 'true premise, to catch over-correction',
    wanted: 'agrees: he does have a dog called Bruno',
    history: [user('Du hast doch einen Hund, oder? Wie alt ist er?')],
  },
];

for (const model of values.models.split(',')) {
  console.log(`\n===== ${model}`);
  const chat = openAiCompatibleChat(values.base, model);
  for (const { name, wanted, history } of cases) {
    console.log(`\n--- ${name} (wanted: ${wanted})\n    "${history.at(-1)?.text}"`);
    for (let sample = 0; sample < Number(values.samples); sample++) {
      const result = await generateTurn({ history, level: 'A2', pack: german, persona: jonas, memory: {}, chat });
      console.log(`  [${result.direction.move}] ${result.reply}`);
    }
  }
  await fetch(`${values.base}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => undefined);
}
