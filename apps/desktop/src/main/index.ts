import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron';
import { partnerById, partners, type Partner } from '../../../../languages/partners.ts';
import { canGiveFeedback } from '../../../../packages/model-manager/src/index.ts';
import type { CefrLevel } from '../../../../packages/engine/src/index.ts';
import type { PartnerSummary, ToWindow } from './contract.ts';
import { startServices, type Services } from './services.ts';
import { Session } from './session.ts';
import { Setup } from './setup.ts';

// Local, not roaming: this holds gigabytes of models, which shouldn't follow anyone between computers.
const home = process.env['CONVERSATIONER_HOME'] ?? join(process.env['LOCALAPPDATA'] ?? app.getPath('userData'), 'Conversationer');
// Electron's own files go in the same folder, so there's one place to look and uninstalling removes it all.
app.setPath('userData', join(home, 'electron'));
const bundledSidecars = app.isPackaged ? join(process.resourcesPath, 'sidecars') : join(home, 'sidecars');
const logDirectory = join(home, 'logs');
mkdirSync(logDirectory, { recursive: true });

// Two copies would fight over the microphone and the GPU.
if (!app.requestSingleInstanceLock()) app.quit();

/** Below this, the smallest model leaves too little for Windows. */
const MINIMUM_MEMORY_BYTES = 7e9;
// What people say stays out of the log file, unless a developer is debugging their own conversation.
const logConversations = Boolean(process.env['CONVERSATIONER_DEBUG']);

// For testing without a person: a sound file stands in for the microphone.
const fakeMicrophone = process.env['CONVERSATIONER_FAKE_MIC'];
const autotestTurns = Number(process.env['CONVERSATIONER_AUTOTEST'] ?? 0);
const AUTOTEST_TURN_MS = 9000;
const AUTOTEST_LIMIT_MS = 480_000;
/** A test can switch partner mid-session, through the same buttons a person would use. */
const autotestSwitchTo = partnerById(process.env['CONVERSATIONER_SWITCH_TO']);
let autotestSwitched = false;
let autotestRunning = false;
if (fakeMicrophone) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeMicrophone);
}

interface Settings {
  partner?: string;
  levels: Record<string, CefrLevel>;
}

const settingsPath = join(home, 'settings.json');

function loadSettings(): Settings {
  try {
    return { levels: {}, ...(JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<Settings>) };
  } catch {
    return { levels: {} };
  }
}

function saveSettings(): void {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();
let services: Services | undefined;
let session: Session | undefined;
let window: BrowserWindow | undefined;
let setup: Setup | undefined;
let partnerChosen: ((partner: Partner) => void) | undefined;

function send(event: ToWindow): void {
  if (window && !window.isDestroyed()) window.webContents.send('to-window', event);
}

function log(entry: Record<string, unknown>): void {
  if (!logConversations) delete entry['text'];
  appendFileSync(join(logDirectory, 'session.log'), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

function summary(partner: Partner): PartnerSummary {
  return {
    id: partner.id,
    name: partner.persona.name,
    language: partner.language,
    tagline: partner.tagline,
    levels: partner.levels,
    // Before the model is known, nothing is promised.
    feedback: Boolean(partner.pack.feedback) && Boolean(services && canGiveFeedback(services.llmChoice.model)),
  };
}

function levelFor(partner: Partner): CefrLevel {
  const saved = settings.levels[partner.id];
  return saved && partner.levels.some((l) => l.level === saved) ? saved : partner.defaultLevel;
}

/** Shows the chooser and waits. A test can pick through the environment instead. */
function choosePartner(): Promise<Partner> {
  const forced = partnerById(process.env['CONVERSATIONER_PARTNER']);
  if (forced) return Promise.resolve(forced);
  send({ type: 'choose_partner', partners: partners.map(summary) });
  return new Promise((resolve) => {
    partnerChosen = resolve;
  });
}

/** Plays out a whole conversation against the fake microphone, then saves a screenshot and quits. */
function runAutotest(active: Session): void {
  let finished = 0;
  const original = active.playbackFinished.bind(active);
  active.playbackFinished = () => {
    original();
    finished++;
    if (finished <= autotestTurns) return;
    if (autotestSwitchTo && !autotestSwitched) {
      autotestSwitched = true;
      log({ event: 'autotest_switching', to: autotestSwitchTo.id });
      const name = JSON.stringify(autotestSwitchTo.persona.name);
      void window?.webContents.executeJavaScript(`document.getElementById('change-partner').click()`);
      setTimeout(() => {
        void window?.webContents.executeJavaScript(
          `[...document.querySelectorAll('.partner-card')].find((card) => card.textContent.startsWith(${name}))?.click()`,
        );
      }, 1500);
      return;
    }
    void window?.webContents.capturePage().then((image) => {
      writeFileSync(join(logDirectory, 'autotest.png'), image.toPNG());
      log({ event: 'autotest_finished', turns: finished });
      app.quit();
    });
  };
  if (autotestRunning) return;
  autotestRunning = true;
  // Presses the main button as a person would: "Start speaking", then "I'm done". Never "Stop".
  setInterval(() => {
    void window?.webContents.executeJavaScript(
      `(() => { const b = document.getElementById('action'); if (!b.disabled && b.dataset.role !== 'stop') b.click(); })()`,
    );
  }, AUTOTEST_TURN_MS);
  setTimeout(() => {
    log({ event: 'autotest_timed_out', turns: finished });
    app.quit();
  }, AUTOTEST_LIMIT_MS);
}

/** Starts a conversation with a partner, switching voice if needed. */
async function meet(partner: Partner, { askForVoice }: { askForVoice: boolean }): Promise<void> {
  if (!services) throw new Error('Services not started');
  session?.stop();
  session = undefined;
  settings.partner = partner.id;
  saveSettings();
  const level = levelFor(partner);
  send({ type: 'partner', partner: summary(partner), level });
  await services.useVoice(partner.speech, { ask: askForVoice });
  const next = new Session(services, partner, level, send, log);
  send({ type: 'loading', message: `${partner.persona.name} is almost here…` });
  const warmUpStarted = Date.now();
  await next.warmUp();
  log({ event: 'warmed_up', partner: partner.id, ms: Date.now() - warmUpStarted });
  if (autotestTurns > 0) runAutotest(next);
  session = next;
  send({ type: 'ready' });
  next.start();
}

async function start(): Promise<void> {
  electronSession.defaultSession.setPermissionRequestHandler((_, permission, allow) => allow(permission === 'media'));
  window = new BrowserWindow({
    width: 880,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    title: 'Conversationer',
    autoHideMenuBar: true,
    // Keeps audio and timing steady when the window is behind another one.
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  await window.loadFile(join(__dirname, 'index.html'));

  // For testing: press the download button, or photograph moments no log can show.
  const clickAfter = Number(process.env['CONVERSATIONER_CLICK_AFTER_MS'] ?? 0);
  if (clickAfter > 0) {
    setTimeout(() => void window?.webContents.executeJavaScript(`document.getElementById('setup-accept').click()`), clickAfter);
  }
  const captureAfter = Number(process.env['CONVERSATIONER_CAPTURE_AFTER_MS'] ?? 0);
  if (captureAfter > 0) {
    setTimeout(() => {
      void window?.webContents.capturePage().then((image) => {
        writeFileSync(join(logDirectory, 'capture.png'), image.toPNG());
        app.quit();
      });
    }, captureAfter);
  }

  if (totalmem() < MINIMUM_MEMORY_BYTES) {
    send({ type: 'failed', message: 'Sorry, this computer doesn’t have enough memory to run the app. It needs at least 8 GB.' });
    return;
  }

  try {
    // Choosing first means the first download only includes the voice this person needs.
    const partner = partnerById(process.env['CONVERSATIONER_PARTNER']) ?? partnerById(settings.partner) ?? (await choosePartner());
    send({ type: 'partner', partner: summary(partner), level: levelFor(partner) });
    setup = new Setup(home, send, log, autotestTurns === 0);
    services = await startServices({ home, bundledSidecars }, setup, (message) => send({ type: 'loading', message }), partner.speech);
    log({ event: 'services_ready', model: services.llmChoice.model, device: services.llmChoice.device, whisper: services.whisperChoice });
    await meet(partner, { askForVoice: false });
  } catch (error) {
    log({ event: 'startup_failed', message: String(error) });
    send({ type: 'failed', message: 'The app couldn’t start. Please close it and open it again.' });
  }
}

ipcMain.on('speech', (_, kind: 'start' | 'end') => session?.speech(kind));
ipcMain.on('done', () => session?.done());
ipcMain.on('stop', () => session?.stopReply());
ipcMain.on('text', (_, text: string) => session?.sendText(text));
ipcMain.on('accept-setup', () => setup?.accept());
ipcMain.on('audio', (_, wav: ArrayBuffer) => session?.receiveAudio(wav));
ipcMain.on('playback-started', () => session?.playbackStarted());
ipcMain.on('playback-finished', () => session?.playbackFinished());
ipcMain.on('feedback', (_, id: string, said: string) => void session?.feedback(id, said));
ipcMain.on('level', (_, level: CefrLevel) => {
  session?.setLevel(level);
  if (settings.partner) settings.levels[settings.partner] = level;
  saveSettings();
});
ipcMain.on('change-partner', () => {
  send({ type: 'choose_partner', partners: partners.map(summary) });
});
ipcMain.on('choose-partner', (_, id: string) => {
  const partner = partnerById(id);
  if (!partner) return;
  if (partnerChosen) {
    partnerChosen(partner);
    partnerChosen = undefined;
    return;
  }
  if (!services) return;
  void meet(partner, { askForVoice: true }).catch((error) => {
    log({ event: 'switch_failed', message: String(error) });
    send({ type: 'failed', message: 'Something went wrong switching partner. Please close the app and open it again.' });
  });
});

app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});
void app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  session?.stop();
  services?.stop();
});

