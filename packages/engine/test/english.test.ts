import { describe, expect, it } from 'vitest';
import { english, tom } from '../../../languages/en/index.ts';
import { partners } from '../../../languages/partners.ts';
import { askForFeedback, checkSentence, chooseDirection, cleanTranscript, generateTurn, markChanges } from '../src/index.ts';
import type { ChatStream, Turn } from '../src/index.ts';

const user = (text: string): Turn => ({ speaker: 'user', text });
const direct = (history: Turn[]) => chooseDirection({ history, level: 'B2', pack: english, hasCallback: false, hasPersonaEvent: true });

function scripted(...replies: string[]): ChatStream & { calls: () => number } {
  let calls = 0;
  const chat = async function* () {
    const reply = replies[Math.min(calls++, replies.length - 1)] ?? '';
    for (let i = 0; i < reply.length; i += 5) yield reply.slice(i, i + 5);
  };
  return Object.assign(chat, { calls: () => calls });
}

describe('English: what counts as a question', () => {
  it.each([
    'Who is Raj?',
    'what do you teach',
    'So where did you grow up',
    'Do you like football',
    'Have you ever been to Berlin',
    'I had a long day. And you?',
    'What about you',
    'You said you were free tonight',
    'but you work at a school, right',
    'How was your weekend',
  ])('answers: %s', (text) => {
    expect(direct([user(text)]).move).toBe('answer');
  });

  it.each([
    'I know what you mean.',
    'What a day it has been.',
    'How nice of you to say that.',
    'I went to the place where I grew up.',
    'I think you should try it.',
    'It was the best film I have seen this year.',
  ])('does not treat a statement as a question: %s', (text) => {
    expect(direct([user(text)]).move).not.toBe('answer');
  });

  it.each([
    ['Are you a real person?', 'honest_answer'],
    ['are you an AI', 'honest_answer'],
    ['I want to die', 'care'],
    ['Okay, thanks, bye!', 'farewell'],
    ['I have to go now', 'farewell'],
  ] as const)('recognises %s', (text, move) => {
    expect(direct([user(text)]).move).toBe(move);
  });

  it('keeps talking after a short acknowledgement', () => {
    const history = [user('I live in Leeds.'), { speaker: 'persona' as const, text: 'Oh, nice.', move: 'react_and_share' as const }, user('Yeah, fair enough.')];
    expect(direct(history)).toMatchObject({ move: 'react_and_share', tellStory: true });
  });
});

describe('English guards', () => {
  const check = (sentence: string) => checkSentence(sentence, { pack: english, level: 'C1', recentOpeners: [], isFirstSentence: true });

  it.each([
    'Let me know if you need anything else.',
    'Feel free to ask me anything.',
    'Is there anything else I can help with?',
    'I hope this helps!',
    'As an AI, I don’t have hobbies.',
    'Great question!',
  ])('removes assistant-speak: %s', (sentence) => {
    expect(check(sentence)).toContain('closing_phrase');
  });

  it.each(['I’m a real person, honestly.', 'I am not an AI.'])('refuses to claim to be human: %s', (sentence) => {
    expect(check(sentence)).toContain('human_claim');
  });

  it.each([
    'Let’s see what happens on Thursday.',
    'I actually helped Raj move house last year.',
    'Honestly, I’ve been absolutely shattered all week.',
    'I hope it doesn’t rain at the weekend.',
  ])('keeps ordinary chat: %s', (sentence) => {
    expect(check(sentence)).toEqual([]);
  });

  it('notices a slip into German', () => {
    expect(check('Ich bin heute sehr müde.')).toContain('foreign_language');
  });
});

describe('English speech recognition clean-up', () => {
  it.each(['Thank you.', 'Thanks for watching!', 'you', '[Music]', '(upbeat music)'])('treats "%s" as nothing said', (text) => {
    expect(cleanTranscript(text, english.phantomTranscripts)).toBe('');
  });

  it('keeps a real thank-you', () => {
    expect(cleanTranscript('Thank you, that was really kind.', english.phantomTranscripts)).toBe('Thank you, that was really kind.');
  });
});

describe('English: does this sound unfinished?', () => {
  it.each(['I went to the', 'I was thinking about', 'Because', 'I really want to', 'um', ''])('unfinished: "%s"', (text) => {
    expect(english.soundsUnfinished(text)).toBe(true);
  });

  it.each(['I went to the shops.', 'Yeah, definitely', 'It was brilliant', 'I can'])('finished: "%s"', (text) => {
    expect(english.soundsUnfinished(text)).toBe(false);
  });
});

describe('Tom', () => {
  it('answers a question without turning it back, in English', async () => {
    const result = await generateTurn({
      history: [user('What do you teach?')],
      level: 'B2',
      pack: english,
      persona: tom,
      memory: {},
      chat: scripted('Geography, for eight years now. What do you do?'),
    });
    expect(result.reply).toBe('Geography, for eight years now.');
  });

  it('has the levels, voice and language the app needs', () => {
    const partner = partners.find((p) => p.id === 'tom');
    expect(partner?.levels.map((l) => l.level)).toEqual(['B2', 'C1']);
    expect(partner?.speech).toEqual({ whisperLanguage: 'en', ttsLanguage: 'english', voice: 'paul' });
  });
});

describe('askForFeedback', () => {
  it('reports a natural sentence as natural', async () => {
    expect(await askForFeedback('I went to the cinema yesterday.', english, scripted('That sounds natural.'))).toEqual({
      natural: true,
      text: 'That sounds natural.',
    });
  });

  it('keeps a suggestion to two sentences', async () => {
    const result = await askForFeedback(
      'I am living here since three years.',
      english,
      scripted('"I have been living here for three years." We use the present perfect for something still going on. Also, here is more. And more.'),
    );
    expect(result).toEqual({
      natural: false,
      text: '"I have been living here for three years." We use the present perfect for something still going on.',
      suggestion: 'I have been living here for three years.',
      reason: 'We use the present perfect for something still going on.',
    });
  });

  it('ignores a "fix" that only changes punctuation, which speech recognition decides', async () => {
    const result = await askForFeedback(
      'If I had more time I would learn to cook properly.',
      english,
      scripted('"If I had more time, I would learn to cook properly." You just need a comma after the introductory clause.'),
    );
    expect(result).toEqual({ natural: true, text: 'That sounds natural.' });
  });

  it('treats an empty reply as natural rather than inventing a problem', async () => {
    expect((await askForFeedback('Fine, thanks.', english, scripted(''))).natural).toBe(true);
  });

  it('is only offered where a pack provides it', async () => {
    const { german } = await import('../../../languages/de/index.ts');
    await expect(askForFeedback('Hallo', { ...german, feedback: undefined }, scripted('x'))).rejects.toThrow();
  });

  it('works for German, ignoring capitals that speech recognition decides', async () => {
    const { german } = await import('../../../languages/de/index.ts');
    expect(await askForFeedback('ich habe einen bruder.', german, scripted('"Ich habe einen Bruder." Nouns take a capital letter.'))).toEqual({
      natural: true,
      text: 'That sounds natural.',
    });
    // German shows only the correction: its reasons were wrong too often to teach from.
    const fixed = await askForFeedback('Ich bin müde, weil ich bin krank.', german, scripted('"Ich bin müde, weil ich krank bin." You don\'t need to repeat the verb.'));
    expect(fixed).toEqual({ natural: false, text: '“Ich bin müde, weil ich krank bin.”', suggestion: 'Ich bin müde, weil ich krank bin.' });
  });
});

describe('markChanges', () => {
  const changed = (said: string, suggestion: string) =>
    markChanges(said, suggestion)
      .filter((s) => s.changed)
      .map((s) => s.text);

  it('marks a corrected word', () => {
    expect(changed('Ich habe gegangen zum Arzt.', 'Ich bin zum Arzt gegangen.')).toEqual(['bin', 'gegangen.']);
  });

  it('marks one of two swapped words, which is what word-order mistakes look like', () => {
    const marked = changed('Am Wochenende ich fahre zu meinen Eltern.', 'Am Wochenende fahre ich zu meinen Eltern.');
    expect(marked).toHaveLength(1);
    expect(['fahre', 'ich']).toContain(marked[0]);
  });

  it('marks an added word', () => {
    expect(changed('Ich interessiere für Musik.', 'Ich interessiere mich für Musik.')).toEqual(['mich']);
  });

  it('ignores differences in capitals and punctuation, which speech recognition decides', () => {
    expect(changed('ich habe einen bruder', 'Ich habe einen Bruder.')).toEqual([]);
  });

  it('keeps every word of the suggestion, in order, with its spacing', () => {
    const suggestion = 'I have been living here for three years.';
    expect(
      markChanges('I am living here since three years.', suggestion)
        .map((s) => s.text)
        .join(''),
    ).toBe(suggestion);
  });
});
