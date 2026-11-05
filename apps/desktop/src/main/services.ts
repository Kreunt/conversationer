import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus } from 'node:os';
import { basename, join } from 'node:path';
import {
  llmChoices,
  parseDevices,
  REMOTE_FILES,
  VOICE_DOWNLOAD_BYTES,
  whisperChoices,
  type LlmChoice,
  type RemoteFile,
  type RemoteFileId,
  type WhisperChoice,
} from '../../../../packages/model-manager/src/index.ts';
import type { Setup } from './setup.ts';

const START_TIMEOUT_MS = 180_000;
/** The voice program downloads its own model the first time it starts, which can take a while. */
const VOICE_START_TIMEOUT_MS = 20 * 60_000;
const RESTART_DELAY_MS = 1000;
const CONTEXT_TOKENS = 4096;

function findFile(directory: string, name: string): string {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      try {
        return findFile(path, name);
      } catch {
        // Keep looking in the other folders.
      }
    }
  }
  throw new Error(`${name} not found in ${directory}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))));
    });
  });
}

/**
 * Stops programs left by a run that crashed, so they can't sit on the GPU. Matching the program name
 * as well means a process ID that Windows has since reused can't be hit by mistake.
 */
function stopLeftovers(record: string): void {
  if (!existsSync(record)) return;
  const leftovers = JSON.parse(readFileSync(record, 'utf8')) as { pid: number; image: string }[];
  for (const { pid, image } of leftovers) {
    spawnSync('taskkill', ['/F', '/FI', `PID eq ${pid}`, '/FI', `IMAGENAME eq ${image}`], { windowsHide: true });
  }
  rmSync(record);
}

/** One program running beside the app. If it dies on its own, it's quietly started again. */
class Sidecar {
  #process: ChildProcess | undefined;
  #stopping = false;

  constructor(
    private readonly name: string,
    private readonly program: string,
    private readonly args: string[],
    private readonly healthUrl: string,
    private readonly logDirectory: string,
    private readonly env: NodeJS.ProcessEnv = {},
    private readonly onStarted: (pid: number, image: string) => void = () => undefined,
    private readonly startTimeoutMs = START_TIMEOUT_MS,
  ) {}

  /** Resolves once the program answers. Rejects if it exits first, as when a model doesn't fit. */
  async start(): Promise<void> {
    const log = createWriteStream(join(this.logDirectory, `${this.name}.log`), { flags: 'a' });
    const child = spawn(this.program, this.args, {
      cwd: join(this.program, '..'),
      env: { ...process.env, ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    this.#process = child;
    if (child.pid) this.onStarted(child.pid, basename(this.program));

    const exited = new Promise<never>((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`${this.name} exited with ${code} while starting`)));
    });
    exited.catch(() => undefined);
    await Promise.race([this.#waitUntilHealthy(), exited]);

    child.once('exit', () => {
      if (this.#stopping) return;
      setTimeout(() => void this.start().catch((error) => console.error(`${this.name} restart failed`, error)), RESTART_DELAY_MS);
    });
  }

  async #waitUntilHealthy(): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < this.startTimeoutMs) {
      const healthy = await fetch(this.healthUrl).then(
        (response) => response.ok,
        () => false,
      );
      if (healthy) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${this.name} didn't start in time`);
  }

  stop(): void {
    this.#stopping = true;
    this.#process?.kill();
  }
}

export interface Services {
  llmUrl: string;
  llmChoice: LlmChoice;
  whisperChoice: WhisperChoice;
  transcribe(wav: ArrayBuffer): Promise<string>;
  speak(text: string): Promise<ArrayBuffer>;
  stop(): void;
}

function filesForLlm(choice: LlmChoice): RemoteFile[] {
  const file = REMOTE_FILES[choice.model as RemoteFileId] as RemoteFile | undefined;
  return file ? [file] : [];
}

function filesForWhisper(choice: WhisperChoice): RemoteFile[] {
  return [
    REMOTE_FILES[choice.model],
    REMOTE_FILES['ggml-silero-v6.2.0.bin'],
    ...(choice.build === 'whisper-cuda' ? [REMOTE_FILES['whisper-cuda']] : []),
  ];
}

export interface ServicePaths {
  /** Where downloads and logs go. */
  home: string;
  /** Where the programs shipped with the app are. */
  bundledSidecars: string;
}

export async function startServices({ home, bundledSidecars }: ServicePaths, setup: Setup, onProgress: (message: string) => void): Promise<Services> {
  /** Shipped programs, or one downloaded for this machine. */
  const program = (build: string, name: string) => {
    const shipped = join(bundledSidecars, build);
    return findFile(existsSync(shipped) ? shipped : join(home, 'sidecars', build), name);
  };
  const models = join(home, 'models');
  const logs = join(home, 'logs');
  const threads = String(Math.max(2, Math.min(8, Math.floor(cpus().length / 2))));
  const running: Sidecar[] = [];
  const record = join(home, 'running.json');
  stopLeftovers(record);
  const started: { pid: number; image: string }[] = [];
  const remember = (pid: number, image: string) => {
    started.push({ pid, image });
    writeFileSync(record, JSON.stringify(started));
  };

  onProgress('Getting Jonas ready…');
  const llamaServer = program('llama', 'llama-server.exe');
  const listing = spawnSync(llamaServer, ['--list-devices'], { cwd: join(llamaServer, '..'), encoding: 'utf8', windowsHide: true });
  const devices = parseDevices(`${listing.stdout}\n${listing.stderr}`);
  // A developer comparing models can force one, as "model:gpuLayers".
  const [forcedModel, forcedLayers] = (process.env['CONVERSATIONER_LLM'] ?? '').split(':');
  const forcedDevice = devices.find((device) => /nvidia|radeon rx|geforce/i.test(device.name))?.id ?? 'none';
  const choices: LlmChoice[] = forcedModel
    ? [{ model: forcedModel, device: forcedDevice, gpuLayers: forcedLayers ? Number(forcedLayers) : undefined }]
    : llmChoices(devices);

  // Everything this machine should need, asked about once, in one go.
  const firstChoice = choices[0] as LlmChoice;
  const voiceMissing = !existsSync(join(home, 'hf-cache'));
  await setup.ensure([...filesForLlm(firstChoice), ...filesForWhisper(whisperChoices(devices, firstChoice)[0] as WhisperChoice)], {
    ask: true,
    extraBytes: voiceMissing ? VOICE_DOWNLOAD_BYTES : 0,
  });
  onProgress('Getting Jonas ready…');

  // Try the best choice the machine might manage, and step down whenever a model won't load.
  let llmUrl = '';
  let llmChoice: LlmChoice | undefined;
  for (const choice of choices) {
    await setup.ensure(filesForLlm(choice));
    const model = join(models, 'llm', `${choice.model}.gguf`);
    if (!existsSync(model)) continue;
    const port = await freePort();
    const args = ['-m', model, '-c', String(CONTEXT_TOKENS), '--host', '127.0.0.1', '--port', String(port), '--reasoning', 'off', '-t', threads];
    args.push(...(choice.device === 'none' ? ['-ngl', '0'] : ['-ngl', String(choice.gpuLayers ?? 99), '--device', choice.device]));
    const sidecar = new Sidecar('llm', llamaServer, args, `http://127.0.0.1:${port}/health`, logs, {}, remember);
    try {
      await sidecar.start();
      running.push(sidecar);
      llmUrl = `http://127.0.0.1:${port}`;
      llmChoice = choice;
      break;
    } catch (error) {
      console.error(`${choice.model} on ${choice.device} didn't load`, error);
      sidecar.stop();
    }
  }
  if (!llmChoice) throw new Error('No language model could be loaded.');

  onProgress('Getting Jonas’s ears ready…');
  const whisperPort = await freePort();
  let whisperChoice: WhisperChoice | undefined;
  for (const choice of whisperChoices(devices, llmChoice)) {
    await setup.ensure(filesForWhisper(choice));
    const model = join(models, 'whisper', choice.model);
    const sidecar = new Sidecar(
      'whisper',
      program(choice.build, 'whisper-server.exe'),
      ['-m', model, '-l', 'de', '-t', threads, '--host', '127.0.0.1', '--port', String(whisperPort), '--vad', '-vm', join(models, 'whisper', 'ggml-silero-v6.2.0.bin')],
      `http://127.0.0.1:${whisperPort}/`,
      logs,
      {},
      remember,
    );
    try {
      await sidecar.start();
      running.push(sidecar);
      whisperChoice = choice;
      break;
    } catch (error) {
      console.error(`${choice.model} on ${choice.build} didn't start`, error);
      sidecar.stop();
    }
  }
  if (!whisperChoice) throw new Error('Speech recognition could not be started.');

  onProgress('Getting Jonas’s voice ready… The first time, this takes a few minutes.');
  const ttsPort = await freePort();
  const tts = new Sidecar(
    'tts',
    program('pocket-tts', 'pocket-tts.exe'),
    ['serve', '--language', 'german', '--default-voice', 'juergen', '--host', '127.0.0.1', '--port', String(ttsPort)],
    `http://127.0.0.1:${ttsPort}/health`,
    logs,
    { HF_HOME: join(home, 'hf-cache') },
    remember,
    VOICE_START_TIMEOUT_MS,
  );
  await tts.start();
  running.push(tts);

  return {
    llmUrl,
    llmChoice,
    whisperChoice,
    async transcribe(wav) {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'turn.wav');
      form.append('response_format', 'json');
      const response = await fetch(`http://127.0.0.1:${whisperPort}/inference`, { method: 'POST', body: form });
      if (!response.ok) throw new Error(`Speech recognition failed with ${response.status}`);
      return ((await response.json()) as { text: string }).text;
    },
    async speak(text) {
      const response = await fetch(`http://127.0.0.1:${ttsPort}/tts`, { method: 'POST', body: new URLSearchParams({ text }) });
      if (!response.ok) throw new Error(`Speech failed with ${response.status}`);
      return response.arrayBuffer();
    },
    stop() {
      for (const sidecar of running) sidecar.stop();
      rmSync(record, { force: true });
    },
  };
}
