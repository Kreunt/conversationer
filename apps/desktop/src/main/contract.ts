import type { CefrLevel, TurnState } from '../../../../packages/engine/src/index.ts';

/** Everything the window can ask for. */
export interface DesktopApi {
  speech(kind: 'start' | 'end'): void;
  done(): void;
  stop(): void;
  sendText(text: string): void;
  acceptSetup(): void;
  setLevel(level: CefrLevel): void;
  sendAudio(wav: ArrayBuffer): void;
  playbackStarted(): void;
  playbackFinished(): void;
  on(listener: (event: ToWindow) => void): void;
}

export type ToWindow =
  | { type: 'loading'; message: string }
  | { type: 'ready' }
  | { type: 'setup_needed'; gigabytes: number }
  | { type: 'setup_progress'; doneGb: number; totalGb: number }
  | { type: 'setup_failed'; message: string; detail: string }
  | { type: 'failed'; message: string }
  | { type: 'state'; state: TurnState }
  | { type: 'said'; speaker: 'user' | 'persona'; text: string; continues?: boolean }
  | { type: 'audio'; wav: ArrayBuffer; text: string }
  | { type: 'play' }
  | { type: 'reply_complete' }
  | { type: 'stop_playback' }
  | { type: 'need_audio' }
  | { type: 'clear_audio' }
  | { type: 'notice'; message: string }
  | { type: 'hint'; show: boolean };
