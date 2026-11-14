// Bundles the live page into one self-contained HTML file: the page, its
// scripts and the data it shows, with nothing loaded from anywhere else.
// Handy for hosting the page anywhere a single file can go.
//
//   node scripts/single-file.mjs                       writes dist/eitherway.html
//   node scripts/single-file.mjs out.html --fragment   no <html>/<head> wrapper, for hosts that add their own

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from './keys.mjs';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'dist', 'eitherway.html');
const fragment = args.includes('--fragment');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// The page's modules, in dependency order. Each becomes its own block, and
// what it exports goes into one shared object that later blocks read from.
const MODULES = ['engine/sha256.mjs', 'engine/rng.mjs', 'engine/market.mjs', 'swarm/agents.mjs', 'swarm/sim.mjs', 'site/app.mjs'];
const DATA = ['data/sweep.json', 'data/sweep-pros.json', 'data/latest.json'];

const blocks = MODULES.map((path) => {
  let code = read(path);
  const names = [...code.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  code = code.replace(/^import\s*\{([^}]+)\}\s*from\s*'[^']+';[ \t]*$/gm, (_, list) => `const {${list}} = __m;`);
  if (/^import\s/m.test(code)) throw new Error(`${path}: an import this bundler does not understand`);
  code = code.replace(/^export\s+/gm, '');
  return `// ---- ${path}\n{\n${code}\nObject.assign(__m, { ${names.join(', ')} });\n}`;
});

// The page fetches its data; in the single file the data is already there.
const data = Object.fromEntries(DATA.map((path) => [`../${path}`, JSON.parse(read(path))]));
let script = `const __m = {};\nconst __DATA = ${JSON.stringify(data)};\n\n${blocks.join('\n\n')}`;
const fetcher = /async function getJson\(url\) \{[\s\S]*?\r?\n\}\r?\n/;
if (!fetcher.test(script)) throw new Error('site/app.mjs: getJson not found');
script = script.replace(fetcher, () => 'async function getJson(url) {\n  return __DATA[url] ?? null;\n}\n');
script = script.replace(/<\/script/gi, () => '<\\/script'); // never end the inline script early

let html = read('site/index.html');
// Links to files that live only in the repository point at the page's own section instead.
html = html.replace('<a class="btn" href="../RULES.md">Read the rules</a>', () => '<a class="btn" href="#rules">Read the rules</a>');
html = html.replace('<a href="../RULES.md">RULES.md</a>', () => 'RULES.md');
if (html.includes('../')) throw new Error('site/index.html still links to files outside the page');
const tag = '<script type="module" src="./app.mjs"></script>';
if (!html.includes(tag)) throw new Error('site/index.html: the app script tag was not found');
html = html.replace(tag, () => `<script type="module">\n${script}\n</script>`);

if (fragment) {
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  html = `<title>EitherWay</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${style}\n${body}`;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${Math.round(html.length / 1024)} kB${fragment ? ', fragment' : ''})`);
