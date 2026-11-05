import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { net } from 'electron';
import { checkDiskSpace, describeProblem, downloadFile, isPresent, UnpackError, type RemoteFile } from '../../../../packages/model-manager/src/index.ts';
import type { ToWindow } from './contract.ts';

const PROGRESS_INTERVAL_MS = 250;
const GIGABYTE = 1e9;

/** Gets missing files onto this computer, after asking, and keeps offering to retry if anything fails. */
export class Setup {
  #accept: (() => void) | undefined;

  constructor(
    private readonly home: string,
    private readonly send: (event: ToWindow) => void,
    private readonly log: (entry: Record<string, unknown>) => void,
    private readonly askFirst: boolean,
  ) {}

  /** The user pressed "Start download" or "Try again". */
  accept(): void {
    this.#accept?.();
    this.#accept = undefined;
  }

  #waitForAccept(): Promise<void> {
    return new Promise((resolve) => {
      this.#accept = resolve;
    });
  }

  /**
   * `extraBytes` counts downloads the user should hear about that happen elsewhere, like the voice.
   * Later calls, such as stepping down to a smaller model, don't ask again.
   */
  async ensure(files: RemoteFile[], { ask = false, extraBytes = 0 } = {}): Promise<void> {
    const missing = files.filter((file) => !isPresent(file, this.home));
    if (missing.length === 0 && extraBytes === 0) return;
    const fileBytes = missing.reduce((sum, file) => sum + file.bytes, 0);
    const total = fileBytes + extraBytes;

    if (ask && this.askFirst) {
      this.send({ type: 'setup_needed', gigabytes: total / GIGABYTE });
      await this.#waitForAccept();
    }

    while (true) {
      try {
        checkDiskSpace(total, this.home);
        await this.#download(missing, fileBytes);
        return;
      } catch (error) {
        const problem = describeProblem(error);
        this.log({ event: 'setup_failed', message: String(error), detail: problem.detail });
        this.send({ type: 'setup_failed', ...problem });
        await this.#waitForAccept();
      }
    }
  }

  async #download(files: RemoteFile[], totalBytes: number): Promise<void> {
    let done = 0;
    let lastSent = 0;
    const report = (bytes: number) => {
      done += bytes;
      if (Date.now() - lastSent < PROGRESS_INTERVAL_MS) return;
      lastSent = Date.now();
      this.send({ type: 'setup_progress', doneGb: done / GIGABYTE, totalGb: totalBytes / GIGABYTE });
    };
    for (const file of files) {
      if (!isPresent(file, this.home)) {
        const before = done;
        try {
          await downloadFile(file, this.home, report, undefined, (input, init) => net.fetch(input as string, init));
        } catch (error) {
          done = before;
          throw error;
        }
        if (file.unpackTo) this.#unpack(file);
      }
    }
  }

  /** Unpacks beside the destination first, so a half-unpacked folder never counts as present. */
  #unpack(file: RemoteFile & { unpackTo?: string }): void {
    const archive = join(this.home, file.path);
    const destination = join(this.home, file.unpackTo as string);
    const temporary = `${destination}.unpacking`;
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    // Windows' own tar, which reads zip files. Another tar on the PATH, like Git's, may not.
    const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    const result = spawnSync(tar, ['-xf', archive, '-C', temporary], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) {
      rmSync(temporary, { recursive: true, force: true });
      throw new UnpackError(`Couldn't unpack ${file.path}: ${result.error?.message ?? result.stderr?.slice(0, 120) ?? result.status}`);
    }
    renameSync(temporary, destination);
    if (existsSync(archive)) rmSync(archive);
  }
}
