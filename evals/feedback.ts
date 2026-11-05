/**
 * Checks "How could I say that better?" on sentences with and without real mistakes. Inventing a
 * mistake in a correct sentence is the failure that matters most, since these learners are anxious.
 *
 *   npx tsx evals/feedback.ts [--partner tom|jonas] [--model gemma4:e4b-it-qat] [--runs 3]
 */
import { parseArgs } from 'node:util';
import { partnerById } from '../languages/partners.ts';
import { askForFeedback, openAiCompatibleChat } from '../packages/engine/src/index.ts';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gemma4:e4b-it-qat' },
    base: { type: 'string', default: 'http://localhost:11434' },
    runs: { type: 'string', default: '3' },
    partner: { type: 'string', default: 'tom' },
  },
});
const partner = partnerById(values.partner);
if (!partner) throw new Error(`Unknown partner ${values.partner}`);
const pack = partner.pack;

// Correct, natural sentences a B2/C1 speaker might say, written as speech recognition returns them.
const englishNatural = [
  'I have been living in Hamburg for three years.',
  'To be honest I am not really into football.',
  'We ended up staying in because it was pouring down.',
  'I am looking forward to seeing my parents next week.',
  'It depends on how much time I have.',
  'I used to play the piano when I was a kid.',
  'My boss asked me to finish the report by Friday.',
  'I would rather stay at home tonight if that is okay.',
  'She told me she had already seen the film.',
  'I am thinking of changing jobs next year.',
  'If I had more time I would learn to cook properly.',
  'The traffic was awful so I was a bit late.',
  'I agree with you, it is a really good idea.',
  'We discussed the problem for over an hour.',
  'Could you tell me where you grew up?',
  'I have never been to Scotland but I would love to go.',
  'That reminds me of a trip I took with my sister.',
  'I am not sure it would work in practice.',
  'He has been working there since 2019.',
  'I did not sleep well last night so I am a bit tired.',
];

// Typical learner mistakes, each with what a good fix contains.
const englishMistakes: [string, RegExp][] = [
  ['I am living in Hamburg since three years.', /have been living|have lived/i],
  ['I am agree with you.', /\bI agree\b/i],
  ['It depends of the weather.', /depends on/i],
  ['I am looking forward to see you.', /forward to seeing/i],
  ['He said me that he was tired.', /told me|said (?:to me )?that/i],
  ['We discussed about the problem.', /discussed the problem/i],
  ['I made a photo of the lake.', /took a (?:photo|picture)/i],
  ['Can you give me an information?', /some information|a piece of information|information/i],
  ['I have seen him yesterday.', /\bI saw him\b/i],
  ['If I would have time, I would come.', /If I had (?:the )?time/i],
  ['She is working here since 2019.', /has been working|has worked/i],
  ['I go to the cinema tomorrow with my friends.', /going to|am going|will go|am seeing|'m going/i],
  ['The people is very friendly here.', /people are/i],
  ['I explained him the situation.', /explained the situation to him/i],
  ['It was the most good film I have seen.', /best film/i],
  ['I am interesting in history.', /interested in/i],
  ['My sister has 25 years.', /is 25|is twenty-five/i],
  ['I did a mistake in the report.', /made a mistake/i],
  ['Yesterday I have been to the doctor.', /went to the doctor|was at the doctor/i],
  ['I want that you come to my party.', /want you to come/i],
];

// Correct German at A1–B2, including relaxed spoken forms that must not be "corrected".
const germanNatural = [
  'Ich bin heute früh aufgestanden.',
  'Am Wochenende fahre ich zu meinen Eltern.',
  'Ich habe gestern einen Film gesehen.',
  'Meine Schwester wohnt in Hamburg.',
  'Ich lerne seit drei Monaten Deutsch.',
  'Ich mag keinen Regen.',
  'Wir sind mit dem Zug gefahren.',
  'Ich bin müde, weil ich viel gearbeitet habe.',
  'Kannst du mir bitte helfen?',
  'Ich freue mich auf das Wochenende.',
  'Am Abend schaue ich manchmal fern.',
  'Ich habe einen Bruder und eine Schwester.',
  'Das Essen war wirklich lecker.',
  'Ich weiß nicht, ob ich morgen Zeit habe.',
  'Ich interessiere mich für Musik.',
  'Gestern war ich beim Arzt.',
  'Ich trinke lieber Tee als Kaffee.',
  'Ich muss morgen früh arbeiten.',
  'Ich hab heute keine Lust.',
  'Was machst du so am Wochenende?',
];

const germanMistakes: [string, RegExp][] = [
  ['Am Wochenende ich fahre zu meinen Eltern.', /Am Wochenende fahre ich/i],
  ['Ich habe gegangen zum Arzt.', /bin zum Arzt gegangen|bin .*gegangen/i],
  ['Ich hatte ein Problem mit meine Kollegin.', /mit meiner Kollegin/i],
  ['Ich lerne Deutsch seit drei Monate.', /seit drei Monaten/i],
  ['Ich bin müde, weil ich bin krank.', /weil ich krank bin/i],
  ['Ich mag nicht Regen.', /keinen Regen/i],
  ['Ich gehe jetzt zu Hause.', /nach Hause/i],
  ['Gestern ich habe gearbeitet.', /Gestern habe ich gearbeitet/i],
  ['Ich interessiere für Musik.', /interessiere mich/i],
  ['Ich habe 30 Jahre alt.', /bin 30/i],
  ['Wir sind gefahren nach Berlin.', /sind nach Berlin gefahren/i],
  ['Ich kenne nicht ihn.', /kenne ihn nicht/i],
  ['Ich habe ein Bruder.', /einen Bruder/i],
  ['Ich möchte zu gehen.', /möchte gehen/i],
  ['Der Film war sehr interessiert.', /interessant/i],
  ['Ich freue mich auf dich zu sehen.', /darauf, dich zu sehen|freue mich, dich zu sehen|freue mich auf dich/i],
  ['Das ist der Auto von meinem Vater.', /das Auto/i],
  ['Ich wohne in eine kleine Wohnung.', /in einer kleinen Wohnung/i],
  ['Kannst du mir die Buch geben?', /das Buch/i],
  ['Er hat gesagt, dass er kommt morgen.', /dass er morgen kommt/i],
];

const natural = partner.id === 'tom' ? englishNatural : germanNatural;
const mistakes = partner.id === 'tom' ? englishMistakes : germanMistakes;
const chat = openAiCompatibleChat(values.base, values.model);
const runs = Number(values.runs);
let falseAlarms = 0;
let caught = 0;
let goodFixes = 0;

console.log(`== Correct sentences: should be "${pack.feedback?.natural}"`);
for (const sentence of natural) {
  for (let run = 0; run < runs; run++) {
    const result = await askForFeedback(sentence, pack, chat);
    if (!result.natural) {
      falseAlarms++;
      console.log(`  FALSE ALARM: ${sentence}\n    -> ${result.text}`);
    }
  }
}

console.log('\n== Sentences with a real mistake');
for (const [sentence, fix] of mistakes) {
  for (let run = 0; run < runs; run++) {
    const result = await askForFeedback(sentence, pack, chat);
    if (!result.natural) caught++;
    if (fix.test(result.text)) goodFixes++;
    if (run === 0) console.log(`  ${result.natural ? 'MISSED' : fix.test(result.text) ? 'fixed ' : 'other '}: ${sentence}\n    -> ${result.text}`);
  }
}

const total = (list: unknown[]) => list.length * runs;
console.log(`\nFalse alarms on correct sentences: ${falseAlarms}/${total(natural)} (${((100 * falseAlarms) / total(natural)).toFixed(0)}%)`);
console.log(`Mistakes noticed: ${caught}/${total(mistakes)}; with the expected fix: ${goodFixes}/${total(mistakes)}`);
