import type { DesktopApi, ToWindow } from '../main/contract.ts';
import type { CefrLevel, TurnState } from '../../../../packages/engine/src/index.ts';

declare const desktop: DesktopApi;

const SAMPLE_RATE = 16_000;
/** Loud enough to be speech rather than room noise. Whisper's own gate makes the final call. */
const SPEECH_LEVEL = 0.012;
/** Sustained for this long, so a cough or a click doesn't count. */
const SPEECH_START_MS = 200;
const SPEECH_END_MS = 500;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const conversation = element('conversation');
const statusText = element('status');
const ring = element('ring');
const notice = element('notice');
const action = element<HTMLButtonElement>('action');
const typing = element<HTMLFormElement>('typing');
const textInput = element<HTMLInputElement>('text');
const level = element<HTMLSelectElement>('level');
const setup = element('setup');
const setupText = element('setup-text');
const setupStatus = element('setup-status');
const setupProgress = element<HTMLProgressElement>('setup-progress');
const setupAccept = element<HTMLButtonElement>('setup-accept');
const setupDetail = element('setup-detail');
const talking = [conversation, document.querySelector('footer') as HTMLElement];

function showSetup(show: boolean): void {
  setup.hidden = !show;
  for (const part of talking) part.hidden = show;
}

let state: TurnState | 'loading' = 'loading';
let heardSpeech = false;

// --- Microphone: keeps everything said this turn, however long it takes.
let samples: Float32Array[] = [];
let speaking = false;
let aboveSince = 0;
let belowSince = 0;

function onMicrophone(block: Float32Array): void {
  // Nothing is taken from the microphone while Jonas talks, so his own voice can't count as the user's.
  if (state === 'ai_speaking') return;
  samples.push(block);
  let energy = 0;
  for (const sample of block) energy += sample * sample;
  const loud = Math.sqrt(energy / block.length) > SPEECH_LEVEL;
  const now = performance.now();
  if (loud) {
    belowSince = 0;
    aboveSince ||= now;
    if (!speaking && now - aboveSince >= SPEECH_START_MS) {
      speaking = true;
      heardSpeech = true;
      desktop.speech('start');
      render();
    }
  } else {
    aboveSince = 0;
    belowSince ||= now;
    if (speaking && now - belowSince >= SPEECH_END_MS) {
      speaking = false;
      desktop.speech('end');
      render();
    }
  }
}

function encodeWav(blocks: Float32Array[]): ArrayBuffer {
  const length = blocks.reduce((sum, block) => sum + block.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const block of blocks) {
    for (const sample of block) {
      view.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

async function startMicrophone(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  await context.audioWorklet.addModule('capture-worklet.js');
  const capture = new AudioWorkletNode(context, 'capture');
  capture.port.onmessage = (message: MessageEvent<Float32Array>) => onMicrophone(message.data);
  context.createMediaStreamSource(stream).connect(capture);
}

// --- Playback: sentences arrive one at a time and stay silent until told to play.
const playback = new AudioContext();
let queue: ArrayBuffer[] = [];
let current: AudioBufferSourceNode | undefined;
let playing = false;
let replyComplete = false;
let started = false;

async function playNext(): Promise<void> {
  const wav = queue.shift();
  if (!wav) {
    playing = false;
    if (replyComplete) {
      replyComplete = false;
      started = false;
      desktop.playbackFinished();
    }
    return;
  }
  playing = true;
  const audio = await playback.decodeAudioData(wav);
  const source = playback.createBufferSource();
  source.buffer = audio;
  source.connect(playback.destination);
  source.onended = () => void playNext();
  current = source;
  if (!started) {
    started = true;
    desktop.playbackStarted();
  }
  source.start();
}

function stopPlayback(): void {
  queue = [];
  replyComplete = false;
  started = false;
  playing = false;
  if (current) {
    current.onended = null;
    current.stop();
    current = undefined;
  }
}

// --- What's on screen
const STATUS: Record<TurnState | 'loading', string> = {
  loading: 'Getting ready…',
  listening: 'Jonas is listening. Take your time.',
  user_speaking: 'Jonas is listening. Press “I’m done” when you’ve finished.',
  paused: 'Still listening. Take as long as you need.',
  ai_thinking: 'Jonas is thinking…',
  ai_speaking: 'Jonas is talking.',
};

function render(): void {
  statusText.textContent = STATUS[state];
  ring.className = `ring ${
    state === 'ai_speaking' ? 'speaking' : state === 'ai_thinking' ? 'thinking' : state === 'loading' ? '' : speaking ? 'hearing' : 'listening'
  }`;
  const canStop = state === 'ai_speaking' || state === 'ai_thinking';
  action.textContent = canStop ? 'Stop' : 'I’m done';
  action.disabled = state === 'loading' || (!canStop && !heardSpeech);
}

function addBubble(speaker: 'user' | 'persona', text: string, continues?: boolean): void {
  const last = conversation.lastElementChild;
  if (continues && last) {
    last.textContent = `${last.textContent} ${text}`;
  } else {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${speaker}`;
    bubble.lang = 'de';
    bubble.textContent = text;
    conversation.append(bubble);
  }
  conversation.scrollTop = conversation.scrollHeight;
}

function act(): void {
  if (action.disabled) return;
  if (state === 'ai_speaking' || state === 'ai_thinking') desktop.stop();
  else desktop.done();
}

desktop.on((event: ToWindow) => {
  switch (event.type) {
    case 'loading':
      showSetup(false);
      statusText.textContent = event.message;
      break;
    case 'setup_needed':
      showSetup(true);
      setupText.textContent = `Jonas needs a one-time download of about ${Math.ceil(event.gigabytes)} GB. A fast connection takes around 10 to 30 minutes.`;
      break;
    case 'setup_progress':
      showSetup(true);
      setupDetail.hidden = true;
      setupAccept.hidden = true;
      setupProgress.hidden = false;
      setupProgress.value = event.doneGb / event.totalGb;
      setupStatus.textContent = `Downloading: ${event.doneGb.toFixed(1)} of ${event.totalGb.toFixed(1)} GB. You can use your computer as usual.`;
      break;
    case 'setup_failed':
      showSetup(true);
      setupStatus.textContent = event.message;
      setupDetail.textContent = `Details: ${event.detail}`;
      setupDetail.hidden = false;
      setupAccept.textContent = 'Try again';
      setupAccept.hidden = false;
      break;
    case 'ready':
      showSetup(false);
      notice.textContent = '';
      void startMicrophone().catch(() => {
        notice.textContent = 'I can’t hear you: please allow microphone access. You can also type below.';
      });
      break;
    case 'failed':
      statusText.textContent = event.message;
      break;
    case 'state':
      if (event.state === 'user_speaking' || event.state === 'ai_thinking') notice.textContent = '';
      state = event.state;
      render();
      break;
    case 'said':
      addBubble(event.speaker, event.text, event.continues);
      break;
    case 'audio':
      queue.push(event.wav);
      if (started && !playing) void playNext();
      break;
    case 'play':
      void playback.resume();
      void playNext();
      break;
    case 'reply_complete':
      replyComplete = true;
      if (started && !playing) void playNext();
      break;
    case 'stop_playback':
      stopPlayback();
      break;
    case 'need_audio':
      desktop.sendAudio(encodeWav(samples));
      break;
    case 'clear_audio':
      samples = [];
      heardSpeech = false;
      speaking = false;
      aboveSince = 0;
      belowSince = 0;
      render();
      break;
    case 'notice':
      notice.textContent = event.message;
      break;
    case 'hint':
      notice.textContent = event.show ? 'Not sure what to say? Try: “Ich habe heute…”' : '';
      break;
  }
});

setupAccept.addEventListener('click', () => {
  setupAccept.hidden = true;
  setupStatus.textContent = 'Starting…';
  desktop.acceptSetup();
});
action.addEventListener('click', act);
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && document.activeElement !== textInput) {
    event.preventDefault();
    act();
  }
});
typing.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  desktop.sendText(text);
});
level.addEventListener('change', () => desktop.setLevel(level.value as CefrLevel));
render();
