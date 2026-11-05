/**
 * Times the whole voice path with the real programs, from the moment a turn ends to Jonas's first
 * audio: speech recognition, then reply, then speech. No microphone or playback is involved.
 *
 *   npx tsx evals/voice-round-trip.ts [--model gemma4:e4b-it-qat] [--whisper ggml-base-q5_1.bin]
 *
 * The "user" is synthetic speech, so this measures speed and wiring, not accuracy on real learners.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { german, jonas } from '../languages/de/index.ts';
import { cleanTranscript, generateTurn, openAiCompatibleChat, personaTurn } from '../packages/engine/src/index.ts';
import type { Turn } from '../packages/engine/src/index.ts';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gemma4:e4b-it-qat' },
    whisper: { type: 'string', default: 'ggml-base-q5_1.bin' },
    threads: { type: 'string', default: '8' },
    vad: { type: 'string' },
    base: { type: 'string', default: 'http://localhost:11434' },
    out: { type: 'string', default: 'evals/results/round-trip' },
  },
});

const WHISPER_PORT = 18081;
const TTS_PORT = 18082;
const STARTUP_TIMEOUT_MS = 180_000;
const WAV_HEADER_BYTES = 1024;

function binary(pattern: string): string {
  const [found] = globSync(pattern);
  if (!found) throw new Error(`${pattern} not found. Run npm run fetch-sidecars.`);
  return resolve(found);
}

async function waitForServer(url: string, process: ChildProcess): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < STARTUP_TIMEOUT_MS) {
    if (process.exitCode !== null) throw new Error(`Server for ${url} exited with ${process.exitCode}`);
    const up = await fetch(url).then(
      (r) => r.status < 500,
      () => false,
    );
    if (up) return performance.now() - started;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} didn't start in time`);
}

async function transcribe(wav: Blob): Promise<string> {
  const form = new FormData();
  form.append('file', wav, 'turn.wav');
  form.append('response_format', 'json');
  const response = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Whisper failed with ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { text: string }).text;
}

/** Streams speech. Calls back when the first audio arrives, which is when playback could start. */
async function speak(text: string, onFirstAudio?: () => void): Promise<Buffer> {
  const response = await fetch(`http://127.0.0.1:${TTS_PORT}/tts`, { method: 'POST', body: new URLSearchParams({ text }) });
  if (!response.ok || !response.body) throw new Error(`TTS failed with ${response.status}: ${await response.text()}`);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    // The first bytes are only the WAV header, which says nothing about when sound is ready.
    if (received <= WAV_HEADER_BYTES && received + chunk.length > WAV_HEADER_BYTES) onFirstAudio?.();
    received += chunk.length;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

mkdirSync(values.out, { recursive: true });
const processes = [
  spawn(
    binary('sidecars/whisper/*/whisper-server'),
    [
      '-m', resolve('sidecars/models/whisper', values.whisper), '-l', 'de', '-t', values.threads, '--port', String(WHISPER_PORT),
      ...(values.vad ? ['--vad', '-vm', resolve('sidecars/models/whisper', values.vad)] : []),
    ],
    { stdio: 'ignore' },
  ),
  spawn(binary('sidecars/pocket-tts/*/pocket-tts'), ['serve', '--language', 'german', '--default-voice', 'juergen', '--port', String(TTS_PORT)], {
    stdio: 'ignore',
  }),
];

try {
  const [whisperProcess, ttsProcess] = processes as [ChildProcess, ChildProcess];
  const whisperStart = await waitForServer(`http://127.0.0.1:${WHISPER_PORT}/`, whisperProcess);
  const ttsStart = await waitForServer(`http://localhost:${TTS_PORT}/health`, ttsProcess);
  console.log(`Startup: Whisper ${Math.round(whisperStart)} ms, Pocket TTS ${Math.round(ttsStart)} ms`);

  const chat = openAiCompatibleChat(values.base, values.model);
  // Loading the LLM is a startup cost, not part of a turn.
  for await (const _ of chat([{ role: 'user', content: 'Hallo' }], { temperature: 0, maxTokens: 4 })) {
    // Drain the stream.
  }

  const lines = [
    'Hallo, mir geht es gut. Wie war dein Tag?',
    'Ich wohne in Istanbul mit drei Mitbewohnern.',
    'Was hast du heute in der Bäckerei gemacht?',
    'Am liebsten koche ich Fleisch.',
    'Warum stehst du so früh auf?',
    'Morgen muss ich auch früh arbeiten.',
    'Wie alt ist dein Hund?',
    'Ich habe eine Katze, aber sie schläft immer.',
  ];

  const history: Turn[] = [];
  const stages = { heard: [] as number[], firstSentence: [] as number[], firstAudio: [] as number[] };
  for (const [index, line] of lines.entries()) {
    const wav = new Blob([new Uint8Array(await speak(line))], { type: 'audio/wav' });

    const turnEnded = performance.now();
    const heard = cleanTranscript(await transcribe(wav), german.phantomTranscripts);
    const heardAt = performance.now() - turnEnded;
    if (!heard) throw new Error(`Nothing heard for: ${line}`);
    history.push({ speaker: 'user', text: heard });

    const sentences: string[] = [];
    let firstSentenceAt = 0;
    let firstAudioAt = 0;
    let speech: Promise<Buffer> | undefined;
    const result = await generateTurn(
      { history, level: 'A2', pack: german, persona: jonas, memory: {}, chat },
      {
        onSentence: (sentence) => {
          sentences.push(sentence);
          if (speech) return;
          firstSentenceAt = performance.now() - turnEnded;
          speech = speak(sentence, () => {
            firstAudioAt = performance.now() - turnEnded;
          });
        },
      },
    );
    const audio = await speech;
    history.push(personaTurn(result));
    if (audio) writeFileSync(join(values.out, `reply-${index}.wav`), audio);

    stages.heard.push(heardAt);
    stages.firstSentence.push(firstSentenceAt);
    stages.firstAudio.push(firstAudioAt);
    console.log(`\nSaid:  ${line}\nHeard: ${heard}\nJonas: ${result.reply}`);
    console.log(`Heard at ${Math.round(heardAt)} ms, first sentence at ${Math.round(firstSentenceAt)} ms, first audio at ${Math.round(firstAudioAt)} ms`);
  }

  console.log(
    `\nMedian after the turn ends: heard ${Math.round(median(stages.heard))} ms, first sentence ${Math.round(median(stages.firstSentence))} ms, ` +
      `first audio ${Math.round(median(stages.firstAudio))} ms. Worst first audio: ${Math.round(Math.max(...stages.firstAudio))} ms.`,
  );

  for (const name of ['silence', 'room_noise', 'louder_noise']) {
    const [file] = globSync(`evals/results/speech-speed/${name}.wav`);
    if (!file) continue;
    const { readFileSync } = await import('node:fs');
    const raw = await transcribe(new Blob([readFileSync(file)], { type: 'audio/wav' }));
    console.log(`${name}: raw ${JSON.stringify(raw.trim())}, after cleaning ${JSON.stringify(cleanTranscript(raw, german.phantomTranscripts))}`);
  }
} finally {
  for (const process of processes) process.kill();
}
