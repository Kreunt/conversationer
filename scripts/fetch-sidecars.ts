/**
 * Downloads the pinned programs the app runs beside itself, and refuses any file that doesn't match
 * its recorded SHA-256 in sidecars.json.
 *
 *   npm run fetch-sidecars                  download and unpack for this platform
 *   npm run fetch-sidecars -- --hash-all    download every platform's file and record missing hashes
 *
 * Only Pocket TTS publishes checksums. For llama.cpp and whisper.cpp the recorded hash is of the file
 * as first downloaded, so it catches later changes but doesn't prove that first download was genuine.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

interface Asset {
  url: string;
  sha256?: string;
}
type Manifest = Record<string, { license: string; version: string; assets: Record<string, Asset> }>;

const { values } = parseArgs({ options: { 'hash-all': { type: 'boolean', default: false } } });

const manifestPath = join(import.meta.dirname, 'sidecars.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const root = join(import.meta.dirname, '..', 'sidecars');

async function download(asset: Asset): Promise<Buffer> {
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`${asset.url} failed with ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (asset.sha256 && asset.sha256 !== hash) {
    throw new Error(`${basename(asset.url)} doesn't match its recorded hash.\n  expected ${asset.sha256}\n  got      ${hash}`);
  }
  asset.sha256 = hash;
  return bytes;
}

function unpack(archive: string, destination: string): void {
  // tar handles both formats: bsdtar reads zip files on Windows, and Linux only gets .tar.gz here.
  const result = spawnSync('tar', ['-xf', archive, '-C', destination], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Couldn't unpack ${archive}`);
}

for (const [name, sidecar] of Object.entries(manifest)) {
  if (values['hash-all']) {
    for (const [platform, asset] of Object.entries(sidecar.assets)) {
      await download(asset);
      console.log(`${name} ${platform}: ${asset.sha256}`);
    }
    continue;
  }
  const asset = sidecar.assets[process.platform];
  if (!asset) continue; // Some builds only exist for one platform, like NVIDIA's.
  const destination = join(root, name);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const archive = join(destination, basename(asset.url));
  writeFileSync(archive, await download(asset));
  unpack(archive, destination);
  rmSync(archive);
  console.log(`${name} ${sidecar.version}: ready in ${destination}`);
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
