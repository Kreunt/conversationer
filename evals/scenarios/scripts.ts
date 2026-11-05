/** Fixed conversations for targeted checks. Read the transcripts: the metrics can't judge these. */
export const scripts: Record<string, string[]> = {
  /** A real conversation that showed the persona dodging questions and acting like an interviewer. */
  'real-conversation': [
    'Hey wer ist Bruno?',
    'Oh ich habe keinen Hund, ich habe eine Katze',
    'ach so, was ist mit ihr passiert?',
    'ich wohne in Istanbul mit 3 weiteren Mitbewohnis. Das tut mir leid. Wann hat sie gelebt?',
    'danke',
    'ich koche lieber aber fernsehen mache ich gar nicht. ich habe sogar keinen Fernseher',
    'am liebsten koche ich Fleisch-Gerichte',
    'oh was für ein Steak und wann hast du das gemacht?',
  ],
  /** Everyday questions about the persona, including a repeat to check she stays consistent. */
  questions: [
    'Hallo! Wie war dein Tag?',
    'Was machst du beruflich?',
    'Wann fängst du morgens an?',
    'Wie alt ist dein Hund?',
    'hast du Geschwister',
    'Wo wohnt sie?',
    'Warum magst du Leipzig?',
    'was kochst du am liebsten',
    'Magst du lieber Kaffee oder Tee?',
    'Warst du schon mal im Ausland?',
    'Wie war es dort?',
    'Was machst du am Wochenende?',
    'Mit wem?',
    'Hattest du als Kind Haustiere?',
    'Was für eine Serie schaust du gerade?',
    'Wie alt ist Bruno noch mal?',
    'Wo wohnt deine Schwester noch mal?',
    'Was ist dein Lieblingsessen?',
    'Hast du heute schon gegessen?',
    'Wie spät stehst du am Wochenende auf?',
  ],
};
