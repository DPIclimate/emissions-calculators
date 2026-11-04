// @ts-check

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Copy only browser assets into the runtime; npm packages stay in the build stage.
const vendor = new URL('./vendor/', import.meta.url);
const designSystem = new URL('../node_modules/nsw-design-system/', import.meta.url);
const font = new URL('../node_modules/@fontsource/public-sans/', import.meta.url);
mkdirSync(new URL('fonts/', vendor), { recursive: true });
copyFileSync(new URL('dist/css/main.css', designSystem), new URL('nsw.css', vendor));
copyFileSync(new URL('LICENSE', designSystem), new URL('NSW-LICENSE', vendor));
copyFileSync(new URL('LICENSE', font), new URL('PUBLIC-SANS-LICENSE', vendor));
let css = '';
for (const variant of ['400-normal', '700-normal', '400-italic']) {
  const [weight, style] = variant.split('-');
  const stylesheet = `latin-${weight}${style === 'italic' ? '-italic' : ''}.css`;
  css += readFileSync(new URL(stylesheet, font), 'utf8').replaceAll('./files/', '/vendor/fonts/');
  for (const extension of ['woff', 'woff2']) {
    const filename = `public-sans-latin-${variant}.${extension}`;
    copyFileSync(new URL(`files/${filename}`, font), new URL(`fonts/${filename}`, vendor));
  }
}
writeFileSync(new URL('fonts.css', vendor), css);

// Bundle editor modules locally; no browser requests to an npm CDN are needed.
await build({
  entryPoints: [new URL('./client.js', import.meta.url).pathname],
  outfile: new URL('client.js', vendor).pathname,
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  legalComments: 'eof',
});
