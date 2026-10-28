import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, basename } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/content.ts', 'src/background.ts', 'src/popup.ts'],
  outdir: root,
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['chrome106'],
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  banner: { js: '// Generated from src/*.ts by npm run build. Edit the TypeScript source.' },
});

let stale = false;
for (const output of result.outputFiles) {
  const file = resolve(output.path);
  if (check) {
    const existing = await readFile(file, 'utf8').catch(() => '');
    if (existing.replace(/\r\n/g, '\n') !== output.text) {
      console.error(`${basename(file)} is stale; run npm run build.`);
      stale = true;
    }
  } else {
    await writeFile(file, output.contents);
    console.log(`Built ${basename(file)} (${output.contents.length} bytes)`);
  }
}
if (stale) process.exitCode = 1;
else if (check) console.log('Generated extension scripts match the TypeScript sources.');
