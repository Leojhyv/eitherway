// Takes still pictures of the live page in both themes and at phone width,
// to check the layout by eye. Writes video/work/shots/*.jpg.
//
//   node video/shots.mjs

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8812;
const outDir = join(here, 'work', 'shots');
mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, [join(here, '..', 'scripts', 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch();
const problems = [];

for (const [name, width, height, scheme] of [['light', 1280, 800, 'light'], ['dark', 1280, 800, 'dark'], ['phone', 390, 800, 'light']]) {
  const page = await (await browser.newContext({ viewport: { width, height }, colorScheme: scheme })).newPage();
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name}: console: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/site/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__eitherway && document.querySelector('#liverounds').children.length > 0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) problems.push(`${name}: the page is ${overflow}px wider than the screen`);
  for (const section of ['top', 'round', 'compare', 'underwriters', 'live', 'rules']) {
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ behavior: 'instant' }), section);
    await page.screenshot({ path: join(outDir, `${name}-${section}.jpg`), type: 'jpeg', quality: 80 });
  }
  await page.close();
}

await browser.close();
server.kill();
console.log(problems.length ? `problems:\n  ${problems.join('\n  ')}` : 'no page errors, no sideways scrolling, in light, dark and phone layouts');
console.log(`pictures in ${outDir}`);
