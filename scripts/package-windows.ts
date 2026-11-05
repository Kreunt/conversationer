/**
 * Builds the Windows installer into release/. Run from WSL.
 *
 * The installer tool has to run on Windows, so this uses a temporary copy of Node there rather than
 * installing anything, and removes it all afterwards. Models aren't included: the app downloads what
 * each computer needs on first run.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NODE_VERSION = 'v22.19.0';
const ELECTRON_VERSION = '45.2.1';
const BUILDER_VERSION = '26.18.0';

const root = join(import.meta.dirname, '..');
const windowsPath = (path: string) => execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
const localAppData = execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8', cwd: '/mnt/c' }).trim();
const work = join(execFileSync('wslpath', ['-u', localAppData], { encoding: 'utf8' }).trim(), 'conversationer-build');

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

try {
  execFileSync('npx', ['tsx', 'scripts/build-desktop.ts'], { cwd: root, stdio: 'inherit' });

  const nodeZip = `node-${NODE_VERSION}-win-x64.zip`;
  const nodeUrl = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = await (await fetch(`${nodeUrl}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((line) => line.endsWith(nodeZip))?.split(/\s+/)[0];
  const bytes = Buffer.from(await (await fetch(`${nodeUrl}/${nodeZip}`)).arrayBuffer());
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`${nodeZip} doesn't match its published checksum`);
  writeFileSync(join(work, nodeZip), bytes);
  execFileSync('tar.exe', ['-xf', windowsPath(join(work, nodeZip)), '-C', windowsPath(work)], { cwd: '/mnt/c' });
  rmSync(join(work, nodeZip));
  const nodeDir = join(work, `node-${NODE_VERSION}-win-x64`);

  cpSync(join(root, 'apps/desktop/dist'), join(work, 'app'), { recursive: true });
  // The installer names the install folder after this, so it can't be the scoped workspace name.
  const appPackage = JSON.parse(readFileSync(join(work, 'app/package.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(work, 'app/package.json'), JSON.stringify({ ...appPackage, name: 'conversationer' }));
  for (const name of ['llama', 'whisper', 'pocket-tts']) cpSync(join(root, 'sidecars/win', name), join(work, 'sidecars', name), { recursive: true });
  copyFileSync(join(root, 'LICENSE'), join(work, 'LICENSE.txt'));
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.txt'), join(work, 'THIRD_PARTY_NOTICES.txt'));
  // Uninstalling takes the downloaded models too, which are gigabytes. An update keeps them.
  writeFileSync(join(work, 'uninstall.nsh'), '!macro customUnInstall\n  ${ifNot} ${isUpdated}\n    RMDir /r "$LOCALAPPDATA\\Conversationer"\n    RMDir /r "$LOCALAPPDATA\\conversationer-updater"\n  ${endIf}\n!macroend\n');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'conversationer-build', private: true, version: '0.1.0' }));
  writeFileSync(
    join(work, 'builder.json'),
    JSON.stringify({
      appId: 'app.conversationer',
      productName: 'Conversationer',
      electronVersion: ELECTRON_VERSION,
      directories: { app: 'app', output: 'out', buildResources: 'build-resources' },
      asar: true,
      npmRebuild: false,
      publish: null,
      extraResources: [
        { from: 'sidecars', to: 'sidecars' },
        { from: 'LICENSE.txt', to: 'LICENSE.txt' },
        { from: 'THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
      ],
      // No signing certificate yet, and this step needs a tool that can't unpack without extra rights.
      win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false },
      nsis: {
        oneClick: true,
        perMachine: false,
        runAfterFinish: true,
        createDesktopShortcut: true,
        shortcutName: 'Conversationer',
        include: 'uninstall.nsh',
        artifactName: 'Conversationer-Setup-${version}.exe',
      },
    }),
  );

  const node = join(nodeDir, 'node.exe');
  const run = (...args: string[]) => execFileSync(node, args, { cwd: work, stdio: 'inherit' });
  run(windowsPath(join(nodeDir, 'node_modules/npm/bin/npm-cli.js')), 'install', '--no-audit', '--no-fund', '--ignore-scripts', `electron-builder@${BUILDER_VERSION}`);
  run('node_modules/electron-builder/cli.js', '--win', '--x64', '--config', 'builder.json');

  mkdirSync(join(root, 'release'), { recursive: true });
  for (const file of readdirSync(join(work, 'out'))) {
    if (!file.endsWith('.exe')) continue;
    copyFileSync(join(work, 'out', file), join(root, 'release', file));
    console.log(`release/${file}: ${(statSync(join(root, 'release', file)).size / 1e6).toFixed(0)} MB`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
