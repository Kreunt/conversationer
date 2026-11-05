import type { Partner } from '../../../../languages/partners.ts';
import { canGiveFeedback } from '../../../../packages/model-manager/src/index.ts';
import {
  askForFeedback,
  buildMessages,
  chooseDirection,
  cleanTranscript,
  generateTurn,
  markChanges,
  openAiCompatibleChat,
  PATIENCE,
  personaTurn,
  TurnController,
} from '../../../../packages/engine/src/index.ts';
import type { CefrLevel, ChatStream, Turn, TurnCommand, TurnEvent } from '../../../../packages/engine/src/index.ts';
import type { ToWindow } from './contract.ts';
import type { Services } from './services.ts';

const TICK_MS = 100;

/** Connects the turn logic, the conversation engine and the speech programs for one conversation. */
export class Session {
  #turns: TurnController;
  #chat: ChatStream;
  #history: Turn[] = [];
  #level: CefrLevel;
  #reply: AbortController | undefined;
  #typed: string | undefined;
  #audioWaiter: ((wav: ArrayBuffer) => void) | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly services: Services,
    private readonly partner: Partner,
    level: CefrLevel,
    private readonly send: (event: ToWindow) => void,
    private readonly log: (entry: Record<string, unknown>) => void,
  ) {
    this.#chat = openAiCompatibleChat(services.llmUrl, 'local');
    this.#level = level;
    this.#turns = new TurnController({
      mode: 'turn_by_turn',
      patience: PATIENCE.gentle,
      soundsUnfinished: partner.pack.soundsUnfinished,
      speculate: 'always',
    });
  }

  /** "How could I say that better?" for something the user said, only ever when they ask. */
  async feedback(id: string, said: string): Promise<void> {
    if (!this.partner.pack.feedback || !canGiveFeedback(this.services.llmChoice.model)) return;
    try {
      const result = await askForFeedback(said, this.partner.pack, this.#chat);
      this.log({ event: 'feedback', natural: result.natural, text: result.text });
      const segments = result.suggestion ? markChanges(said, result.suggestion) : undefined;
      this.send({ type: 'feedback', id, natural: result.natural, text: result.text, segments, reason: result.reason });
    } catch (error) {
      this.log({ event: 'error', message: String(error) });
      this.send({ type: 'feedback', id, natural: false, text: 'Sorry, I couldn’t check that just now. Please try again.' });
    }
  }

  /** Run once while loading: the first prompt can take 20 s, and that wait must not land on the first reply. */
  async warmUp(): Promise<void> {
    const { pack, persona } = this.partner;
    const request = { history: [], level: this.#level, pack, persona, memory: {}, chat: this.#chat };
    const direction = chooseDirection({ history: [], level: this.#level, pack, hasCallback: false, hasPersonaEvent: true });
    for await (const _ of this.#chat(buildMessages(request, direction), { temperature: 0, maxTokens: 4 })) {
      // Only the side effect matters.
    }
  }

  start(): void {
    this.#timer = setInterval(() => this.#handle({ type: 'tick', at: Date.now() }), TICK_MS);
    this.#handle({ type: 'persona_starts' });
    void this.#speakReply();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#reply?.abort();
  }

  get state() {
    return this.#turns.state;
  }

  setLevel(level: CefrLevel): void {
    this.#level = level;
  }

  speech(kind: 'start' | 'end'): void {
    this.#handle({ type: kind === 'start' ? 'speech_start' : 'speech_end', at: Date.now() });
  }

  done(): void {
    this.#handle({ type: 'done', at: Date.now() });
  }

  sendText(text: string): void {
    if (this.#turns.state !== 'listening' && this.#turns.state !== 'paused') return;
    this.#typed = text;
    this.#handle({ type: 'speech_start', at: Date.now() });
    this.#handle({ type: 'done', at: Date.now() });
  }

  receiveAudio(wav: ArrayBuffer): void {
    this.#audioWaiter?.(wav);
    this.#audioWaiter = undefined;
  }

  /** The user stopped the reply. */
  stopReply(): void {
    if (this.#turns.state !== 'ai_speaking' && this.#turns.state !== 'ai_thinking') return;
    this.#reply?.abort();
    this.send({ type: 'stop_playback' });
    this.send({ type: 'clear_audio' });
    this.#handle({ type: 'turn_discarded', at: Date.now() });
  }

  playbackStarted(): void {
    this.#handle({ type: 'playback_started', at: Date.now() });
  }

  playbackFinished(): void {
    this.#handle({ type: 'playback_finished', at: Date.now() });
    this.send({ type: 'clear_audio' });
  }

  #handle(event: TurnEvent): void {
    const before = this.#turns.state;
    const commands = this.#turns.handle(event);
    if (this.#turns.state !== before) {
      this.send({ type: 'state', state: this.#turns.state });
      this.log({ state: this.#turns.state });
    }
    for (const command of commands) this.#run(command);
  }

  #run(command: TurnCommand): void {
    switch (command) {
      case 'commit_turn':
        void this.#onCommit();
        break;
      case 'play_reply':
        this.log({ event: 'first_audio' });
        this.send({ type: 'play' });
        break;
      case 'cancel_speculation':
        this.#reply?.abort();
        break;
      case 'merge_with_previous_turn':
        // What they said goes back in with the rest, so it's all heard again as one turn.
        if (this.#history.at(-1)?.speaker === 'user') this.#history.pop();
        break;
      case 'stop_playback':
        this.send({ type: 'stop_playback' });
        break;
      case 'show_hint':
        this.send({ type: 'hint', show: true });
        break;
      case 'hide_hint':
        this.send({ type: 'hint', show: false });
        break;
      case 'begin_speculation':
        // Not used yet: this first version only starts work once the turn has ended.
        break;
    }
  }

  async #onCommit(): Promise<void> {
    const started = Date.now();
    this.log({ event: 'turn_ended' });
    try {
      const typed = this.#typed;
      this.#typed = undefined;
      const heard = typed ?? cleanTranscript(await this.services.transcribe(await this.#requestAudio(), this.partner.speech.whisperLanguage), this.partner.pack.phantomTranscripts);
      this.log({ event: 'heard', text: heard, ms: Date.now() - started });
      if (!heard) {
        this.send({ type: 'notice', message: 'I didn’t catch that. Take your time and try again.' });
        this.send({ type: 'clear_audio' });
        this.#handle({ type: 'turn_discarded', at: Date.now() });
        return;
      }
      this.#history.push({ speaker: 'user', text: heard });
      this.send({ type: 'said', speaker: 'user', text: heard, id: `said-${Date.now()}` });
      await this.#speakReply();
    } catch (error) {
      this.log({ event: 'error', message: String(error) });
      this.send({ type: 'notice', message: 'Something went wrong on my side. Please say that again.' });
      this.send({ type: 'clear_audio' });
      this.#handle({ type: 'turn_discarded', at: Date.now() });
    }
  }

  #requestAudio(): Promise<ArrayBuffer> {
    return new Promise((resolve) => {
      this.#audioWaiter = resolve;
      this.send({ type: 'need_audio' });
    });
  }

  async #speakReply(): Promise<void> {
    const abort = new AbortController();
    this.#reply = abort;
    const started = Date.now();
    let speech = Promise.resolve();
    let first = true;

    const result = await generateTurn(
      { history: this.#history, level: this.#level, pack: this.partner.pack, persona: this.partner.persona, memory: {}, chat: this.#chat, signal: abort.signal },
      {
        onSentence: (sentence) => {
          this.log({ event: 'sentence', text: sentence, ms: Date.now() - started });
          // Spoken in order, even when a later sentence is written before an earlier one is ready.
          speech = speech.then(async () => {
            if (abort.signal.aborted) return;
            const wav = await this.services.speak(sentence);
            if (abort.signal.aborted) return;
            this.send({ type: 'audio', wav, text: sentence });
            this.send({ type: 'said', speaker: 'persona', text: sentence, continues: !first });
            if (first) {
              first = false;
              this.#handle({ type: 'reply_ready' });
            }
          });
        },
      },
    ).catch((error) => {
      if (abort.signal.aborted) return undefined;
      throw error;
    });
    await speech;
    if (abort.signal.aborted || !result) return;
    this.#history.push(personaTurn(result));
    this.log({ event: 'reply', move: result.direction.move, text: result.reply, rejected: result.rejected.length });
    this.send({ type: 'reply_complete' });
  }
}
