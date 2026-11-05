import type { CefrLevel, TurnState } from '../../../../packages/engine/src/index.ts';

/** Everything the window can ask for. */
export interface DesktopApi {
  speech(kind: 'start' | 'end'): void;
  done(): void;
  stop(): void;
  sendText(text: string): void;
  acceptSetup(): void;
  choosePartner(id: string): void;
  changePartner(): void;
  askFeedback(id: string, said: string): void;
  setLevel(level: CefrLevel): void;
  sendAudio(wav: ArrayBuffer): void;
  playbackStarted(): void;
  playbackFinished(): void;
  on(listener: (event: ToWindow) => void): void;
}

/** What the window needs to know about a partner. */
export interface PartnerSummary {
  id: string;
  name: string;
  language: string;
  tagline: string;
  levels: { level: CefrLevel; label: string }[];
  /** Offers "How could I say that better?" */
  feedback: boolean;
}

export type ToWindow =
  | { type: 'loading'; message: string }
  | { type: 'ready' }
  | { type: 'choose_partner'; partners: PartnerSummary[] }
  | { type: 'partner'; partner: PartnerSummary; level: CefrLevel }
  | { type: 'feedback'; id: string; natural: boolean; text: string; segments?: { text: string; changed: boolean }[]; reason?: string }
  | { type: 'setup_needed'; gigabytes: number }
  | { type: 'setup_progress'; doneGb: number; totalGb: number }
  | { type: 'setup_failed'; message: string; detail: string }
  | { type: 'failed'; message: string }
  | { type: 'state'; state: TurnState }
  | { type: 'said'; speaker: 'user' | 'persona'; text: string; continues?: boolean; id?: string }
  | { type: 'audio'; wav: ArrayBuffer; text: string }
  | { type: 'play' }
  | { type: 'reply_complete' }
  | { type: 'stop_playback' }
  | { type: 'need_audio' }
  | { type: 'clear_audio' }
  | { type: 'notice'; message: string }
  | { type: 'hint'; show: boolean };
