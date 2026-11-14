// Films the demo video from the real page, one frame at a time.
//
//   FFMPEG=<path to ffmpeg> node video/film.mjs            the whole film
//   FFMPEG=... node video/film.mjs --fps 3                 a quick low-frame-rate proof
//   FFMPEG=... node video/film.mjs --from 40 --to 60       part of it
//
// The picture follows the voice: video/work/timeline.json says when each line
// is spoken, and every frame is drawn for an exact moment on that clock. So a
// slow machine makes the filming slower, never the film jerky.
//
// What is on screen is the page itself (site/), driven through the handle it
// exposes for this purpose, with a camera that moves in on whatever the voice
// is talking about. Two things are drawn rather than filmed, because the page
// has nothing to show for them: the opening picture of a campaign nobody
// dares to back first, and the end card.

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const fps = Number(flag('fps', 30));
const PORT = 8811;
const ffmpegPath = process.env.FFMPEG;
if (!ffmpegPath) throw new Error('set FFMPEG to the ffmpeg executable');

const tl = JSON.parse(readFileSync(join(here, 'work', 'timeline.json'), 'utf8'));
const latest = JSON.parse(readFileSync(join(root, 'data', 'latest.json'), 'utf8'));
const line = Object.fromEntries(tl.lines.map((l) => [l.id, l]));
const duration = tl.duration;
const from = Number(flag('from', 0));
const to = Math.min(duration, Number(flag('to', duration)));
const out = flag('out', join(here, 'work', fps === 30 && from === 0 && to === duration ? 'picture.mp4' : `proof-${fps}fps.mp4`));

// ---- the timeline of the picture -----------------------------------------------------

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const ease = (x) => { const c = clamp(x); return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2; };
const span = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;

/** A scene runs from just before its first line to just before the next scene's first line. */
const sceneNames = [...new Set(tl.lines.map((l) => l.scene))];
const sceneStart = Object.fromEntries(sceneNames.map((s) => [s, tl.lines.find((l) => l.scene === s).start - 0.35]));
sceneStart[sceneNames[0]] = 0;
const sceneEnd = Object.fromEntries(sceneNames.map((s, i) => [s, i + 1 < sceneNames.length ? sceneStart[sceneNames[i + 1]] : duration]));
const sceneAt = (t) => sceneNames.findLast((s) => t >= sceneStart[s]) ?? sceneNames[0];

/** Camera keyframes: hold each shot, then glide to the next over `glide` seconds. */
function path(t, keys, glide = 1.1) {
  let i = 0;
  while (i + 1 < keys.length && t >= keys[i + 1][0]) i++;
  if (i === 0) return { a: keys[0][1], b: keys[0][1], k: 0 };
  return { a: keys[i - 1][1], b: keys[i][1], k: ease(span(t, keys[i][0], keys[i][0] + glide)) };
}

const { winIndex, missIndex } = tl.facts;
const T = { commit: 0.1, reveal: 0.28, winner: 0.36, fund: 0.42, out: 0.9 }; // as in site/app.mjs
const BIDS = '#round .stage > div:nth-child(2) > .card:nth-child(1)';
const PLEDGES = '#round .stage > div:nth-child(2) > .card:nth-child(2)';
// The live campaign to show: one that found a guarantor and drew pledges.
const featured = Math.max(0, latest.rounds.findIndex((r) => r.underwriter && r.pledges.length >= 3));
// The page lists the latest campaign first.
const FEAT = `#liverounds .lr:nth-child(${latest.rounds.length - featured})`;

function stateAt(t) {
  const scene = sceneAt(t);
  const s0 = sceneStart[scene];
  const s1 = sceneEnd[scene];
  const said = tl.lines.findLast((l) => t >= l.start - 0.12) ?? tl.lines[0]; // the first caption is up from frame 0
  const st = {
    caption: t <= said.end + Math.min(0.9, said.pause / 1000 + 0.25) ? said.caption : '',
    // A short dip to black hides the cut between scenes.
    fade: Math.max(1 - span(t, s0, s0 + 0.22), span(t, s1 - 0.18, s1)),
    stage: null, player: null, cam: null, spot: null, open: null, inset: null,
  };
  if (scene === sceneNames[0]) st.fade = span(t, s1 - 0.18, s1); // never fade in on the first frame: it is the preview

  switch (scene) {
    case 'problem':
      st.stage = { name: 'problem', p: span(t, 0, s1 - 0.2), waiting: span(t, line.a3.start, line.a3.end), risk: span(t, line.b1.start + 0.4, line.b1.start + 1.6), end: span(t, line.b2.start + 1.2, line.b2.end + 0.2) };
      break;

    case 'solution':
      st.cam = { a: { sel: '.hero h1', z: 1.2, left: 100, top: 70 }, b: { sel: '.hero h1', z: 1.3, left: 100, top: 62 }, k: span(t, s0, s1) };
      break;

    case 'auction':
      st.cam = path(t, [
        [s0, { sel: '#round .stage', z: 1.0, top: 30, mask: true }],
        [line.d2.start - 0.6, { sel: BIDS, z: 1.58, top: 26, mask: true }],
      ], 1.4);
      st.player = {
        index: winIndex,
        t: t < line.d2.start ? lerp(0.02, T.commit - 0.01, span(t, s0, line.d2.start))
          : t < line.d3.start ? lerp(T.commit, T.reveal - 0.01, ease(span(t, line.d2.start + 0.8, line.d2.start + 5.5)))
            : lerp(T.reveal, T.fund - 0.005, span(t, line.d3.start, line.d3.start + 3.4)),
      };
      break;

    case 'funded':
      st.cam = path(t, [
        [s0, { sel: PLEDGES, z: 1.5, top: 224, mask: true }],
        [line.e3.start - 0.3, { sel: PLEDGES, z: 1.2, top: 28, mask: true }],
      ], 1.2);
      st.player = {
        index: winIndex,
        t: t < line.e3.start ? T.fund + 0.001 : lerp(T.fund + 0.001, 1, ease(span(t, line.e3.start, line.e3.end - 0.6))),
      };
      st.inset = { o: ease(span(t, s0 + 0.3, s0 + 0.9)) * (1 - span(t, line.e3.start - 0.3, line.e3.start + 0.2)), p: span(t, line.e2.start, line.e2.end) };
      break;

    case 'missed':
      st.cam = { a: { sel: PLEDGES, z: 1.2, top: 28, mask: true }, b: { sel: PLEDGES, z: 1.2, top: 28, mask: true }, k: 0 };
      st.player = { index: missIndex, t: lerp(T.fund + 0.001, 1, ease(span(t, s0 + 0.25, line.f2.start + 0.4))) };
      st.spot = { sel: '#outcome', pad: 8, dim: 0, o: ease(span(t, line.f2.start + 0.5, line.f2.start + 1.1)) };
      break;

    case 'numbers':
      st.player = { index: winIndex, t: 1 };
      st.cam = path(t, [
        [s0, { sel: '#compare h2', z: 1.08, left: 64, top: 40 }],
        [line.g2.start - 0.5, { sel: '#compare .card', z: 1.16, top: 34, mask: true }],
      ]);
      if (t >= line.g2.start + 0.7) st.spot = { sel: '#sweep', pad: 14, dim: 0, o: ease(span(t, line.g2.start + 0.7, line.g2.start + 1.3)) };
      break;

    case 'swarm':
      st.cam = path(t, [
        [s0, { sel: FEAT, z: 1.06, top: 26, mask: true }],
        [line.h2.start - 0.4, { sel: `${FEAT} > div:first-child`, z: 1.5, top: 26, mask: true }],
        [line.h3.start - 0.4, { sel: '#rules .rules .card', z: 1.5, top: 44, mask: true }],
      ]);
      if (t >= line.h3.start + 0.9) st.spot = { sel: '#rules .rules .card li:nth-child(5)', pad: 8, dim: 0, o: ease(span(t, line.h3.start + 0.9, line.h3.start + 1.4)) };
      break;

    case 'close':
      st.stage = { name: 'end', p: span(t, s0 + 0.2, s0 + 1.4) };
      st.fade = 1 - span(t, s0, s0 + 0.3);
      break;

    default:
      break;
  }
  return st;
}

// ---- what runs inside the page ---------------------------------------------------------

function installFilmLayer(facts) {
  const css = `
    *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
    html, body { overflow: hidden !important; }
    header.top, #tip { display: none !important; }
    main { transform-origin: 0 0; }
    #f-fade { position: fixed; inset: 0; background: #000; z-index: 90; pointer-events: none; opacity: 0; }
    #f-cap { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 80; width: max-content; max-width: 1040px; text-align: center;
      font: 600 27px/1.3 system-ui, "Segoe UI", sans-serif; color: #fff; background: rgba(8,8,8,0.88); border: 1px solid rgba(255,255,255,0.14);
      padding: 12px 24px; border-radius: 14px; letter-spacing: -0.005em; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
    #f-spot { position: fixed; z-index: 60; border-radius: 14px; border: 2px solid #3987e5; pointer-events: none; opacity: 0; }
    #f-mask { position: fixed; z-index: 58; border-radius: 16px; box-shadow: 0 0 0 4000px #0d0d0d; pointer-events: none; opacity: 0; }
    #f-stage { position: fixed; inset: 0; z-index: 70; background: #0d0d0d; color: #f0efec; display: none; font-family: system-ui, "Segoe UI", sans-serif; }
    #f-inset { position: fixed; z-index: 65; left: 0; right: 0; top: 0; height: 212px; background: #0d0d0d; color: #f0efec; font-family: system-ui, "Segoe UI", sans-serif; opacity: 0; }
    #f-inset .box { position: absolute; left: 50%; top: 28px; transform: translateX(-50%); width: 760px; background: #1a1a19; border: 1px solid rgba(255,255,255,0.16); border-radius: 14px; padding: 18px 22px; }
    #f-inset .below { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%); width: 760px; }
    .f-eyebrow { font-size: 14px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: #898781; }
    .f-track { height: 24px; background: #2c2c2a; border-radius: 6px; overflow: hidden; }
    .f-people { display: flex; gap: 14px; justify-content: center; }
    .f-p { width: 36px; height: 36px; border-radius: 50%; background: #2c2c2a; position: relative; flex: none; }
    .f-p.want { background: #1a1a19; box-shadow: inset 0 0 0 3px #3987e5; }
    .f-p .say { position: absolute; left: 50%; top: -32px; transform: translateX(-50%); white-space: nowrap; font-size: 14px; color: #f0efec; background: #2c2c2a; padding: 2px 9px; border-radius: 8px; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  document.body.insertAdjacentHTML('beforeend', '<div id="f-stage"></div><div id="f-inset"></div><div id="f-mask"></div><div id="f-spot"></div><div id="f-cap"></div><div id="f-fade"></div>');
  window.scrollTo(0, 0);

  const $ = (sel) => document.querySelector(sel);
  const main = $('main');
  const W = window.innerWidth;
  const H = window.innerHeight;
  const fmt = (x, d = 1) => Number(x).toFixed(d);
  let cam = { x: 0, y: 0, z: 1 };

  /** Where an element sits in the page's own layout, whatever the camera is doing. */
  const place = (sel) => {
    const el = $(sel);
    if (!el) throw new Error(`film: nothing matches ${sel}`);
    const r = el.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return { x: (r.left - m.left) / cam.z, y: (r.top - m.top) / cam.z, w: r.width / cam.z, h: r.height / cam.z };
  };
  /** The camera position that frames an element as asked. */
  const frame = (shot) => {
    const r = place(shot.sel);
    return {
      z: shot.z,
      x: shot.left !== undefined ? shot.left - shot.z * r.x : W / 2 - shot.z * (r.x + r.w / 2),
      y: shot.top !== undefined ? shot.top - shot.z * r.y : H * (shot.ay ?? 0.42) - shot.z * (r.y + r.h / 2),
    };
  };

  const want = [];
  for (let i = 0; i < facts.win.interested; i++) want.push(Math.round((i + 0.5) * (20 / facts.win.interested)) - 1);
  let lastIndex = -1;
  let lastOpen = null;

  function problem(s) {
    const clock = 1 - s.p * 0.97;
    const people = Array.from({ length: 20 }, (_, i) => {
      const order = want.indexOf(i);
      const speaking = order >= 0 && s.waiting > 0 && s.waiting * (want.length + 1) > order + 0.5;
      return `<div class="f-p ${order >= 0 ? 'want' : ''}">${speaking ? '<span class="say">after you</span>' : ''}</div>`;
    }).join('');
    return `
      <div style="position:absolute;left:0;right:0;top:50px;text-align:center"><div class="f-eyebrow">Ordinary crowdfunding</div></div>
      <div style="position:absolute;left:50%;top:100px;transform:translateX(-50%);width:820px;background:#1a1a19;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:26px 30px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px">
          <div style="font-size:30px;font-weight:720;letter-spacing:-0.02em">${facts.win.title}</div>
          <div style="font-size:19px;color:#c3c2b7;white-space:nowrap">goal ${fmt(facts.win.goal)} NEAR</div>
        </div>
        <div class="f-track" style="margin-top:20px"></div>
        <div style="display:flex;justify-content:space-between;margin-top:9px;font-size:17px;color:#898781"><span>0 NEAR pledged</span><span>${s.end > 0 ? 'time is up' : 'time left'}</span></div>
        <div style="height:6px;background:#2c2c2a;border-radius:3px;margin-top:7px;overflow:hidden"><div style="height:100%;width:${clock * 100}%;background:${clock < 0.25 ? '#e66767' : '#898781'}"></div></div>
        <div style="margin-top:20px;height:36px;font-size:21px;font-weight:650;opacity:${s.end}">
          <span style="background:#55544f;color:#f0efec;border-radius:999px;padding:4px 14px;font-size:16px;margin-right:10px;vertical-align:2px">&times; Missed</span>
          ${fmt(facts.win.potential)} NEAR wanted in. Nothing was pledged.
        </div>
      </div>
      <div style="position:absolute;left:0;right:0;top:420px">
        <div class="f-people">${people}</div>
        <div style="text-align:center;margin-top:24px;font-size:20px;color:#c3c2b7">${want.length} of these 20 people want this project. Each is waiting for someone else to go first.</div>
        <div style="text-align:center;margin-top:14px;font-size:20px;color:#f0efec;opacity:${s.risk}">&ldquo;If I pledge and it fails, my money sat locked for nothing.&rdquo;</div>
      </div>`;
  }

  function end(s) {
    return `
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding-bottom:84px">
        <div style="display:flex;align-items:center;gap:16px;font-size:40px;font-weight:750;letter-spacing:-0.02em">
          <svg viewBox="0 0 32 32" width="56" height="56"><rect width="32" height="32" rx="7" fill="#3987e5"/><path d="M8 16h7m0 0l6-7m-6 7l6 7" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          EitherWay
        </div>
        <div style="margin-top:30px;font-size:62px;font-weight:760;letter-spacing:-0.035em;line-height:1.1">Either it gets funded,<br>or <span style="color:#3987e5">you get paid.</span></div>
        <div style="margin-top:26px;font-size:23px;color:#c3c2b7;opacity:${s.p}">Crowdfunding on NEAR, guaranteed by a swarm of AI underwriters.</div>
        <div style="position:absolute;bottom:112px;font-size:16px;color:#898781;opacity:${s.p}">Narration: AI voice.</div>
      </div>`;
  }

  window.__film = (s) => {
    const app = window.__eitherway;
    if (s.open !== lastOpen) {
      document.querySelectorAll('details').forEach((d) => { d.open = false; });
      if (s.open) $(s.open).open = true;
      lastOpen = s.open;
    }
    if (s.player) {
      if (s.player.index !== lastIndex) { app.select(s.player.index); lastIndex = s.player.index; }
      app.state.t = s.player.t;
      app.renderRound();
    }
    if (s.cam) {
      const a = frame(s.cam.a);
      const b = s.cam.k > 0 ? frame(s.cam.b) : a;
      cam = { x: a.x + (b.x - a.x) * s.cam.k, y: a.y + (b.y - a.y) * s.cam.k, z: a.z + (b.z - a.z) * s.cam.k };
      main.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    }

    // Darken everything except the panel the shot is about. During a camera
    // move the mask fades out, changes panel, and fades back in.
    const mask = $('#f-mask');
    const shot = s.cam ? (s.cam.k < 0.5 ? s.cam.a : s.cam.b) : null;
    if (shot && shot.mask) {
      const r = $(shot.maskSel ?? shot.sel).getBoundingClientRect();
      const p = shot.maskPad ?? 14;
      Object.assign(mask.style, {
        left: `${r.left - p}px`, top: `${r.top - p}px`, width: `${r.width + 2 * p}px`, height: `${r.height + 2 * p}px`,
        opacity: s.cam.k === 0 || s.cam.k === 1 ? 1 : Math.abs(2 * s.cam.k - 1),
      });
    } else {
      mask.style.opacity = 0;
    }

    const stage = $('#f-stage');
    stage.style.display = s.stage ? 'block' : 'none';
    if (s.stage) stage.innerHTML = s.stage.name === 'problem' ? problem(s.stage) : end(s.stage);

    const inset = $('#f-inset');
    inset.style.opacity = s.inset ? s.inset.o : 0;
    if (s.inset && s.inset.o > 0) {
      inset.innerHTML = `<div class="box"><div class="f-eyebrow">The same campaign as ordinary crowdfunding</div>
        <div class="f-track" style="margin-top:12px"></div>
        <div style="display:flex;justify-content:space-between;margin-top:9px;font-size:18px;color:#c3c2b7"><span><b style="color:#f0efec;font-size:23px">0.0</b> of ${fmt(facts.win.goal)} NEAR pledged</span><span>${s.inset.p > 0.5 ? '&times; Missed: nobody went first' : 'everyone is waiting'}</span></div></div>
        <div class="below f-eyebrow">With a guarantor</div>`;
    }

    const spot = $('#f-spot');
    const target = s.spot && s.spot.o > 0 ? $(s.spot.sel) : null;
    if (target) {
      const r = target.getBoundingClientRect();
      const p = s.spot.pad ?? 10;
      Object.assign(spot.style, {
        left: `${r.left - p}px`, top: `${r.top - p}px`, width: `${r.width + 2 * p}px`, height: `${r.height + 2 * p}px`,
        opacity: s.spot.o, boxShadow: `0 0 0 4000px rgba(0,0,0,${s.spot.dim ?? 0.5})`,
      });
    } else {
      spot.style.opacity = 0;
    }

    const cap = $('#f-cap');
    cap.textContent = s.caption;
    cap.style.display = s.caption ? 'block' : 'none';
    $('#f-fade').style.opacity = s.fade;
  };
}

// ---- film it -----------------------------------------------------------------------------

const server = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
const stopServer = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stopServer);
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: 'dark', reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
await page.goto(`http://localhost:${PORT}/site/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__eitherway && document.querySelector('#liverounds').children.length > 0 && document.querySelector('#sweep').children.length > 0);

// The page must be showing the crowd the narration was written from.
const shown = await page.evaluate(() => ({ seed: window.__eitherway.state.seed, network: document.querySelector('#livebanner').dataset.network }));
if (shown.seed !== tl.seed) throw new Error(`the page shows crowd ${shown.seed}, the script was written for ${tl.seed}`);
if (tl.onChain !== (shown.network !== 'local')) throw new Error('the narration and the page disagree about whether the swarm ran on testnet: run video/script.mjs and video/voice.py again');
await page.evaluate(installFilmLayer, tl.facts);

mkdirSync(dirname(out), { recursive: true });
const ffmpeg = spawn(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), out], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((resolve, reject) => ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))));

const first = Math.round(from * fps);
const last = Math.round(to * fps);
const began = Date.now();
for (let i = first; i < last; i++) {
  // A busy machine can make one screenshot time out. The frame is drawn for a
  // fixed moment, so trying again gives exactly the same picture.
  let jpeg;
  for (let attempt = 1; !jpeg; attempt++) {
    try {
      await page.evaluate((s) => window.__film(s), stateAt(i / fps));
      jpeg = await page.screenshot({ type: 'jpeg', quality: 93, timeout: 120_000 });
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`  frame ${i}: ${String(e.message).slice(0, 100)}; trying again`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!ffmpeg.stdin.write(jpeg)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
  if ((i - first) % (fps * 10) === 0) console.log(`  ${(i / fps).toFixed(0).padStart(3)} s of ${to.toFixed(0)} s   (${((Date.now() - began) / 1000).toFixed(0)} s spent)`);
}
ffmpeg.stdin.end();
await done;
await browser.close();
stopServer();
console.log(`wrote ${out}: ${last - first} frames at ${fps} fps`);
