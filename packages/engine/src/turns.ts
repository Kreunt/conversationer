/**
 * Decides when the user has finished and the persona may speak. The rule everything else serves:
 * the persona never speaks over someone forming a sentence.
 *
 * Pure logic with time passed in, so every timing can be tested without audio.
 */

/**
 * `turn_by_turn`: the user ends their turn themselves, so the persona can't interrupt, however long
 * they pause. `patient`: the app also decides for itself, using the timers below.
 */
export type TurnMode = 'turn_by_turn' | 'patient';

export interface PatienceProfile {
  /** Silence before committing when the user sounds finished. */
  finishedMs: number;
  /** Silence before committing when they sound mid-sentence. */
  unfinishedMs: number;
  /** The most silence a pause can ever be stretched to by learning this user's habits. */
  hardLimitMs: number;
}

export const PATIENCE = {
  gentle: { finishedMs: 2500, unfinishedMs: 8000, hardLimitMs: 15000 },
  normal: { finishedMs: 1500, unfinishedMs: 5000, hardLimitMs: 10000 },
  quick: { finishedMs: 800, unfinishedMs: 3000, hardLimitMs: 6000 },
} satisfies Record<string, PatienceProfile>;

export type TurnEvent =
  | { type: 'speech_start'; at: number }
  | { type: 'speech_end'; at: number }
  /** The user pressed "I'm done". */
  | { type: 'done'; at: number }
  /** The user pressed "Moment…", to keep the turn open however long they pause. */
  | { type: 'hold'; on: boolean }
  | { type: 'transcript'; text: string }
  /** From the audio model: the chance the user has finished, judged from intonation. */
  | { type: 'end_of_turn_score'; score: number }
  | { type: 'tick'; at: number }
  /** The reply's first audio is ready to play. */
  | { type: 'reply_ready' }
  | { type: 'playback_started'; at: number }
  /** The persona speaks first, as when opening a conversation. */
  | { type: 'persona_starts' }
  /** The committed turn turned out to hold nothing, or the user stopped the reply: back to listening. */
  | { type: 'turn_discarded'; at: number }
  | { type: 'playback_finished'; at: number };

export type TurnCommand =
  /** Transcribe and generate now, but hold the audio. */
  | 'begin_speculation'
  /** The user kept talking: throw that work away. */
  | 'cancel_speculation'
  | 'commit_turn'
  | 'play_reply'
  | 'stop_playback'
  /** What the user is saying now continues their last turn rather than starting a new one. */
  | 'merge_with_previous_turn'
  | 'show_hint'
  | 'hide_hint';

export type TurnState = 'listening' | 'user_speaking' | 'paused' | 'ai_thinking' | 'ai_speaking';

export interface TurnOptions {
  mode: TurnMode;
  patience: PatienceProfile;
  /** From the language pack: does this text stop mid-sentence? */
  soundsUnfinished: (text: string) => boolean;
  /** Low-end machines only speculate when the user probably finished. */
  speculate: 'always' | 'when_finished';
}

/** Before the first word there is no timer at all. This only brings up a quiet offer of help. */
const HINT_AFTER_MS = 30_000;
/** Speech this soon after the persona starts means the user hadn't finished. */
const LATE_CONTINUATION_MS = 1500;
const FINISHED_SCORE = 0.5;
const MAX_REMEMBERED_PAUSES = 30;
const MIN_PAUSES_TO_LEARN = 5;
const LEARNED_PAUSE_MARGIN = 1.25;

export class TurnController {
  state: TurnState = 'listening';

  #options: TurnOptions;
  #listeningSince: number | undefined;
  #pauseStart = 0;
  #speculating = false;
  #replyReady = false;
  #holding = false;
  #hintShown = false;
  #transcript = '';
  #score: number | undefined;
  #playbackStart = 0;
  #midTurnPauses: number[] = [];

  constructor(options: TurnOptions) {
    this.#options = options;
  }

  handle(event: TurnEvent): TurnCommand[] {
    switch (event.type) {
      case 'speech_start':
        return this.#onSpeechStart(event.at);
      case 'speech_end':
        return this.#onSpeechEnd(event.at);
      case 'done':
        // Nothing has been said yet, so there is nothing to answer.
        return this.state === 'user_speaking' || this.state === 'paused' ? this.#commit() : [];
      case 'hold':
        this.#holding = event.on;
        return [];
      case 'transcript':
        this.#transcript = event.text;
        return [];
      case 'end_of_turn_score':
        this.#score = event.score;
        return [];
      case 'tick':
        return this.#onTick(event.at);
      case 'reply_ready':
        return this.#onReplyReady();
      case 'playback_started':
        this.#playbackStart = event.at;
        return [];
      case 'playback_finished':
        return this.#onPlaybackFinished(event.at);
      case 'persona_starts':
        this.state = 'ai_thinking';
        return [];
      case 'turn_discarded':
        this.state = 'listening';
        this.#listeningSince = event.at;
        this.#replyReady = false;
        this.#speculating = false;
        return [];
    }
  }

  #onSpeechStart(at: number): TurnCommand[] {
    const commands: TurnCommand[] = this.#hintShown ? ['hide_hint'] : [];
    this.#hintShown = false;
    switch (this.state) {
      case 'listening':
        this.#startTurn();
        break;
      case 'user_speaking':
        break;
      case 'paused':
        this.#midTurnPauses = [...this.#midTurnPauses, at - this.#pauseStart].slice(-MAX_REMEMBERED_PAUSES);
        commands.push(...this.#cancelSpeculation());
        break;
      case 'ai_thinking':
        // They were still going. Whatever was being prepared no longer fits.
        commands.push('cancel_speculation', 'merge_with_previous_turn');
        break;
      case 'ai_speaking': {
        commands.push('stop_playback');
        if (at - this.#playbackStart <= LATE_CONTINUATION_MS) commands.push('merge_with_previous_turn');
        else this.#startTurn();
        break;
      }
    }
    this.#replyReady = false;
    this.#speculating = false;
    this.state = 'user_speaking';
    return commands;
  }

  #onSpeechEnd(at: number): TurnCommand[] {
    if (this.state !== 'user_speaking') return [];
    this.state = 'paused';
    this.#pauseStart = at;
    // Each new pause is judged afresh, from what comes in for it.
    this.#score = undefined;
    return this.#maybeSpeculate();
  }

  #onTick(at: number): TurnCommand[] {
    if (this.state === 'listening') {
      this.#listeningSince ??= at;
      if (!this.#hintShown && at - this.#listeningSince >= HINT_AFTER_MS) {
        this.#hintShown = true;
        return ['show_hint'];
      }
      return [];
    }
    if (this.state !== 'paused') return [];
    const commands = this.#maybeSpeculate();
    if (this.#options.mode === 'patient' && !this.#holding && at - this.#pauseStart >= this.#patienceNow()) {
      commands.push(...this.#commit());
    }
    return commands;
  }

  #onReplyReady(): TurnCommand[] {
    if (this.state === 'ai_thinking') {
      this.state = 'ai_speaking';
      return ['play_reply'];
    }
    // Ready early from speculation: it stays silent until the user's turn is over.
    if (this.state === 'paused' && this.#speculating) this.#replyReady = true;
    return [];
  }

  #onPlaybackFinished(at: number): TurnCommand[] {
    if (this.state !== 'ai_speaking') return [];
    this.state = 'listening';
    this.#listeningSince = at;
    this.#hintShown = false;
    return [];
  }

  #commit(): TurnCommand[] {
    const commands: TurnCommand[] = ['commit_turn'];
    if (this.#replyReady) {
      this.state = 'ai_speaking';
      commands.push('play_reply');
    } else {
      this.state = 'ai_thinking';
    }
    this.#replyReady = false;
    return commands;
  }

  #startTurn(): void {
    this.#transcript = '';
    this.#score = undefined;
    this.#holding = false;
  }

  #cancelSpeculation(): TurnCommand[] {
    return this.#speculating ? ['cancel_speculation'] : [];
  }

  #maybeSpeculate(): TurnCommand[] {
    if (this.#speculating) return [];
    if (this.#options.speculate === 'when_finished' && !this.#soundsFinished()) return [];
    this.#speculating = true;
    return ['begin_speculation'];
  }

  /** Without a confident signal the persona assumes the user is still thinking. */
  #soundsFinished(): boolean {
    if (this.#options.soundsUnfinished(this.#transcript)) return false;
    return (this.#score ?? 0) >= FINISHED_SCORE;
  }

  #patienceNow(): number {
    const { finishedMs, unfinishedMs, hardLimitMs } = this.#options.patience;
    const base = this.#soundsFinished() ? finishedMs : unfinishedMs;
    return Math.min(hardLimitMs, Math.max(base, this.#learnedPause()));
  }

  /** Someone who often pauses for six seconds mid-sentence should get longer than the default. */
  #learnedPause(): number {
    if (this.#midTurnPauses.length < MIN_PAUSES_TO_LEARN) return 0;
    const sorted = this.#midTurnPauses.toSorted((a, b) => a - b);
    const longTypical = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    return longTypical * LEARNED_PAUSE_MARGIN;
  }
}
