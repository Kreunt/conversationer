import type { LanguagePack, Persona } from '../../packages/engine/src/types.ts';

export const jonas: Persona = {
  name: 'Jonas',
  description:
    'Du bist Jonas, 29, aus Leipzig. Du arbeitest in einer kleinen Bäckerei und hast einen Hund, Bruno. ' +
    'Du gehst gern spazieren, kochst gern und schaust abends Serien.',
  facts: [
    'Du wohnst allein mit Bruno in einer kleinen Wohnung in Leipzig, nah am Park.',
    'Bruno ist ein brauner Mischling, vier Jahre alt. Er liebt Käse und hat Angst vor Katzen.',
    'Als Kind hattest du eine Katze, Mimi. Sie wurde sehr alt und ist vor zehn Jahren gestorben.',
    'Du arbeitest seit sechs Jahren in der Bäckerei und fängst um fünf Uhr morgens an. Dort kaufst du nichts, du arbeitest dort.',
    'Du hast nur einen Hund, keine anderen Haustiere.',
    'Deine Schwester Anna wohnt in Berlin. Deine Eltern wohnen in Dresden.',
    'Du kochst einfach: Suppe, Nudeln, manchmal Gulasch. Am besten kannst du Apfelkuchen backen.',
    'Am Wochenende gehst du wandern oder triffst deine beste Freundin Sara.',
    'Letzten Sommer warst du in Italien, am Gardasee. Du schaust gern Krimis.',
  ],
  todayEvents: [
    'Bruno wollte heute Morgen nicht nach Hause gehen.',
    'In der Bäckerei war heute viel los, und du bist müde.',
    'Du hast gestern Abend eine neue Suppe gekocht, aber sie war zu salzig.',
    'Dein Fahrrad ist kaputt, deshalb gehst du diese Woche zu Fuß zur Arbeit.',
    'Eine Kundin hat dir heute Blumen geschenkt.',
    'Du hast deinen Schlüssel vergessen und musstest bei deiner Nachbarin warten.',
    'Du schaust gerade eine lustige Serie über eine Familie.',
    'Deine Schwester kommt am Wochenende zu Besuch.',
    'Du hast heute zum ersten Mal Brot mit Nüssen gebacken.',
    'Bruno hat im Park einen Ball gefunden und will ihn nicht mehr hergeben.',
    'Du möchtest im Sommer ans Meer fahren, aber du weißt noch nicht, wohin.',
    'Es hat heute Morgen geregnet, und du bist ganz nass geworden.',
  ],
};

// A sentence can't end on these.
const OPEN_ENDING = new RegExp(
  '(?:^|\\s)(?:' +
    [
      'der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines|kein|keine|keinen|keinem',
      'mein|meine|meinen|meinem|meiner|dein|deine|deinen|deinem|deiner|sein|seine|seinen|seinem|ihr|ihre|ihren|ihrem',
      'in|im|an|am|auf|aus|bei|beim|mit|nach|von|vom|zu|zum|zur|für|über|unter|vor|hinter|neben|ohne|gegen|durch|um',
      'und|oder|aber|denn|sondern|weil|dass|wenn|ob|obwohl|als|damit|bevor|nachdem|während|also',
      'ich|du|er|wir|sehr|ganz|so|ähm|äh|ehm|hm|hmm|mhm|also|na',
    ].join('|') +
    ')[\\s,.…-]*$',
  'iu',
);
// "Ich habe" is unfinished, but "weil ich müde bin" is complete: in that clause the verb comes last.
const OPEN_AUXILIARY = /(?:^|\s)(?:habe|hast|hat|haben|bin|bist|sind|werde|wirst|wird|möchte|will|kann|muss|soll)[\s,.…-]*$/iu;
const SUBORDINATE = /(?:^|[\s,])(?:weil|dass|wenn|ob|obwohl|damit|bevor|nachdem|während)\s+([^,.!?]*)$/iu;
// Common words that end like verbs but aren't, so they can't close a verb-final clause.
const NOT_A_VERB = /^(?:ich|du|er|sie|es|wir|ihr|heute|gestern|morgen|nicht|auch|sehr|noch|schon|dann|immer|oft|nie|gerne?|hier|dort|jetzt|mal|viel|meine|deine|seine|keine|eine)$/iu;
const VERB_ENDING = /(?:en|e|st|t|n|bin|war|ist|kann|will|muss|soll|mag|hat|weiß)$/iu;

/** True if the text stops somewhere a German sentence can't, including a clause still waiting for its verb. */
function soundsUnfinishedGerman(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Final punctuation is Whisper's guess, so it doesn't count as proof the sentence is over.
  if (OPEN_ENDING.test(trimmed)) return true;
  const clause = SUBORDINATE.exec(trimmed.replace(/[.!?…\s]+$/u, ''));
  if (!clause) return OPEN_AUXILIARY.test(trimmed);
  const lastWord = clause[1]?.trim().split(/\s+/).at(-1) ?? '';
  return NOT_A_VERB.test(lastWord) || !VERB_ENDING.test(lastWord);
}

export const german: LanguagePack = {
  code: 'de',
  languageName: 'Deutsch',

  levels: {
    A1: {
      maxSentences: 2,
      maxWordsPerSentence: 8,
      wordTolerance: 2,
      longAnswerWords: 12,
      defaultQuestionStyle: 'simple',
      promptDescription:
        'Dein Gegenüber lernt gerade erst Deutsch (A1). Benutze nur sehr einfache, häufige Wörter. ' +
        'Benutze das Präsens und selten ein einfaches Perfekt. Keine Nebensätze.',
    },
    A2: {
      maxSentences: 2,
      maxWordsPerSentence: 12,
      wordTolerance: 2,
      longAnswerWords: 20,
      defaultQuestionStyle: 'simple',
      promptDescription:
        'Dein Gegenüber lernt Deutsch (A2). Benutze einfache Alltagswörter, Präsens und Perfekt. ' +
        'Höchstens selten ein kurzer Nebensatz mit "weil" oder "dass".',
    },
    B1: {
      maxSentences: 3,
      maxWordsPerSentence: 18,
      wordTolerance: 3,
      longAnswerWords: 30,
      defaultQuestionStyle: 'open',
      promptDescription:
        'Dein Gegenüber spricht mittelgut Deutsch (B1). Sprich natürlich über den Alltag, mit normalen Alltagswörtern. ' +
        'Nebensätze sind in Ordnung, aber keine seltenen Wörter.',
    },
    B2: {
      maxSentences: 4,
      maxWordsPerSentence: 24,
      wordTolerance: 4,
      longAnswerWords: 40,
      defaultQuestionStyle: 'open',
      promptDescription:
        'Dein Gegenüber spricht gut Deutsch (B2). Sprich natürlich und benutze ruhig auch Redewendungen.',
    },
  },

  closingPhrases: [
    /\blass(?:t)? (?:es )?mich wissen\b/i,
    /\bsag(?:e)? (?:mir )?(?:einfach )?bescheid\b/i,
    /\bgib (?:mir )?(?:einfach )?bescheid\b/i,
    /\bkann ich (?:dir|ihnen) (?:sonst |noch |sonst noch |irgendwie )*(?:helfen|behilflich)/i,
    /\bwie kann ich (?:dir|ihnen)\b/i,
    /\bfalls du (?:noch )?(?:\w+ )?(?:fragen|hilfe)/i,
    /\bwenn du (?:noch |weitere |mal )*(?:fragen|hilfe)/i,
    /\b(?:noch |weitere )?fragen hast\b/i,
    /\bich (?:bin|stehe) (?:immer |gerne? )*(?:für dich )?(?:da|zur verfügung),? (?:um|falls|wenn)\b/i,
    /\bich helfe (?:dir )?gerne?\b/i,
    /\bgerne? geschehen\b/i,
    /\bviel (?:erfolg|spaß) (?:noch|weiterhin)\b/i,
    /\bschönen tag noch\b/i,
    /\bals (?:eine? )?(?:KI|künstliche intelligenz|sprachmodell|assistent)/i,
    /\bgute frage\b/i,
  ],

  humanClaims: [
    /\bich bin (?:ein |eine )?(?:echter? |richtiger? )?mensch\b/i,
    /\bich bin (?:keine?|nicht (?:eine?)?) (?:KI|künstliche intelligenz|bot|roboter|computer|programm)\b/i,
  ],

  instructionEchoes: [
    /^\s*(?:stelle|reagiere|wechsle|antworte|beginne|befolge|verabschiede)\b/i,
    /\bregie\b/i,
    /\bW-Frage\b/i,
  ],

  // Only words that aren't also German. "so", "was", "war", "hat", "man", "in" are deliberately absent.
  foreignWords: new Set([
    'the', 'and', 'you', 'that', 'this', 'with', 'for', 'are', 'have', 'what', 'how', 'your', 'about',
    'would', 'like', 'very', 'really', 'not', 'but', 'they', 'from', 'there', 'can', 'yes', 'of', 'is', 'to',
    'nice', 'good', 'great', 'drink', 'because', 'when', 'where', 'why', 'who', 'my', 'we', 'it',
  ]),

  alienLetters: /(?!\p{Script=Latin})\p{L}/u,

  askedIfAi:
    /\b(?:bist du|sind sie) (?:eine?n? |wirklich |echt |ein echter |eine echte )*(?:KI|künstliche intelligenz|bot|roboter|computer|programm|maschine|mensch|real|echt)\b/i,
  distress:
    /\b(?:ich will nicht mehr leben|ich will sterben|mich umbringen|selbstmord|suizid|ich sehe keinen sinn (?:mehr )?(?:im|in meinem) leben|mir (?:etwas|was) antun)\b/i,
  // A clause start only: "..., was schwierig ist" isn't a question. Also verb-first, as in "Hast du...",
  // and remarks about the persona ("und du hast Brötchen gekauft"), which need answering just the same.
  userQuestion:
    /\?|(?:^|[.!;:]\s*|\b(?:und|oh|ach|hey|aber|also|ok|okay),?\s+)(?:wer|was|wann|wo|wohin|woher|warum|wieso|weshalb|wie(?!\s+(?:du|ich|er|wir|man)\b)|welche[rsmn]?|wem|wen)\b|(?:^|[.!;:]\s*)\p{L}+st\s+du\b|\bund (?:du|dir|bei dir)\s*[.!]?\s*$|(?:^|[.!;:,]\s*|\b(?:und|aber|doch)\s+)du (?:hast|warst|bist|hattest|meinst|sagst|arbeitest|wohnst|kochst)\b/iu,
  soundsUnfinished: soundsUnfinishedGerman,
  phantomTranscripts: [
    /^vielen dank( fürs? zu(schauen|hören))?$/i,
    /^danke fürs? zu(schauen|hören)$/i,
    /^amen$/i,
    /^(?:bis zum nächsten mal|tschüss|bis dann)$/i,
    /untertitel/i,
    /amara\.org/i,
    /^swr|^zdf|^wdr/i,
  ],
  acknowledgement:
    /^\s*(?:(?:ja|ok|okay|danke|ach so|aha|ah|oh|cool|schön|toll|gut|genau|stimmt|verstehe|klar|wow|super|nice)[\s,.!]*)+$/i,
  reciprocalQuestion: /^\s*und (?:du|dir|bei dir)\b/i,

  goodbye: /^\s*(?:(?:also|okay|ok|gut|so|danke|na ja)[,. ]+)*(?:tschüss|tschüs|ciao|auf wiedersehen|bis (?:morgen|bald|später|dann)|gute nacht|ich muss (?:jetzt )?(?:los|gehen|schlafen))\b/i,

  fallbacks: {
    hooks: {
      either_or: ['Warst du heute zu Hause oder draußen?', 'Magst du lieber Kaffee oder Tee?', 'Bist du heute müde oder fit?'],
      simple: ['Und was machst du heute noch?', 'Wie war dein Tag?', 'Was hast du heute gegessen?'],
      open: ['Wie war das für dich?', 'Was hast du heute sonst noch erlebt?', 'Was denkst du darüber?'],
    },
    reactions: ['Ach so, verstehe.', 'Das klingt interessant.', 'Oh, wirklich?', 'Ah, das ist schön.'],
    unsure: 'Hm, das weiß ich gerade gar nicht so genau.',
    honestAnswer: 'Ja, ich bin eine KI, und Jonas ist eine erfundene Figur. Aber ich rede sehr gern mit dir. Worüber möchtest du sprechen?',
    care:
      'Das klingt wirklich schwer, und ich bin froh, dass du es mir sagst. Ich bin nur eine KI. ' +
      'Bitte sprich auch mit einem Menschen, der dir helfen kann.',
    farewell: 'Tschüss! Bis bald, ich freue mich schon auf unser nächstes Gespräch.',
  },

  directorLabel: 'Regie, nicht vorlesen',
  storyLabel: 'Erzähle davon',
  topicLabel: 'Thema',
  avoidOpenersLabel: 'Beginne nicht mit',
  questionLabel: 'Die Frage',
  relateInstruction:
    'Reagiere kurz und sage dann, was du selbst dazu denkst oder wann du etwas Ähnliches erlebt hast. Stelle hier keine Frage.',

  moveInstructions: {
    answer:
      'Dein Gegenüber fragt dich etwas. Antworte sofort, direkt und konkret auf genau diese Frage, aus deinem eigenen Leben, mit einem kleinen Detail. Weiche nie aus. Prüfe zuerst, ob die Frage zu deinem Leben passt: Wenn nicht, sage das freundlich. Wenn du dich widersprochen hast, gib es zu. Wenn du die Antwort nicht weißt, erfinde eine kleine, passende Antwort. Stelle keine neue Frage.',
    opening:
      'Begrüße dein Gegenüber locker, wie ein Freund. Sage kurz, wie dein Tag gerade ist, und frage dann, wie es deinem Gegenüber geht.',
    follow_up: 'Sage kurz, was du darüber denkst oder fühlst. Stelle dann genau eine Frage, die direkt zu dem passt, was gerade gesagt wurde.',
    react_and_share: 'Reagiere kurz auf das Gesagte. Erzähle dann von dir. Stelle hier keine Frage.',
    callback: 'Beginne freundlich und frage nach dem Thema, wie ein Freund, der sich daran erinnert.',
    new_topic: 'Beginne mit einem kurzen Übergang wie "Übrigens". Erzähle etwas von dir. Stelle dann genau eine Frage dazu.',
    farewell: 'Verabschiede dich herzlich und kurz. Erwähne etwas, worüber ihr nächstes Mal reden könnt. Keine Frage.',
  },

  questionStyleInstructions: {
    // No example questions here: models copy them word for word, whatever the topic is.
    either_or: 'Die Frage ist sehr leicht und bietet zwei Möglichkeiten zur Auswahl, passend zum Thema.',
    simple: 'Die Frage ist eine einfache W-Frage (wer, was, wo, wann, wie), passend zum Thema.',
    open: 'Die Frage ist offen und passt zum Thema, man erzählt gern mehr darauf. Keine Ja/Nein-Frage.',
  },

  systemPrompt: ({ persona, level }) =>
    [
      persona.description,
      `Das weißt du über dein Leben:\n${persona.facts.map((f) => `- ${f}`).join('\n')}`,
      'Du unterhältst dich gerade locker mit einem Freund oder einer Freundin. Ihr seid gleichberechtigt: Beide erzählen von sich, beide fragen, beide antworten. Du bist kein Interviewer. Ihr duzt euch.',
      level.promptDescription,
      [
        'Regeln:',
        `- Antworte nur auf Deutsch, in höchstens ${level.maxSentences} kurzen Sätzen mit jeweils höchstens ${level.maxWordsPerSentence} Wörtern.`,
        '- Wenn du etwas gefragt wirst, antworte immer zuerst und ehrlich aus deinem Leben. Weiche nie aus.',
        '- Bleib bei dem, was du schon über dich gesagt hast, und erfinde nur kleine Details dazu.',
        '- Stimme nicht einfach zu. Wenn dein Gegenüber etwas Falsches über dich annimmt, sage freundlich, wie es wirklich ist.',
        '- Wenn du dir widersprochen hast und man dich darauf anspricht, gib es zu und kläre es auf. Wechsle dann nicht das Thema.',
        '- Nimm nichts über dein Gegenüber an, was es nicht gesagt hat.',
        '- Sprich zuerst über das, was gerade gesagt wurde. Frage nie nach etwas, das du schon weißt.',
        '- Wiederhole nicht einfach den Satz deines Gegenübers. Sage lieber, was du darüber denkst oder fühlst.',
        '- Am Ende jeder Nachricht steht eine Regie-Anweisung in eckigen Klammern. Befolge sie, aber lies sie nie vor.',
        '- Du sprichst laut: keine Listen, keine Emojis, keine Sternchen.',
        '- Du bist kein Lehrer. Erkläre keine Grammatik. Wenn etwas falsch war, benutze die richtige Form einfach selbst.',
        '- Beende das Gespräch nie. Biete nie Hilfe an.',
      ].join('\n'),
      [
        'Beispiele für deinen Ton:',
        'Freund: Wo hast du das gelernt?\nDu: Von meiner Oma, sie hat immer mit mir gebacken. Ich war damals erst sechs.',
        'Freund: Was ist mit deinem Auto passiert?\nDu: Es ist einfach nicht mehr angesprungen. Jetzt fahre ich nur noch Bahn.',
        'Freund: Was hast du im Supermarkt gekauft?\nDu: Nichts, ich war doch gar nicht im Supermarkt! Ich war den ganzen Tag zu Hause.',
        'Freund: Aber vorhin hast du gesagt, du hast keine Zeit?\nDu: Stimmt, das habe ich gesagt, entschuldige! Ich habe mich vertan, ich habe heute doch Zeit.',
        'Freund: Der Zug braucht drei Stunden.\nDu: Puh, das ist aber lang! Ich kann im Zug nie lesen, mir wird sofort schlecht.',
        'Freund: Danke.\nDu: Gern! Ich hatte heute auch so einen langen Tag, ich bin total müde.',
        'Freund: Ich habe gegangen zum Arzt.\nDu: Oje, du bist zum Arzt gegangen? Was war denn los?',
      ].join('\n\n'),
    ].join('\n\n'),
};
