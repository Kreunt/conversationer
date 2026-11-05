import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CorruptDownloadError,
  checkDiskSpace,
  describeProblem,
  DownloadHttpError,
  downloadFile,
  isPresent,
  NotEnoughSpaceError,
  REMOTE_FILES,
  UnpackError,
  type RemoteFile,
} from '../src/downloads.ts';

const CONTENT = Buffer.alloc(200_000, 'jonas');
const HASH = createHash('sha256').update(CONTENT).digest('hex');

describe('downloadFile', () => {
  let server: Server;
  let base: string;
  let home: string;
  let honourRanges = true;
  let cutOffAfter: number | undefined;
  let lastRange: string | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      lastRange = request.headers.range;
      if (request.url === '/missing') {
        response.writeHead(404).end();
        return;
      }
      const range = /bytes=(\d+)-/.exec(request.headers.range ?? '');
      const start = honourRanges && range ? Number(range[1]) : 0;
      if (start >= CONTENT.length && honourRanges && range) {
        response.writeHead(416).end();
        return;
      }
      response.writeHead(honourRanges && range ? 206 : 200);
      const body = CONTENT.subarray(start);
      if (cutOffAfter !== undefined) {
        response.write(body.subarray(0, cutOffAfter), () => response.destroy());
        return;
      }
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('No address');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'downloads-'));
    honourRanges = true;
    cutOffAfter = undefined;
    lastRange = undefined;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const file = (overrides: Partial<RemoteFile> = {}): RemoteFile => ({
    url: `${base}/model`,
    sha256: HASH,
    bytes: CONTENT.length,
    path: 'models/test.bin',
    ...overrides,
  });
  const destination = () => join(home, 'models/test.bin');
  const part = () => `${destination()}.part`;
  const writePart = (length: number) => {
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(part(), CONTENT.subarray(0, length));
  };

  it('downloads and verifies a file, reporting every byte', async () => {
    let total = 0;
    await downloadFile(file(), home, (bytes) => (total += bytes));
    expect(readFileSync(destination()).equals(CONTENT)).toBe(true);
    expect(total).toBe(CONTENT.length);
    expect(existsSync(part())).toBe(false);
  });

  it('carries on from where an interrupted download stopped', async () => {
    writePart(50_000);
    let total = 0;
    await downloadFile(file(), home, (bytes) => (total += bytes));
    expect(lastRange).toBe('bytes=50000-');
    expect(readFileSync(destination()).equals(CONTENT)).toBe(true);
    expect(total).toBe(CONTENT.length);
  });

  it('keeps what it has when the connection drops, then finishes on the next try', async () => {
    cutOffAfter = 60_000;
    await expect(downloadFile(file(), home)).rejects.toThrow();
    expect(existsSync(destination())).toBe(false);
    expect(existsSync(part())).toBe(true);
    cutOffAfter = undefined;
    await downloadFile(file(), home);
    expect(readFileSync(destination()).equals(CONTENT)).toBe(true);
  });

  it('starts again if the server ignores the resume request', async () => {
    honourRanges = false;
    writePart(50_000);
    await downloadFile(file(), home);
    expect(readFileSync(destination()).equals(CONTENT)).toBe(true);
  });

  it('finishes when the last run had everything except the final check', async () => {
    writePart(CONTENT.length);
    await downloadFile(file(), home);
    expect(readFileSync(destination()).equals(CONTENT)).toBe(true);
  });

  it('throws away a corrupt download rather than keeping it', async () => {
    await expect(downloadFile(file({ sha256: 'a'.repeat(64) }), home)).rejects.toBeInstanceOf(CorruptDownloadError);
    expect(existsSync(destination())).toBe(false);
    expect(existsSync(part())).toBe(false);
  });

  it('throws away a corrupt partial file, so a retry can succeed', async () => {
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(part(), Buffer.alloc(50_000, 'x'));
    await expect(downloadFile(file(), home)).rejects.toBeInstanceOf(CorruptDownloadError);
    await downloadFile(file(), home);
    expect(readFileSync(destination()).equals(CONTENT)).toBe(true);
  });

  it('reports a failed request', async () => {
    await expect(downloadFile(file({ url: `${base}/missing` }), home)).rejects.toBeInstanceOf(DownloadHttpError);
    expect(existsSync(destination())).toBe(false);
  });

  it('does nothing if the file is already there', async () => {
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(destination(), 'already here');
    await downloadFile(file({ url: `${base}/missing` }), home);
    expect(readFileSync(destination(), 'utf8')).toBe('already here');
  });

  it('stops when cancelled, keeping the partial file', async () => {
    const cancel = new AbortController();
    await expect(
      downloadFile(file(), home, () => cancel.abort(), cancel.signal),
    ).rejects.toThrow();
    expect(existsSync(destination())).toBe(false);
  });

  it('can download through a different fetch, as the app does', async () => {
    let used = 0;
    const counting: typeof fetch = (input, init) => {
      used++;
      return fetch(input, init);
    };
    await downloadFile(file(), home, undefined, undefined, counting);
    expect(used).toBe(1);
    expect(readFileSync(destination()).equals(CONTENT)).toBe(true);
  });

  it('treats an unpacked file as present once its folder exists', () => {
    const zipped = file({ path: 'sidecars/x.zip', unpackTo: 'sidecars/x' });
    expect(isPresent(zipped, home)).toBe(false);
    mkdirSync(join(home, 'sidecars/x'), { recursive: true });
    expect(isPresent(zipped, home)).toBe(true);
  });
});

describe('checkDiskSpace', () => {
  it('passes when there is room, and fails with how much is needed when not', () => {
    expect(() => checkDiskSpace(1, tmpdir())).not.toThrow();
    expect(() => checkDiskSpace(Number.MAX_SAFE_INTEGER, tmpdir())).toThrow(NotEnoughSpaceError);
  });
});

describe('the pinned file list', () => {
  it('pins every file to a version and a full hash', () => {
    for (const file of Object.values(REMOTE_FILES)) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.url).not.toMatch(/\/resolve\/main\//);
      expect(file.bytes).toBeGreaterThan(0);
    }
  });
});

describe('describeProblem', () => {
  const nodeError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code, message: code } });

  it.each([
    ['an antivirus intercepting HTTPS in Node', nodeError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), /security program/],
    ['the same through Electron', new Error('net::ERR_CERT_AUTHORITY_INVALID'), /security program/],
    ['a self-signed certificate on a work network', nodeError('SELF_SIGNED_CERT_IN_CHAIN'), /security program/],
    ['a dropped connection', nodeError('ECONNRESET'), /connection was interrupted/],
    ['no internet in Electron', new Error('net::ERR_INTERNET_DISCONNECTED'), /connection was interrupted/],
    ['a server error', new DownloadHttpError(503, 'x'), /error 503/],
    ['a damaged file', new CorruptDownloadError('x'), /damaged/],
    ['a failed unpack', new UnpackError('x'), /unpacked/],
    ['a full disk', new NotEnoughSpaceError(9e9), /9 GB/],
    ['anything else', new Error('EPERM: operation not permitted'), /Something went wrong/],
  ])('explains %s without blaming the internet unless it was', (_, error, message) => {
    const { message: said, detail } = describeProblem(error);
    expect(said).toMatch(message);
    expect(detail.length).toBeGreaterThan(0);
  });

  it('only mentions the internet for connection problems', () => {
    for (const error of [new CorruptDownloadError('x'), new UnpackError('x'), new Error('EPERM'), nodeError('CERT_HAS_EXPIRED')]) {
      expect(describeProblem(error).message).not.toMatch(/connection/);
    }
  });
});
