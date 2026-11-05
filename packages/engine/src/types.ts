export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

export type Move =
  | 'answer'
  | 'opening'
  | 'follow_up'
  | 'react_and_share'
  | 'callback'
  | 'new_topic'
  | 'honest_answer'
  | 'care'
  | 'farewell';

export type QuestionStyle = 'either_or' | 'simple' | 'open';

export interface Turn {
  speaker: 'user' | 'persona';
  text: string;
  /** Set on persona turns: the move the Director chose for this turn. */
  move?: Move;
  /** Set on persona turns that told a story from the persona's day. */
  toldStory?: boolean;
}

export interface LevelRules {
  maxSentences: number;
  /** Soft word limit per sentence. The guard allows `wordTolerance` extra words. */
  maxWordsPerSentence: number;
  wordTolerance: number;
  /** An answer this long is "long": the persona reacts instead of asking. */
  longAnswerWords: number;
  defaultQuestionStyle: QuestionStyle;
  promptDescription: string;
}

export interface Persona {
  name: string;
  description: string;
  /** Fixed facts about the persona's life, so it has real answers when asked. */
  facts: string[];
  /** Things from the persona's day, available for sharing. */
  todayEvents: string[];
}

export interface Memory {
  /** A fact or open thread the persona can ask about, e.g. a job interview on Tuesday. */
  callback?: string;
}

export interface LanguagePack {
  code: string;
  languageName: string;
  levels: Record<CefrLevel, LevelRules>;
  /** Phrases that make the persona sound like an assistant ending a support ticket. */
  closingPhrases: RegExp[];
  /** Claims to be a real person, which the persona must never make. */
  humanClaims: RegExp[];
  /** Instructions meant for the model that it has started reading out. */
  instructionEchoes: RegExp[];
  /** Common words from other languages that signal the reply has left the target language. */
  foreignWords: Set<string>;
  /** Matches any letter outside the scripts this language uses. */
  alienLetters: RegExp;
  /** Detectors for turns that override normal conversation flow. */
  askedIfAi: RegExp;
  distress: RegExp;
  goodbye: RegExp;
  /** The user is asking something, with or without a question mark. */
  userQuestion: RegExp;
  /** Does this partial transcript stop mid-sentence? Used to give the speaker more time. */
  soundsUnfinished: (text: string) => boolean;
  /** Whole transcripts that speech recognition is known to invent from silence. */
  phantomTranscripts: RegExp[];
  /** Short replies that acknowledge rather than add anything: "danke", "ach so". */
  acknowledgement: RegExp;
  /** The one question allowed after answering: "Und du?" */
  reciprocalQuestion: RegExp;
  /** Hand-written replies, used when the model repeatedly fails the guards. */
  fallbacks: {
    hooks: Record<QuestionStyle, string[]>;
    reactions: string[];
    /** When the model can't produce a usable answer to a question. Never a dodge into another question. */
    unsure: string;
    /** Always used for these two moves, never generated. */
    honestAnswer: string;
    care: string;
    farewell: string;
  };
  /** Labels for the note that carries the Director's instructions to the model. */
  directorLabel: string;
  storyLabel: string;
  topicLabel: string;
  avoidOpenersLabel: string;
  questionLabel: string;
  /** Used for `react_and_share` when there is no story to tell: relate to what was just said. */
  relateInstruction: string;
  moveInstructions: Record<Exclude<Move, 'care' | 'honest_answer'>, string>;
  questionStyleInstructions: Record<QuestionStyle, string>;
  systemPrompt: (args: { persona: Persona; level: LevelRules; levelName: CefrLevel }) => string;
  /** "How could I say that better?", offered only where it has been checked to work. */
  feedback?: {
    system: string;
    /** The exact reply meaning nothing needs changing. */
    natural: string;
    request: (said: string) => string;
    /**
     * Whether to show the model's reason as well as the better version. German corrections were
     * reliable but about 3 in 20 reasons were wrong, so German shows the correction alone.
     */
    showReason: boolean;
  };
}
