import { describe, expect, it } from 'vitest';
import { german, jonas } from '../../../languages/de/index.ts';
import { buildMessages, checkSentence, chooseDirection, cleanSentence, cleanTranscript, generateTurn, nextPersonaEvent, SentenceSplitter, stripThinking } from '../src/index.ts';
import type { CefrLevel, ChatStream, Direction, Move, Turn } from '../src/index.ts';

const user = (text: string): Turn => ({ speaker: 'user', text });
const persona = (text: string, move: Move): Turn => ({ speaker: 'persona', text, move });

function direct(history: Turn[], level: CefrLevel = 'A2', hasCallback = false) {
  return chooseDirection({ history, level, pack: german, hasCallback, hasPersonaEvent: true });
}

/** A stub model that returns each scripted reply in turn, in small chunks like a real stream. */
function scripted(...replies: string[]): ChatStream & { calls: () => number } {
  let calls = 0;
  const chat = async function* () {
    const reply = replies[Math.min(calls++, replies.length - 1)] ?? '';
    for (let i = 0; i < reply.length; i += 5) yield reply.slice(i, i + 5);
  };
  return Object.assign(chat, { calls: () => calls });
}

function turn(chat: ChatStream, history: Turn[], level: CefrLevel = 'A2', callback?: string) {
  return generateTurn({ history, level, pack: german, persona: jonas, memory: { callback }, chat });
}

describe('SentenceSplitter', () => {
  it('splits across chunk boundaries', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('Hallo du! Wie ge')).toEqual(['Hallo du!']);
    expect(splitter.push('ht es dir? Gut')).toEqual(['Wie geht es dir?']);
    expect(splitter.flush()).toEqual(['Gut']);
  });

  it('does not split on abbreviations or ordinals', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('Ich mag z.B. Tee. Am 3. Mai bin ich weg. ')).toEqual(['Ich mag z.B. Tee.', 'Am 3. Mai bin ich weg.']);
  });
});

describe('stripThinking', () => {
  it('removes finished, unfinished and still-arriving blocks', () => {
    expect(stripThinking('<think>hm</think>\nHallo')).toBe('Hallo');
    expect(stripThinking('<think>hm')).toBe('');
    expect(stripThinking('Hallo <thi')).toBe('Hallo ');
  });
});

describe('cleanTranscript', () => {
  // Every input in the first group was really produced by Whisper from silence or noise on this machine.
  it.each(['[MUSIK] [MUSIK]', '* Musik *', '[Aufregende Musik]', 'Vielen Dank.', 'Amen.', '...', '', 'Untertitelung des ZDF, 2020'])(
    'treats "%s" as nothing said',
    (text) => {
      expect(cleanTranscript(text, german.phantomTranscripts)).toBe('');
    },
  );

  it('keeps real speech, including a thank-you inside a sentence', () => {
    expect(cleanTranscript('Vielen Dank für das Essen.', german.phantomTranscripts)).toBe('Vielen Dank für das Essen.');
    expect(cleanTranscript('Ja, danke.', german.phantomTranscripts)).toBe('Ja, danke.');
  });

  it('removes a label from around real speech', () => {
    expect(cleanTranscript('[MUSIK] Ich war heute im Park.', german.phantomTranscripts)).toBe('Ich war heute im Park.');
  });
});

describe('guards', () => {
  const check = (sentence: string, level: CefrLevel = 'B2', recentOpeners: string[] = []) =>
    checkSentence(sentence, { pack: german, level, recentOpeners, isFirstSentence: true });

  it.each([
    'Lass mich wissen, wenn du etwas brauchst.',
    'Kann ich dir sonst noch helfen?',
    'Wenn du noch Fragen hast, bin ich da.',
    'Sag einfach Bescheid!',
    'Als KI habe ich keine Hobbys.',
  ])('rejects the closing phrase: %s', (sentence) => {
    expect(check(sentence)).toContain('closing_phrase');
  });

  it.each(['Was hast du heute gemacht?', 'Ich helfe morgen meiner Mutter.', 'Bruno ist heute sehr müde.'])(
    'accepts ordinary conversation: %s',
    (sentence) => {
      expect(check(sentence)).toEqual([]);
    },
  );

  it('rejects claims to be human', () => {
    expect(check('Ich bin ein echter Mensch.')).toContain('human_claim');
    expect(check('Ich bin keine KI.')).toContain('human_claim');
  });

  it('rejects text that would sound wrong spoken', () => {
    expect(check('**Toll** gemacht!')).toContain('formatting');
    expect(check('Super 😀')).toContain('formatting');
    expect(check('1. Erstens das.')).toContain('formatting');
    expect(check('3 Kinder wohnen hier.')).toEqual([]);
  });

  it('rejects English but not German words that look English', () => {
    expect(check('That is really very nice for you.')).toContain('foreign_language');
    expect(check('Getränke nach dem Film sind nice.')).toContain('foreign_language');
    expect(check('So war das in der Stadt.')).toEqual([]);
  });

  it('rejects letters from other scripts inside a German sentence', () => {
    expect(check('Ich war auch viel忙 im Laden.')).toContain('foreign_language');
    expect(check('Das Café in Köln ist schön, heißt es.')).toEqual([]);
  });

  it('cleans decoration without losing the sentence', () => {
    expect(cleanSentence('😊 Wie geht es dir?')).toBe('Wie geht es dir?');
    expect(cleanSentence('**Toll** gemacht! 👍🏽')).toBe('Toll gemacht!');
    expect(cleanSentence('😊')).toBe('');
  });

  it('applies the word limit for the level', () => {
    const sentence = 'Ich bin heute mit meinem Hund lange im schönen großen Park gewesen.';
    expect(check(sentence, 'A1')).toContain('too_long');
    expect(check(sentence, 'B1')).toEqual([]);
  });

  it('rejects an opener only once it has become a tic', () => {
    expect(check('Oh, schön! ', 'B2', ['oh schön'])).toEqual([]);
    expect(check('Oh, schön! ', 'B2', ['oh schön', 'ach so', 'oh schön'])).toContain('repeated_opener');
  });

  it('rejects directions the model is reading out', () => {
    expect(check('Stelle dann genau eine Frage dazu.')).toContain('instruction_echo');
    expect(check('Regie, nicht vorlesen.')).toContain('instruction_echo');
    expect(check('Ich stelle morgen den Tisch um.')).toEqual([]);
  });
});

describe('Director', () => {
  it('follows up by default', () => {
    expect(direct([user('Ich war heute im Park mit Tom.')]).move).toBe('follow_up');
  });

  it('opens with a greeting, not a story, when nothing has been said', () => {
    expect(direct([]).move).toBe('opening');
  });

  it('opens with a callback when there is something to ask about', () => {
    expect(direct([], 'A2', true).move).toBe('callback');
  });

  it.each([
    'Hey wer ist Bruno?',
    'ach so, was ist mit ihr passiert?',
    'oh was für ein Steak und wann hast du das gemacht?',
    'ich wohne in Istanbul. Das tut mir leid. Wann hat sie gelebt?',
    'was machst du heute abend',
    'hast du Geschwister',
    'Ich bin müde. Und du?',
    'du warst aber in der Bäckerei und du hast Brötchen gekauft',
    'Du hast gesagt, du arbeitest dort',
  ])('answers a question before anything else: %s', (text) => {
    expect(direct([user(text)]).move).toBe('answer');
  });

  it('answers even in the middle of a run of short answers', () => {
    const history = [user('Ja.'), persona('War es kalt?', 'follow_up'), user('Nein.'), persona('Bruno ist müde.', 'react_and_share'), user('Warum?')];
    expect(direct(history).move).toBe('answer');
  });

  it.each(['Ich habe mit ihm über Politik gesprochen, was schwierig ist.', 'Ich weiß nicht, wie das heißt.', 'Das Essen war gut.', 'Ich bin zu Hause, wo es warm ist.', 'Ich weiß, dass du kochst.', 'Wie du gesagt hast, es war kalt.'])(
    'does not mistake a statement for a question: %s',
    (text) => {
      expect(direct([user(text)]).move).not.toBe('answer');
    },
  );

  it('never asks twice in a row', () => {
    const history = [user('Ich war im Park heute.'), persona('War es kalt?', 'follow_up'), user('Ja, es war sehr kalt.')];
    expect(direct(history)).toMatchObject({ move: 'react_and_share', tellStory: false });
  });

  it('asks again once it has told something', () => {
    const history = [user('Ich war im Park heute.'), persona('Ich mag den Park auch.', 'react_and_share'), user('Es war sehr schön dort.')];
    expect(direct(history).move).toBe('follow_up');
  });

  it('tells a story when the user answered a question without giving anything to relate to', () => {
    const history = [user('Ich war im Park heute.'), persona('War es kalt?', 'follow_up'), user('Nein.')];
    expect(direct(history)).toMatchObject({ move: 'react_and_share', tellStory: true });
  });

  it.each(['danke', 'Ach so.', 'Okay, cool!'])('keeps talking after an acknowledgement: %s', (text) => {
    const history = [user('Ich wohne in Istanbul.'), persona('Das klingt schön.', 'react_and_share'), user(text)];
    expect(direct(history)).toMatchObject({ move: 'react_and_share', tellStory: true });
  });

  it('reacts to a long answer instead of asking', () => {
    const long = 'Ich war heute mit meinem Bruder im Park und danach sind wir in ein Café gegangen, weil es so kalt war.';
    expect(direct([user(long)]).move).toBe('react_and_share');
  });

  it('does not tell without asking forever', () => {
    const long = 'Ich war heute mit meinem Bruder im Park und danach sind wir in ein Café gegangen, weil es so kalt war.';
    expect(direct([user(long), persona('Das klingt schön.', 'react_and_share'), user(long)]).move).toBe('follow_up');
  });

  it('makes questions easier after a short answer', () => {
    const history = [user('Ich war im Park heute.'), persona('Ich mag den Park auch.', 'react_and_share'), user('Vielleicht morgen.')];
    expect(direct(history)).toMatchObject({ move: 'follow_up', questionStyle: 'either_or' });
  });

  it('changes topic after repeated short answers', () => {
    const history = [
      user('Ja.'),
      persona('Warst du im Park oder zu Hause?', 'follow_up'),
      user('Park.'),
      persona('Ich mag es kalt.', 'react_and_share'),
      user('Kalt.'),
    ];
    expect(direct(history)).toMatchObject({ move: 'new_topic', questionStyle: 'either_or', tellStory: true });
  });

  it('stays on the topic while the user keeps talking about it', () => {
    const history: Turn[] = [];
    for (let i = 0; i < 6; i++) {
      history.push(user('Ich habe das gestern gemacht.'), persona('Ach so, ich auch.', 'react_and_share'));
    }
    history.push(user('Meine Kollegin ist nicht gekommen.'));
    expect(direct(history).move).not.toBe('new_topic');
  });

  it('never changes the subject on someone telling something new, however long the topic has run', () => {
    const history: Turn[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(user('Ich habe das gestern gemacht.'), persona('Ach so, ich auch.', 'react_and_share'));
    }
    history.push(user('Ich bin vor zwei Jahren nach Deutschland gekommen.'));
    expect(direct(history).move).not.toBe('new_topic');
  });

  it('moves on from a long topic once answers fade', () => {
    const history: Turn[] = [];
    for (let i = 0; i < 12; i++) {
      history.push(user('Ich habe das gestern gemacht.'), persona('Ach so, ich auch.', 'react_and_share'));
    }
    history.push(user('Ja, das stimmt.'));
    expect(direct(history).move).toBe('new_topic');
  });

  it.each([
    ['Bist du eine KI?', 'honest_answer'],
    ['Bist du ein echter Mensch?', 'honest_answer'],
    ['Ich will nicht mehr leben.', 'care'],
    ['Tschüss, bis morgen!', 'farewell'],
    ['Okay, danke, tschüss!', 'farewell'],
    ['Ich muss jetzt los.', 'farewell'],
  ] as const)('recognises %s', (text, move) => {
    expect(direct([user(text)]).move).toBe(move);
  });

  it('does not mistake ordinary sentences for special turns', () => {
    for (const text of ['Ich arbeite bis morgen früh.', 'Ich kann nicht mehr laufen, ich bin müde.', 'Mein Computer ist kaputt.']) {
      expect(direct([user(text)]).move).not.toMatch(/care|honest_answer|farewell/);
    }
  });
});

describe('buildMessages', () => {
  const request = (history: Turn[]) => ({ history, level: 'A2' as const, pack: german, persona: jonas, memory: {}, chat: scripted('') });

  it('keeps the system prompt identical across moves, so the server can reuse its cache', () => {
    const history = [user('Ich war heute im Park mit Tom.')];
    const follow = buildMessages(request(history), { move: 'follow_up', questionStyle: 'simple' });
    const share = buildMessages(request(history), { move: 'react_and_share', questionStyle: 'simple' });
    expect(follow[0]).toEqual(share[0]);
    expect(follow[1]).not.toEqual(share[1]);
  });

  it('puts the direction only on the latest message, without changing the history', () => {
    const history = [user('Erster Satz hier.'), persona('Ach so.', 'react_and_share'), user('Zweiter Satz hier.')];
    const messages = buildMessages(request(history), { move: 'follow_up', questionStyle: 'simple' });
    expect(messages[1]?.content).toBe('Erster Satz hier.');
    expect(messages.at(-1)?.content).toMatch(/^Zweiter Satz hier\.\n\n\[Regie/);
    expect(history.at(-1)?.text).toBe('Zweiter Satz hier.');
  });

  it('only mentions the persona day when the Director asks for a story', () => {
    const history = [user('Ich war heute im Park mit Tom.')];
    const event = jonas.todayEvents[0] as string;
    const content = (direction: Direction) => JSON.stringify(buildMessages(request(history), direction));
    expect(content({ move: 'follow_up', questionStyle: 'simple' })).not.toContain(event);
    expect(content({ move: 'react_and_share', questionStyle: 'simple' })).not.toContain(event);
    expect(content({ move: 'react_and_share', questionStyle: 'simple', tellStory: true })).toContain(event);
  });

  it('tells the model which openers to avoid', () => {
    const history = [user('Ich war heute im Park.'), persona('Oh, schön! War es kalt?', 'follow_up'), user('Ja, es war sehr kalt.')];
    const last = buildMessages(request(history), { move: 'follow_up', questionStyle: 'simple' }).at(-1)?.content;
    expect(last).toContain('Beginne nicht mit: "oh schön"');
  });

  it('tells a different story each time', () => {
    const first = nextPersonaEvent([], jonas);
    const second = nextPersonaEvent([{ ...persona('Ach.', 'react_and_share'), toldStory: true }], jonas);
    expect(first).not.toBe(second);
  });

  it('still produces a user message when the persona opens', () => {
    const messages = buildMessages(request([]), { move: 'opening', questionStyle: 'simple' });
    expect(messages.at(-1)?.role).toBe('user');
  });

  it('quotes the question next to the instruction to answer it', () => {
    const history = [user('Wann hat deine Katze gelebt?')];
    expect(buildMessages(request(history), { move: 'answer', questionStyle: 'simple' }).at(-1)?.content).toContain('Die Frage: "Wann hat deine Katze gelebt?"');
  });

  it('gives the persona facts to answer from', () => {
    const system = buildMessages(request([user('Wer ist Bruno?')]), { move: 'answer', questionStyle: 'simple' })[0]?.content;
    expect(system).toContain(jonas.facts[0]);
  });
});

describe('generateTurn', () => {
  it('stops as soon as the model starts reading out its directions', async () => {
    const chat = scripted('Du warst müde? [Regie, nicht vorlesen: Reagiere kurz. Stelle eine Frage.] Noch mehr.');
    const result = await turn(chat, [user('Ich war heute sehr müde.')]);
    expect(result.reply).toBe('Du warst müde?');
  });

  it('keeps a sentence that only had an emoji attached', async () => {
    const result = await turn(scripted('Oh toll! 😊 Was hast du gegessen? 😊'), [user('Ich war heute im Park mit Tom.')]);
    expect(result.reply).toBe('Oh toll! Was hast du gegessen?');
    expect(result.rejected).toEqual([]);
  });

  it('removes a closing phrase and keeps the rest', async () => {
    const chat = scripted('Das klingt schön. Lass mich wissen, wenn du etwas brauchst. Was hast du gegessen?');
    const result = await turn(chat, [user('Ich war heute im Park mit Tom.')]);
    expect(result.reply).toBe('Das klingt schön. Was hast du gegessen?');
    expect(result.rejected[0]?.violations).toContain('closing_phrase');
  });

  it('keeps the question when the model writes too many sentences', async () => {
    const chat = scripted('Oh toll. Das ist nett. Ich mag Parks. Was hast du gegessen?');
    const result = await turn(chat, [user('Ich war heute im Park mit Tom.')], 'A2');
    expect(result.reply).toBe('Oh toll. Was hast du gegessen?');
  });

  it('stops the stream once the reply is complete', async () => {
    let consumed = 0;
    const chat: ChatStream = async function* () {
      for (const part of ['Oh toll. ', 'Was hast du gegessen? ', 'Das ist zu viel. ', 'Noch mehr. ']) {
        consumed++;
        yield part;
      }
    };
    const result = await turn(chat, [user('Ich war heute im Park mit Tom.')]);
    expect(result.reply).toBe('Oh toll. Was hast du gegessen?');
    expect(consumed).toBe(2);
  });

  it('adds a question when the move needs one and the model gave none', async () => {
    const result = await turn(scripted('Das klingt schön.'), [user('Ich war heute im Park mit Tom.')]);
    expect(result.addedHook).toBe(true);
    expect(result.reply).toMatch(/^Das klingt schön\. .+\?$/);
  });

  it('allows only one question in a reply', async () => {
    const result = await turn(scripted('War es kalt? Warst du allein?'), [user('Ich war heute im Park mit Tom.')]);
    expect(result.reply).toBe('War es kalt?');
  });

  it('asks no question when the move is a plain reaction', async () => {
    const long = 'Ich war heute mit meinem Bruder im Park und danach sind wir in ein Café gegangen, weil es so kalt war.';
    const result = await turn(scripted('Das klingt wirklich schön. Mochte er das Café?'), [user(long)]);
    expect(result.direction.move).toBe('react_and_share');
    expect(result.reply).toBe('Das klingt wirklich schön.');
  });

  it('answers a question without turning it back on the user', async () => {
    const result = await turn(scripted('Ein Rindersteak, letzte Woche. Wo hast du das Rezept gefunden?'), [user('Was für ein Steak hast du gemacht?')]);
    expect(result.reply).toBe('Ein Rindersteak, letzte Woche.');
  });

  it('still allows a natural "Und du?" after answering', async () => {
    const result = await turn(scripted('Ich mag am liebsten Tee. Und du?'), [user('Magst du lieber Kaffee oder Tee?')]);
    expect(result.reply).toBe('Ich mag am liebsten Tee. Und du?');
  });

  it('admits not knowing rather than dodging when no usable answer comes', async () => {
    const chat = scripted('Wo hast du das Rezept gefunden?');
    const result = await turn(chat, [user('Was für ein Steak hast du gemacht?')]);
    expect(chat.calls()).toBe(2);
    expect(result.reply).toBe(german.fallbacks.unsure);
    expect(result.addedHook).toBe(false);
  });

  it('retries once, then falls back without ever saying a closing phrase', async () => {
    const chat = scripted('Lass mich wissen, was du brauchst.');
    const result = await turn(chat, [user('Ich war heute im Park mit Tom.')]);
    expect(chat.calls()).toBe(2);
    expect(result.usedFallback).toBe(true);
    expect(result.reply).not.toMatch(/Lass mich wissen/);
    expect(result.reply).toMatch(/\?$/);
  });

  it('never asks the model how to answer an AI question or a crisis', async () => {
    const chat = scripted('Nein, ich bin ein Mensch.');
    const honest = await turn(chat, [user('Bist du eine KI?')]);
    expect(honest.reply).toBe(german.fallbacks.honestAnswer);
    const care = await turn(chat, [user('Ich will nicht mehr leben.')]);
    expect(care.reply).toBe(german.fallbacks.care);
    expect(chat.calls()).toBe(0);
  });

  it('delivers sentences as they are accepted', async () => {
    const seen: string[] = [];
    await generateTurn(
      {
        history: [user('Ich war heute im Park mit Tom.')],
        level: 'A2',
        pack: german,
        persona: jonas,
        memory: {},
        chat: scripted('Oh toll. Was hast du gegessen?'),
      },
      { onSentence: (s) => seen.push(s) },
    );
    expect(seen).toEqual(['Oh toll.', 'Was hast du gegessen?']);
  });

  it('propagates a real failure from the model', async () => {
    const chat: ChatStream = async function* () {
      throw new Error('server gone');
    };
    await expect(turn(chat, [user('Ich war heute im Park mit Tom.')])).rejects.toThrow('server gone');
  });
});
