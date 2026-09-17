// Bundles the extension with esbuild. Needed because background.js and
// popup.js `import` @supabase/supabase-js — MV3 forbids loading remote/
// unbundled npm code at runtime, so it has to be compiled in ahead of time.
// content.js has no imports (see src/content.js) and is built as a plain
// classic script so Chrome can load it as a content script.
import { build, context } from 'esbuild';
import { mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { config } from 'dotenv';

config();

const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.warn(`[build] ${key} is not set — copy .env.example to .env and fill it in.`);
  }
}

const outdir = 'dist';
const watch = process.argv.includes('--watch');
const define = {
  'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''),
  'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''),
};

const moduleBuild = {
  entryPoints: { background: 'src/background.js', popup: 'src/popup.js' },
  bundle: true,
  outdir,
  format: 'esm',
  target: 'chrome110',
  define,
  minify: true,
  logLevel: 'info',
};

const classicBuild = {
  entryPoints: { content: 'src/content.js' },
  bundle: true,
  outdir,
  format: 'iife',
  target: 'chrome110',
  minify: true,
  logLevel: 'info',
};

function copyStaticFiles() {
  copyFileSync('manifest.json', `${outdir}/manifest.json`);
  copyFileSync('popup.html', `${outdir}/popup.html`);
  copyFileSync('popup.css', `${outdir}/popup.css`);
  cpSync('icons', `${outdir}/icons`, { recursive: true });
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

if (watch) {
  const [moduleCtx, classicCtx] = await Promise.all([context(moduleBuild), context(classicBuild)]);
  copyStaticFiles();
  await Promise.all([moduleCtx.watch(), classicCtx.watch()]);
  console.log('[build] Watching. Re-run `npm run build` if you edit manifest.json/popup.html/popup.css/icons.');
} else {
  await Promise.all([build(moduleBuild), build(classicBuild)]);
  copyStaticFiles();
  console.log(`[build] Done -> ${outdir}/. Load that folder as an unpacked extension.`);
}
