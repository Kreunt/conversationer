/**
 * Builds the desktop app, sets it up in a local Windows folder, and starts it. Run from WSL.
 *
 *   npm run windows                 start the app to talk to Jonas
 *   npm run windows -- --autotest   play a conversation from a sound file, with no person, and report
 *   npm run windows -- --model 12b  try another language model (12b, qwen9b, or e4b, the default)
 *   npm run windows -- --remove     delete the Windows folder again
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

const ELECTRON_VERSION = '45.2.1';
const ELECTRON_ZIP = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const ELECTRON_URL = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
const AUTOTEST_TURNS = 2;
const KEEP_FREE_BYTES = 5e9;

const { values } = parseArgs({
  options: { autotest: { type: 'boolean', default: false }, remove: { type: 'boolean', default: false }, model: { type: 'string' } },
});

/** Models to compare by hand. Layers are set so Whisper still fits on an 8 GB card beside them. */
const COMPARISON_MODELS: Record<string, { ollama: string; file: string; gpuLayers: number }> = {
  '12b': { ollama: 'gemma4:12b-it-qat', file: 'gemma4-12b-it-qat', gpuLayers: 22 },
  qwen9b: { ollama: 'qwen3.5:9b-q4_K_M', file: 'qwen3.5-9b-q4', gpuLayers: 99 },
};

const root = join(import.meta.dirname, '..');
const windowsPath = (path: string) => execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
const localAppData = execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8', cwd: '/mnt/c' }).trim();
const home = join(execFileSync('wslpath', ['-u', localAppData], { encoding: 'utf8' }).trim(), 'conversationer-dev');

if (values.remove) {
  rmSync(home, { recursive: true, force: true });
  console.log(`Removed ${home}`);
  process.exit(0);
}

async function electron(): Promise<void> {
  const destination = join(home, 'electron');
  if (existsSync(join(destination, 'electron.exe'))) return;
  const sums = await (await fetch(`${ELECTRON_URL}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((line) => line.endsWith(ELECTRON_ZIP))?.split(' ')[0];
  if (!expected) throw new Error(`No published checksum for ${ELECTRON_ZIP}`);
  const bytes = Buffer.from(await (await fetch(`${ELECTRON_URL}/${ELECTRON_ZIP}`)).arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${ELECTRON_ZIP} doesn't match its published checksum`);
  mkdirSync(destination, { recursive: true });
  const zip = join(home, ELECTRON_ZIP);
  writeFileSync(zip, bytes);
  execFileSync('tar.exe', ['-xf', windowsPath(zip), '-C', windowsPath(destination)], { cwd: '/mnt/c' });
  rmSync(zip);
}

/** Refuses to fill the user's C: drive, which also holds WSL and the page file. */
function copyIfMissing(from: string, to: string): void {
  if (existsSync(to)) return;
  const size = statSync(from).isDirectory() ? 0 : statSync(from).size;
  const { bavail, bsize } = statfsSync(home);
  if (bavail * bsize - size < KEEP_FREE_BYTES) {
    throw new Error(`Not copying ${basename(to)}: it would leave under ${KEEP_FREE_BYTES / 1e9} GB free on C:. Free up space first.`);
  }
  cpSync(from, to, { recursive: true });
}

execFileSync('npx', ['tsx', 'scripts/build-desktop.ts'], { cwd: root, stdio: 'inherit' });
mkdirSync(home, { recursive: true });
await electron();
rmSync(join(home, 'electron/resources/app'), { recursive: true, force: true });
cpSync(join(root, 'apps/desktop/dist'), join(home, 'electron/resources/app'), { recursive: true });
for (const name of ['llama', 'whisper', 'whisper-cuda', 'pocket-tts']) copyIfMissing(join(root, 'sidecars/win', name), join(home, 'sidecars', name));
mkdirSync(join(home, 'models/llm'), { recursive: true });
// Anything else missing is downloaded by the app itself on start, just as on anyone's computer.
mkdirSync(join(home, 'logs'), { recursive: true });

// Debugging logs what was said, which is useful only when it's your own conversation.
const env: NodeJS.ProcessEnv = { ...process.env, CONVERSATIONER_HOME: windowsPath(home), CONVERSATIONER_DEBUG: '1' };
const forwarded = ['CONVERSATIONER_HOME', 'CONVERSATIONER_DEBUG'];
if (values.model && values.model !== 'e4b') {
  const choice = COMPARISON_MODELS[values.model];
  if (!choice) throw new Error(`Unknown model ${values.model}. Choose from: e4b, ${Object.keys(COMPARISON_MODELS).join(', ')}`);
  // Comparison models aren't kept around, since they're large and WSL's disk is really on C:.
  let modelfile = '';
  try {
    modelfile = execFileSync('ollama', ['show', '--modelfile', choice.ollama], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error(`${choice.ollama} isn't downloaded. Get it first with: ollama pull ${choice.ollama}`);
  }
  const blob = modelfile.split('\n').find((line) => line.startsWith('FROM /'))?.slice('FROM '.length);
  if (!blob) throw new Error(`Couldn't find ${choice.ollama} in Ollama`);
  // Only one comparison model at a time, since these are large and this is the user's C: drive.
  for (const other of Object.values(COMPARISON_MODELS)) {
    if (other !== choice) rmSync(join(home, 'models/llm', `${other.file}.gguf`), { force: true });
  }
  copyIfMissing(blob, join(home, 'models/llm', `${choice.file}.gguf`));
  env['CONVERSATIONER_LLM'] = `${choice.file}:${choice.gpuLayers}`;
  forwarded.push('CONVERSATIONER_LLM');
}
if (values.autotest) {
  rmSync(join(home, 'logs/session.log'), { force: true });
  rmSync(join(home, 'logs/autotest.png'), { force: true });
  const microphone = join(home, 'fake-microphone.wav');
  const source = join(root, 'evals/results/speech-speed/speech1.wav');
  // The sentence, then a long pause, repeating: a learner taking their time.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, '-af', 'apad=pad_dur=5', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', microphone]);
  env['CONVERSATIONER_FAKE_MIC'] = windowsPath(microphone);
  env['CONVERSATIONER_AUTOTEST'] = String(AUTOTEST_TURNS);
  forwarded.push('CONVERSATIONER_FAKE_MIC', 'CONVERSATIONER_AUTOTEST');
}
env['WSLENV'] = [process.env['WSLENV'], ...forwarded].filter(Boolean).join(':');

const child = spawn(join(home, 'electron/electron.exe'), [], { env, cwd: join(home, 'electron'), stdio: values.autotest ? 'ignore' : 'ignore', detached: !values.autotest });
if (!values.autotest) {
  child.unref();
  console.log(`Started. Files are in ${windowsPath(home)}`);
} else {
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const logPath = join(home, 'logs/session.log');
  console.log(existsSync(logPath) ? readFileSync(logPath, 'utf8') : 'No session log was written.');
}
