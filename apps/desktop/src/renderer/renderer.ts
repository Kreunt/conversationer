import type { DesktopApi, PartnerSummary, ToWindow } from '../main/contract.ts';
import type { CefrLevel, TurnState } from '../../../../packages/engine/src/index.ts';

declare const desktop: DesktopApi;

const SAMPLE_RATE = 16_000;
/** Loud enough to be speech rather than room noise. Whisper's own gate makes the final call. */
const SPEECH_LEVEL = 0.012;
/** Sustained for this long, so a cough or a click doesn't count. */
const SPEECH_START_MS = 200;
const SPEECH_END_MS = 500;
const GIGABYTE = 1e9;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const conversation = element('conversation');
const footer = document.querySelector('footer') as HTMLElement;
const statusText = element('status');
const ring = element('ring');
const notice = element('notice');
const action = element<HTMLButtonElement>('action');
const replay = element<HTMLButtonElement>('replay');
const typing = element<HTMLFormElement>('typing');
const textInput = element<HTMLInputElement>('text');
const level = element<HTMLSelectElement>('level');
const levelLabel = element('level-label');
const levelLanguage = element('level-language');
const partnerName = element('partner-name');
const partnerLine = element('partner-line');
const changePartner = element<HTMLButtonElement>('change-partner');
const choose = element('choose');
const partnerList = element('partner-list');
const setup = element('setup');
const setupTitle = element('setup-title');
const setupText = element('setup-text');
const setupNote = element('setup-note');
const setupStatus = element('setup-status');
const setupProgress = element<HTMLProgressElement>('setup-progress');
const setupAccept = element<HTMLButtonElement>('setup-accept');
const setupDetail = element('setup-detail');

type Screen = 'choose' | 'setup' | 'talk';

function show(screen: Screen): void {
  choose.hidden = screen !== 'choose';
  setup.hidden = screen !== 'setup';
  conversation.hidden = screen !== 'talk';
  footer.hidden = screen !== 'talk';
}

let partner: PartnerSummary | undefined;
let state: TurnState | 'loading' = 'loading';
/** The learner starts their own turn, so nothing is recorded while they're still taking in what was said. */
let capturing = false;
let heardSpeech = false;

// --- Microphone: keeps everything said this turn, however long it takes.
let samples: Float32Array[] = [];
let speaking = false;
let aboveSince = 0;
let belowSince = 0;

function onMicrophone(block: Float32Array): void {
  if (!capturing || state === 'ai_speaking') return;
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

let microphoneStarted = false;

async function startMicrophone(): Promise<void> {
  if (microphoneStarted) return;
  microphoneStarted = true;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  await context.audioWorklet.addModule('capture-worklet.js');
  const capture = new AudioWorkletNode(context, 'capture');
  capture.port.onmessage = (message: MessageEvent<Float32Array>) => onMicrophone(message.data);
  context.createMediaStreamSource(stream).connect(capture);
}

function resetTurnAudio(): void {
  samples = [];
  capturing = false;
  heardSpeech = false;
  speaking = false;
  aboveSince = 0;
  belowSince = 0;
}

// --- Playback: sentences arrive one at a time and stay silent until told to play.
const playback = new AudioContext();
let queue: ArrayBuffer[] = [];
let current: AudioBufferSourceNode | undefined;
let playing = false;
let replyComplete = false;
let started = false;
/** The partner's last reply, kept so the learner can hear it again. */
let lastReply: AudioBuffer[] = [];
let replaying = false;

function playBuffer(audio: AudioBuffer, onEnded: () => void): void {
  const source = playback.createBufferSource();
  source.buffer = audio;
  source.connect(playback.destination);
  source.onended = onEnded;
  current = source;
  source.start();
}

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
  if (!started) {
    started = true;
    lastReply = [];
    desktop.playbackStarted();
  }
  lastReply.push(audio);
  playBuffer(audio, () => void playNext());
}

function stopCurrent(): void {
  if (current) {
    current.onended = null;
    current.stop();
    current = undefined;
  }
}

function stopPlayback(): void {
  queue = [];
  replyComplete = false;
  started = false;
  playing = false;
  stopCurrent();
}

function stopReplay(): void {
  if (!replaying) return;
  replaying = false;
  stopCurrent();
  render();
}

function hearAgain(): void {
  if (replaying || lastReply.length === 0) return;
  replaying = true;
  render();
  const parts = [...lastReply];
  const next = () => {
    const audio = parts.shift();
    if (!audio || !replaying) {
      replaying = false;
      render();
      return;
    }
    playBuffer(audio, next);
  };
  void playback.resume();
  next();
}

// --- What's on screen
function statusFor(name: string): string {
  if (state === 'loading') return 'Getting ready…';
  if (state === 'ai_thinking') return `${name} is thinking…`;
  if (state === 'ai_speaking') return `${name} is talking.`;
  if (replaying) return `Listening to ${name} again…`;
  if (!capturing) return 'Your turn. Take your time, then press “Start speaking”.';
  if (!heardSpeech) return `${name} is listening. Speak whenever you’re ready.`;
  return 'Still listening. Press “I’m done” when you’ve finished.';
}

function render(): void {
  const name = partner?.name ?? 'Your partner';
  statusText.textContent = statusFor(name);
  ring.className = `ring ${
    state === 'ai_speaking' ? 'speaking' : state === 'ai_thinking' ? 'thinking' : state === 'loading' || !capturing ? '' : speaking ? 'hearing' : 'listening'
  }`;
  const canStop = state === 'ai_speaking' || state === 'ai_thinking';
  const yourTurn = state === 'listening' || state === 'user_speaking' || state === 'paused';
  if (canStop) {
    action.textContent = 'Stop';
    action.dataset.role = 'stop';
  } else if (yourTurn && !capturing) {
    action.textContent = 'Start speaking';
    action.dataset.role = 'start';
  } else {
    action.textContent = 'I’m done';
    action.dataset.role = 'done';
  }
  action.disabled = state === 'loading' || (action.dataset.role === 'done' && !heardSpeech);
  replay.hidden = !(yourTurn && !capturing && lastReply.length > 0);
  replay.disabled = replaying;
}

let bubbleCount = 0;

function addBubble(speaker: 'user' | 'persona', text: string, continues?: boolean, id?: string): void {
  const last = conversation.lastElementChild;
  if (continues && last?.classList.contains('persona')) {
    last.textContent = `${last.textContent} ${text}`;
    conversation.scrollTop = conversation.scrollHeight;
    return;
  }
  const bubble = document.createElement('div');
  bubble.className = `bubble ${speaker}`;
  bubble.lang = partner?.language === 'English' ? 'en' : 'de';
  bubble.textContent = text;
  if (speaker === 'user' && partner?.feedback) {
    // Feedback only when asked for, and only about their own words.
    const wrapper = document.createElement('div');
    wrapper.className = 'said';
    wrapper.id = id ?? `said-${++bubbleCount}`;
    const ask = document.createElement('button');
    ask.className = 'ask-feedback';
    ask.textContent = 'How could I say that better?';
    ask.addEventListener('click', () => {
      ask.disabled = true;
      ask.textContent = 'Thinking…';
      desktop.askFeedback(wrapper.id, text);
    });
    wrapper.append(bubble, ask);
    conversation.append(wrapper);
  } else {
    conversation.append(bubble);
  }
  conversation.scrollTop = conversation.scrollHeight;
}

function showFeedback(id: string, text: string, segments?: { text: string; changed: boolean }[], reason?: string): void {
  const wrapper = document.getElementById(id);
  if (!wrapper) return;
  wrapper.querySelector('.ask-feedback')?.remove();
  const note = document.createElement('div');
  note.className = 'feedback';
  if (segments) {
    // The better version, with what changed highlighted, so it's clear without an explanation.
    const label = document.createElement('span');
    label.textContent = 'Try: ';
    const suggestion = document.createElement('span');
    suggestion.lang = partner?.language === 'English' ? 'en' : 'de';
    suggestion.append(
      ...segments.map((segment) => {
        if (!segment.changed) return document.createTextNode(segment.text);
        const mark = document.createElement('mark');
        mark.textContent = segment.text;
        return mark;
      }),
    );
    note.append(label, '“', suggestion, '”');
    if (reason) note.append(document.createElement('br'), reason);
  } else {
    note.textContent = text;
  }
  wrapper.append(note);
}

function showPartner(next: PartnerSummary, chosen: CefrLevel): void {
  const changed = partner?.id !== next.id;
  partner = next;
  partnerName.textContent = next.name;
  partnerLine.textContent = `your AI ${next.language} conversation partner`;
  levelLanguage.textContent = next.language;
  level.replaceChildren(...next.levels.map(({ level: value, label }) => new Option(label, value, false, value === chosen)));
  levelLabel.hidden = false;
  changePartner.hidden = false;
  textInput.lang = next.language === 'English' ? 'en' : 'de';
  if (changed) {
    conversation.replaceChildren();
    lastReply = [];
    notice.textContent = '';
  }
}

function showChooser(partners: PartnerSummary[]): void {
  partnerList.replaceChildren(
    ...partners.map((option) => {
      const card = document.createElement('button');
      card.className = 'partner-card';
      const name = document.createElement('strong');
      name.textContent = `${option.name}: ${option.language}`;
      const line = document.createElement('span');
      line.textContent = option.tagline;
      card.append(name, line);
      card.addEventListener('click', () => {
        stopPlayback();
        stopReplay();
        resetTurnAudio();
        state = 'loading';
        show('talk');
        render();
        desktop.choosePartner(option.id);
      });
      return card;
    }),
  );
  show('choose');
}

function size(gigabytes: number): string {
  return gigabytes < 1 ? `${Math.ceil(gigabytes * 10) * 100} MB` : `${Math.ceil(gigabytes)} GB`;
}

function act(): void {
  if (action.disabled) return;
  if (action.dataset.role === 'stop') {
    desktop.stop();
  } else if (action.dataset.role === 'start') {
    stopReplay();
    resetTurnAudio();
    capturing = true;
    notice.textContent = '';
    render();
  } else {
    // Done means done: a cough or an "hmm" afterwards mustn't become part of the turn.
    capturing = false;
    speaking = false;
    desktop.done();
    render();
  }
}

desktop.on((event: ToWindow) => {
  switch (event.type) {
    case 'choose_partner':
      showChooser(event.partners);
      break;
    case 'partner':
      showPartner(event.partner, event.level);
      render();
      break;
    case 'loading':
      show('talk');
      state = 'loading';
      statusText.textContent = event.message;
      break;
    case 'setup_needed': {
      show('setup');
      const name = partner?.name ?? 'Your partner';
      setupTitle.textContent = `Before you meet ${name}`;
      // 7.4 GB took about 9 minutes on a fast home connection.
      const wait = event.gigabytes >= 3 ? 'around 10 to 30 minutes' : event.gigabytes >= 1 ? 'a few minutes' : 'a minute or two';
      setupText.textContent = `${name} needs a one-time download of about ${size(event.gigabytes)}. On a fast connection that takes ${wait}.`;
      setupNote.textContent = `${name} is an AI, not a real person. Everything runs on this computer, so your conversations stay here, and after this download it works without the internet.`;
      setupAccept.textContent = 'Start download';
      setupAccept.hidden = false;
      setupProgress.hidden = true;
      setupStatus.textContent = '';
      setupDetail.hidden = true;
      break;
    }
    case 'setup_progress':
      show('setup');
      setupDetail.hidden = true;
      setupAccept.hidden = true;
      setupProgress.hidden = false;
      setupProgress.value = event.totalGb > 0 ? event.doneGb / event.totalGb : 1;
      setupStatus.textContent = `Downloading: ${event.doneGb.toFixed(1)} of ${event.totalGb.toFixed(1)} GB. You can use your computer as usual.`;
      break;
    case 'setup_failed':
      show('setup');
      setupStatus.textContent = event.message;
      setupDetail.textContent = `Details: ${event.detail}`;
      setupDetail.hidden = false;
      setupAccept.textContent = 'Try again';
      setupAccept.hidden = false;
      break;
    case 'ready':
      show('talk');
      notice.textContent = '';
      void startMicrophone().catch(() => {
        notice.textContent = 'I can’t hear you: please allow microphone access. You can also type below.';
      });
      break;
    case 'failed':
      show('talk');
      statusText.textContent = event.message;
      break;
    case 'state':
      if (event.state === 'ai_thinking') notice.textContent = '';
      state = event.state;
      render();
      break;
    case 'said':
      addBubble(event.speaker, event.text, event.continues, event.id);
      break;
    case 'feedback':
      showFeedback(event.id, event.text, event.segments, event.reason);
      break;
    case 'audio':
      queue.push(event.wav);
      if (started && !playing) void playNext();
      break;
    case 'play':
      stopReplay();
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
      resetTurnAudio();
      render();
      break;
    case 'notice':
      notice.textContent = event.message;
      break;
    case 'hint':
      notice.textContent = event.show && !capturing ? 'Not sure what to say? Press “Hear again”, or simply say what you think.' : '';
      break;
  }
});

action.addEventListener('click', act);
replay.addEventListener('click', hearAgain);
changePartner.addEventListener('click', () => desktop.changePartner());
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && document.activeElement !== textInput && !footer.hidden) {
    event.preventDefault();
    act();
  }
});
typing.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  stopReplay();
  desktop.sendText(text);
});
setupAccept.addEventListener('click', () => {
  setupAccept.hidden = true;
  setupStatus.textContent = 'Starting…';
  desktop.acceptSetup();
});
level.addEventListener('change', () => desktop.setLevel(level.value as CefrLevel));
render();
