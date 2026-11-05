import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron';
import type { CefrLevel } from '../../../../packages/engine/src/index.ts';
import type { ToWindow } from './contract.ts';
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
const AUTOTEST_LIMIT_MS = 240_000;
if (fakeMicrophone) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeMicrophone);
}

let services: Services | undefined;
let session: Session | undefined;
let window: BrowserWindow | undefined;
let setup: Setup | undefined;

function send(event: ToWindow): void {
  if (window && !window.isDestroyed()) window.webContents.send('to-window', event);
}

function log(entry: Record<string, unknown>): void {
  if (!logConversations) delete entry['text'];
  appendFileSync(join(logDirectory, 'session.log'), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

/** Plays out a whole conversation against the fake microphone, then saves a screenshot and quits. */
function runAutotest(active: Session): void {
  let finished = 0;
  const original = active.playbackFinished.bind(active);
  active.playbackFinished = () => {
    original();
    finished++;
    if (finished <= autotestTurns) return;
    void window?.webContents.capturePage().then((image) => {
      writeFileSync(join(logDirectory, 'autotest.png'), image.toPNG());
      log({ event: 'autotest_finished', turns: finished });
      app.quit();
    });
  };
  // A person would press the button whenever they'd finished, including over a slow reply they cut off.
  setInterval(() => active.done(), AUTOTEST_TURN_MS);
  setTimeout(() => {
    log({ event: 'autotest_timed_out', turns: finished });
    app.quit();
  }, AUTOTEST_LIMIT_MS);
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
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  await window.loadFile(join(__dirname, 'index.html'));

  // For testing: photograph the window at a moment no test log can show, like the first-run screen.
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
    send({ type: 'failed', message: 'Sorry, this computer doesn’t have enough memory to run Jonas. It needs at least 8 GB.' });
    return;
  }

  try {
    setup = new Setup(home, send, log, autotestTurns === 0);
    services = await startServices({ home, bundledSidecars }, setup, (message) => send({ type: 'loading', message }));
    log({ event: 'services_ready', model: services.llmChoice.model, device: services.llmChoice.device, whisper: services.whisperChoice });
    session = new Session(services, send, log);
    send({ type: 'loading', message: 'Jonas is almost here…' });
    const warmUpStarted = Date.now();
    await session.warmUp();
    log({ event: 'warmed_up', ms: Date.now() - warmUpStarted });
    if (autotestTurns > 0) runAutotest(session);
    send({ type: 'ready' });
    session.start();
  } catch (error) {
    log({ event: 'startup_failed', message: String(error) });
    send({ type: 'failed', message: 'Jonas couldn’t start. Please close the app and open it again.' });
  }
}

ipcMain.on('speech', (_, kind: 'start' | 'end') => session?.speech(kind));
ipcMain.on('done', () => session?.done());
ipcMain.on('stop', () => session?.stopReply());
ipcMain.on('text', (_, text: string) => session?.sendText(text));
ipcMain.on('accept-setup', () => setup?.accept());
ipcMain.on('level', (_, level: CefrLevel) => session?.setLevel(level));
ipcMain.on('audio', (_, wav: ArrayBuffer) => session?.receiveAudio(wav));
ipcMain.on('playback-started', () => session?.playbackStarted());
ipcMain.on('playback-finished', () => session?.playbackFinished());

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
