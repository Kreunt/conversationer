import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export interface RemoteFile {
  url: string;
  sha256: string;
  bytes: number;
  /** Where it goes, relative to the app's data folder. */
  path: string;
  /** A zip file to unpack into this folder, then delete. */
  unpackTo?: string;
}

const pinned = (repo: string, revision: string, file: string) => `https://huggingface.co/${repo}/resolve/${revision}/${file}`;

/** Every file the app may download, pinned to an exact version and checked against its hash. */
export const REMOTE_FILES = {
  'gemma4-e4b-it-qat': {
    url: pinned('google/gemma-4-E4B-it-qat-q4_0-gguf', '4b4a2c1d584be7264f87aac328a1bc739ce81b6c', 'gemma-4-E4B_q4_0-it.gguf'),
    sha256: '676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee',
    bytes: 5154941280,
    path: 'models/llm/gemma4-e4b-it-qat.gguf',
  },
  'gemma4-e2b-it-qat': {
    url: pinned('google/gemma-4-E2B-it-qat-q4_0-gguf', '675cff42a74c774d6cb76f76d8eacb49b48c9b93', 'gemma-4-E2B_q4_0-it.gguf'),
    sha256: 'fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634',
    bytes: 3349516256,
    path: 'models/llm/gemma4-e2b-it-qat.gguf',
  },
  'ggml-large-v3-turbo-q5_0.bin': {
    url: pinned('ggerganov/whisper.cpp', '5359861c739e955e79d9a303bcbc70fb988958b1', 'ggml-large-v3-turbo-q5_0.bin'),
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    bytes: 574041195,
    path: 'models/whisper/ggml-large-v3-turbo-q5_0.bin',
  },
  'ggml-base-q5_1.bin': {
    url: pinned('ggerganov/whisper.cpp', '5359861c739e955e79d9a303bcbc70fb988958b1', 'ggml-base-q5_1.bin'),
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    bytes: 59707625,
    path: 'models/whisper/ggml-base-q5_1.bin',
  },
  'ggml-silero-v6.2.0.bin': {
    url: pinned('ggml-org/whisper-vad', '9ffd54a1e1ee413ddf265af9913beaf518d1639b', 'ggml-silero-v6.2.0.bin'),
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    bytes: 885098,
    path: 'models/whisper/ggml-silero-v6.2.0.bin',
  },
  'whisper-cuda': {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip',
    sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
    bytes: 684913404,
    path: 'sidecars/whisper-cuda.zip',
    unpackTo: 'sidecars/whisper-cuda',
  },
} satisfies Record<string, RemoteFile>;

export type RemoteFileId = keyof typeof REMOTE_FILES;

/** Pocket TTS fetches its own voice model on first start. This is roughly how much. */
export const VOICE_DOWNLOAD_BYTES = 430_000_000;
/** Unpacking and normal use need room beyond the files themselves. */
const SPARE_BYTES = 2_000_000_000;

export class NotEnoughSpaceError extends Error {
  constructor(readonly neededBytes: number) {
    super(`Needs about ${neededBytes} bytes of free disk space`);
  }
}

export class CorruptDownloadError extends Error {}

export class DownloadHttpError extends Error {
  constructor(readonly status: number, path: string) {
    super(`Download of ${path} failed with ${status}`);
  }
}

export class UnpackError extends Error {}

export interface ProblemDescription {
  /** Plain words for whoever is using the app. */
  message: string;
  /** Short technical detail, for them to pass on to someone who can help. */
  detail: string;
}

function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return [cause?.code, cause?.message, (error as Error)?.message].filter(Boolean).join(' ');
}

/** Turns a failed download into words a non-technical person can act on, without guessing at the cause. */
export function describeProblem(error: unknown): ProblemDescription {
  const code = errorCode(error);
  const detail = code.slice(0, 160) || String(error);
  if (error instanceof NotEnoughSpaceError) {
    return { detail, message: `This needs about ${Math.ceil(error.neededBytes / 1e9)} GB of free disk space. Please free up some space, then try again.` };
  }
  if (error instanceof CorruptDownloadError) {
    return { detail, message: 'A downloaded file arrived damaged, so it was deleted. Press Try again to download it once more.' };
  }
  if (error instanceof UnpackError) {
    return { detail, message: 'A downloaded file couldn’t be unpacked. Press Try again. If it keeps happening, please pass on the details below.' };
  }
  if (error instanceof DownloadHttpError) {
    return { detail, message: `The download server didn’t answer properly (error ${error.status}). Please try again in a few minutes.` };
  }
  if (/CERT|certificate|SSL|TLS/i.test(code)) {
    return {
      detail,
      message: 'A security program, or the network you’re on, blocked the download. Antivirus web protection or a work or school network can do this. Please try again on another network, or pass on the details below.',
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_|TIMED_OUT|NETWORK_CHANGED|PROXY|fetch failed|terminated|aborted/i.test(code)) {
    return { detail, message: 'The download stopped because the connection was interrupted. Press Try again: it will carry on from where it stopped.' };
  }
  return { detail, message: 'Something went wrong with the download. Press Try again. If it keeps happening, please pass on the details below.' };
}

export function isPresent(file: RemoteFile, home: string): boolean {
  return existsSync(`${home}/${file.unpackTo ?? file.path}`);
}

export function checkDiskSpace(bytes: number, folder: string): void {
  const { bavail, bsize } = statfsSync(folder);
  const needed = bytes + SPARE_BYTES;
  if (bavail * bsize < needed) throw new NotEnoughSpaceError(needed);
}

async function hashOf(path: string): Promise<ReturnType<typeof createHash>> {
  const hash = createHash('sha256');
  if (existsSync(path)) await pipeline(createReadStream(path), hash, { end: false });
  return hash;
}

/**
 * Downloads to a `.part` file and moves it into place only once its hash matches, so a file that's
 * present is always a whole, correct one. An interrupted download carries on from where it stopped.
 */
export async function downloadFile(
  file: RemoteFile,
  home: string,
  onBytes: (newBytes: number) => void = () => undefined,
  signal?: AbortSignal,
  // In the app this is Electron's, which uses Windows' proxy settings and certificates like a browser does.
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const destination = `${home}/${file.path}`;
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });

  const part = `${destination}.part`;
  const existing = existsSync(part) ? statSync(part).size : 0;
  if (existing > file.bytes) rmSync(part);
  const resumeFrom = existsSync(part) ? existing : 0;

  const response = await fetchImpl(file.url, { headers: resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : {}, signal });
  // Everything was already there: a range past the end is the server's way of saying so.
  const alreadyWhole = response.status === 416 && resumeFrom === file.bytes;
  if (!alreadyWhole && (!response.ok || !response.body)) throw new DownloadHttpError(response.status, file.path);

  // A server may ignore the range and send the whole file, and then the old part is no use.
  const resuming = response.status === 206;
  if (!resuming && !alreadyWhole) rmSync(part, { force: true });
  const hash = await hashOf(part);
  if (resuming || alreadyWhole) onBytes(resumeFrom);

  if (!alreadyWhole && response.body) {
    const count = new Transform({
      transform(chunk: Buffer, _, done) {
        hash.update(chunk);
        onBytes(chunk.length);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), count, createWriteStream(part, { flags: resuming ? 'a' : 'w' }), { signal });
  }

  if (hash.digest('hex') !== file.sha256) {
    rmSync(part, { force: true });
    throw new CorruptDownloadError(`${file.path} didn't match its expected hash`);
  }
  renameSync(part, destination);
}
