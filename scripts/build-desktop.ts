/** Bundles the desktop app into apps/desktop/dist. */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..', 'apps', 'desktop');
const src = join(root, 'src');
const out = join(root, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const shared = { bundle: true, logLevel: 'warning', target: 'chrome130' } as const;
await build({ ...shared, entryPoints: [join(src, 'main/index.ts')], outfile: join(out, 'main.cjs'), platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
await build({ ...shared, entryPoints: [join(src, 'main/preload.ts')], outfile: join(out, 'preload.cjs'), platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...shared, entryPoints: [join(src, 'renderer/renderer.ts')], outfile: join(out, 'renderer.js'), format: 'iife' });
await build({ ...shared, entryPoints: [join(src, 'renderer/capture-worklet.ts')], outfile: join(out, 'capture-worklet.js'), format: 'iife' });
for (const file of ['index.html', 'style.css']) copyFileSync(join(src, 'renderer', file), join(out, file));
copyFileSync(join(root, 'package.json'), join(out, 'package.json'));
console.log(`Built ${out}`);
