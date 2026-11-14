// The live page. It imports the same simulation the command line runs
// (swarm/sim.mjs), so the numbers on screen are computed here, in the
// browser, from the rules engine. Nothing is pre-baked except the two files it
// says it loads: the many-crowds summary and the latest recorded swarm run.

import { compare } from '../swarm/sim.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f = (x, d = 2) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const bps = (x) => `${(x / 100).toFixed(x % 100 === 0 ? 0 : x % 10 === 0 ? 1 : 2)}%`;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const ease = (x) => 1 - (1 - clamp(x, 0, 1)) ** 3;
const short = (id) => String(id).split('.')[0];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TAG = /(^|\s)#([a-z]\w*)/gi; // a hashtag, not "contract#3"
const GLYPH = { funded: '✓', rescued: '+', bonus: '↩', none: '×' };
const LABEL = { funded: 'Funded', rescued: 'Funded, rescued by its guarantor', bonus: 'Fell short, bonus paid', none: 'Fell short, no bonus' };
const outcomeOf = (r) => (r.status === 'Funded' ? (r.rescued ? 'rescued' : 'funded') : r.underwriter && r.bonusPaid > 0 ? 'bonus' : 'none');

// Where each part of a round sits on the playback bar (0..1).
const T = { commit: 0.1, reveal: 0.28, winner: 0.36, fund: 0.42, out: 0.9 };
const PHASES = [['Announced', 0], ['Sealed bids', T.commit], ['Bids opened', T.reveal], ['Pledging', T.fund], ['Outcome', T.out]];

const state = { seed: 7, run: null, index: 0, t: 1, playing: false, raf: 0, sweep: null };

// ---- tooltip -----------------------------------------------------------------------

const tip = $('tip');
const showTip = (target, x, y) => {
  tip.innerHTML = target.dataset.tip;
  tip.classList.add('show');
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${clamp(x + 14, 8, window.innerWidth - w - 8)}px`;
  tip.style.top = `${y + 18 + h > window.innerHeight ? y - h - 12 : y + 18}px`;
};
document.addEventListener('pointermove', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (target) showTip(target, e.clientX, e.clientY); else tip.classList.remove('show');
});
document.addEventListener('focusin', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (!target) return;
  const box = target.getBoundingClientRect();
  showTip(target, box.left, box.bottom);
});
document.addEventListener('focusout', () => tip.classList.remove('show'));

// ---- the round player ---------------------------------------------------------------

const current = () => state.run.eitherway.rounds[state.index];
const plainOf = () => state.run.plain.rounds[state.index];

function renderAsk() {
  const r = current();
  const tagged = esc(
    `${r.title}\n\nGoal: ${f(r.goal, 1)} NEAR. If we fall short, every backer gets their pledge back plus up to ${bps(r.bonusBps)} for the wait, paid by whoever guarantees this.\n\n#eitherway #${r.topic.replace(/\s+/g, '')}`,
  ).replace(TAG, '$1<span class="tag">#$2</span>');
  $('ask').innerHTML = `
    <div class="eyebrow">Campaign ${state.index + 1} of ${state.run.eitherway.rounds.length}</div>
    <h3 style="font-size:22px;margin-top:6px">${esc(r.title)}</h3>
    <div class="post">
      <div class="who"><span class="avatar">${esc(r.organizer.slice(0, 1).toUpperCase() + r.organizer.slice(-1))}</span><div><b>${esc(r.organizer)}</b> <span>on near.social</span></div></div>
      <div class="text">${tagged}</div>
    </div>
    <div class="facts">
      <div class="fact" data-tip="What must be pledged for the project to be funded."><div class="k">Goal</div><div class="v num">${f(r.goal, 1)} <small style="font-size:13px;color:var(--muted)">NEAR</small></div></div>
      <div class="fact" data-tip="The most a backer earns on top if the goal is missed. A pledge made when funding opens earns all of it; later pledges earn less."><div class="k">Bonus if missed</div><div class="v num">up to ${bps(r.bonusBps)}</div></div>
      <div class="fact" data-tip="The most the organizer will pay an underwriter for the guarantee, as a share of the goal. Paid only if the campaign succeeds."><div class="k">Fee limit</div><div class="v num">${bps(r.maxFeeBps)}</div></div>
    </div>`;
  $('which').textContent = `Campaign ${state.index + 1} of ${state.run.eitherway.rounds.length}`;
  $('goalend').textContent = `goal ${f(r.goal, 1)} NEAR`;
}

function renderBids() {
  const r = current();
  const t = state.t;
  const cast = state.run.eitherway.summary.underwriters;
  const fees = r.bids.map((b) => b.feeBps);
  // Scale to the bids themselves; the organizer's limit is often far above them.
  const top = fees.length ? Math.max(...fees, 1) * 1.35 : r.maxFeeBps * 1.1;
  const limitFits = r.maxFeeBps <= top;
  const revealed = t >= T.reveal;
  const decided = t >= T.winner;
  const grow = ease((t - T.reveal) / 0.05); // bars open out as the bids are revealed

  $('bids').innerHTML = cast.map((u, i) => {
    const bid = r.bids.find((b) => b.agent === u.id);
    const passed = r.passed.find((p) => p.agent === u.id);
    const appeared = t >= T.commit + i * 0.03;
    const name = `<div class="name"><b>${esc(u.id)}</b> ${esc(u.style)}</div>`;
    const about = `<b>${esc(u.id)}</b> (${esc(u.style)}): ${esc(u.about)}.`;
    if (!appeared) return `<div class="bid pass">${name}<div class="track"></div><div class="val">&hellip;</div></div>`;
    if (!bid) {
      const why = passed
        ? revealed ? `thought only ${pct(passed.odds)} likely` : 'no bid'
        : 'no bid';
      const tipText = passed
        ? `${about}<br>It put the chance of success at ${pct(passed.odds)}. To take that risk it would have wanted ${bps(passed.feeBps)}, ${passed.feeBps > r.maxFeeBps ? 'more than the organizer allows' : 'and it will not guarantee odds that poor'}.`
        : `${about}<br>It could not afford the bond.`;
      return `<div class="bid pass" data-tip="${esc(tipText)}">${name}<div class="track"></div><div class="val">${why}</div></div>`;
    }
    if (!revealed) {
      return `<div class="bid" data-tip="${esc(about)}<br>Its fee is hidden: only a hash is on chain, and its bond of ${f(r.bond)} NEAR is locked.">${name}<div class="track"><div class="sealed">sealed bid, bond locked</div></div><div class="val">hidden</div></div>`;
    }
    const win = decided && r.underwriter === u.id;
    const tipText = `${about}<br>Asked ${bps(bid.feeBps)}: it put the chance of success at ${pct(bid.odds)}.${win ? `<br>Wins, and is paid ${bps(r.clearingFeeBps)}.` : ''}`;
    return `<div class="bid ${win ? 'win' : ''}" data-tip="${esc(tipText)}">${name}<div class="track"><div class="bar" style="width:${(bid.feeBps / top) * 100 * grow}%"></div></div><div class="val num">${bps(bid.feeBps)}${win ? ' wins' : ''}</div></div>`;
  }).join('');

  const at = (v) => `${(v / top) * 100}%`;
  const paidFits = decided && r.underwriter && r.clearingFeeBps <= top && r.clearingFeeBps / top > 0.1 &&
    (!limitFits || Math.abs(r.clearingFeeBps - r.maxFeeBps) / top > 0.2);
  $('bidaxis').innerHTML =
    `<div class="mark" style="left:0"><span style="transform:none">0%</span></div>` +
    (limitFits ? `<div class="mark" style="left:${at(r.maxFeeBps)}"><span>organizer's limit ${bps(r.maxFeeBps)}</span></div>` : `<div class="mark" style="left:100%;border:0"><span style="transform:translateX(-100%)">organizer's limit: ${bps(r.maxFeeBps)}</span></div>`) +
    (paidFits ? `<div class="mark" style="left:${at(r.clearingFeeBps)}"><span>paid ${bps(r.clearingFeeBps)}</span></div>` : '');

  let note = '';
  if (t < T.commit) note = 'Underwriters are reading the announcement and how much interest it drew.';
  else if (!revealed) note = r.bids.length ? `${plural(r.bids.length, 'underwriter')} sent a sealed bid and locked a bond of <b>${f(r.bond)} NEAR</b> each. Nobody can see anyone's fee yet.` : 'No sealed bids came in.';
  else if (!decided) note = 'The bids are open.';
  else if (r.underwriter) {
    const mine = r.bids.find((b) => b.agent === r.underwriter);
    const lone = r.bids.filter((b) => b.revealed).length === 1;
    note = `<b>${esc(r.underwriter)}</b> asked the least (${bps(mine.feeBps)}) and guarantees the campaign. It is paid ${lone ? `the organizer's limit, <b>${bps(r.clearingFeeBps)}</b>, as the only bidder` : `the runner-up's price, <b>${bps(r.clearingFeeBps)}</b>`}. At that fee it breaks even if campaigns like this succeed <b>${pct(r.impliedOdds)}</b> of the time.`;
  } else {
    note = '<b>No underwriter would guarantee this campaign</b> at a fee the organizer accepts. It runs as an ordinary all-or-nothing campaign: if it fails, pledges come back with no bonus.';
  }
  $('bidnote').innerHTML = note;
}

function renderPledges() {
  const r = current();
  const t = state.t;
  const fundAt = clamp((t - T.fund) / (T.out - T.fund), 0, 1);
  const shown = t < T.fund ? [] : r.pledges.filter((p) => p.at <= fundAt + 1e-9);
  const raised = shown.reduce((s, p) => s + p.amount, 0);
  const guaranteed = Boolean(r.underwriter);

  $('meter').innerHTML = shown.map((p) => {
    const bonus = guaranteed ? p.amount * (r.bonusBps / 10000) * (1 - p.at) : 0;
    const tipText = p.kind === 'rescue'
      ? `<b>${esc(p.agent)}</b>, the guarantor, fills the last ${f(p.amount)} NEAR itself. That is cheaper than paying the bonuses.`
      : `<b>${esc(p.agent)}</b> (${esc(p.kind)}) pledges ${f(p.amount)} NEAR, ${pct(p.at)} of the way through the window.` +
        (guaranteed ? `<br>If the goal is missed it gets that back plus ${f(bonus, 3)} NEAR.` : '<br>No guarantor: if the goal is missed it just gets its pledge back.');
    const arrive = t >= 1 ? 1 : ease((fundAt - p.at) / 0.04);
    return `<div class="seg ${p.kind === 'rescue' ? 'rescue' : ''}" style="width:${(p.amount / r.goal) * 100 * arrive}%" data-tip="${esc(tipText)}" tabindex="0"></div>`;
  }).join('');
  $('clock').style.width = `${fundAt * 100}%`;
  $('raised').innerHTML = t < T.fund
    ? 'Funding has not opened yet.'
    : `<b class="num">${f(raised, 1)}</b> of ${f(r.goal, 1)} NEAR pledged by ${plural(new Set(shown.map((p) => p.agent)).size, 'backer')}`;

  const kinds = {};
  for (const p of shown) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
  const about = { believer: 'pledge as soon as funding opens', follower: 'join once enough others have, or at once if the bonus covers the wait', holdout: 'hope others pay; step in only if needed', hunter: 'do not want the project; pledge early for the bonus', rescue: 'the guarantor filling the last gap' };
  $('kinds').innerHTML = Object.entries(kinds).map(([k, n]) =>
    `<span class="chip" data-tip="${esc(k === 'rescue' ? about.rescue : `${k[0].toUpperCase() + k.slice(1)}s ${about[k]}.`)}">${k === 'rescue' ? 'rescue by the guarantor' : plural(n, k)}</span>`).join('');

  const box = $('outcome');
  if (t < T.out) { box.classList.remove('show'); return; }
  const kind = outcomeOf(r);
  const o = plainOf();
  let body;
  if (kind === 'funded' || kind === 'rescued') {
    body = `<p><b>${esc(r.organizer)}</b> received <b>${f(r.paidOut)} NEAR</b> from ${plural(r.backers, 'backer')}.` +
      (r.underwriter ? ` <b>${esc(r.underwriter)}</b> got its bond back and earned a <b>${f(r.fee)} NEAR</b> fee.` : ' Nobody guaranteed this one, and it made it anyway.') + '</p>' +
      (kind === 'rescued' ? `<p>It was close, so the guarantor pledged the last stretch itself: cheaper than paying every backer a bonus.</p>` : '');
  } else if (kind === 'bonus') {
    body = `<p>It reached ${pct(r.raised / r.goal)} of the goal. All ${plural(r.backers, 'backer')} got their pledge back, plus <b>${f(r.bonusPaid)} NEAR</b> in bonuses paid by <b>${esc(r.underwriter)}</b>. The organizer got nothing.</p>`;
  } else if (r.underwriter) {
    body = `<p>Nobody pledged, so there was nothing to refund. <b>${esc(r.underwriter)}</b> got its whole bond back.</p>`;
  } else {
    body = `<p>It reached ${pct(r.raised / r.goal)} of the goal with no guarantor. ${r.raised > 0 ? `${f(r.raised, 1)} NEAR was returned to ${plural(r.backers, 'backer')} with no bonus: money that sat locked for nothing.` : 'Nobody was willing to go first.'}</p>`;
  }
  const same = o.status === 'Funded' ? 'it was <b>funded</b> too' : `it reached <b>${pct(o.raised / o.goal)}</b> and failed`;
  box.innerHTML = `<div class="head"><span class="badge ${kind}">${GLYPH[kind]} ${LABEL[kind]}</span></div>${body}
    <p class="versus">The same campaign as ordinary crowdfunding, with the same crowd: ${same}. Money that wanted in was <b>${f(r.demandRatio)} times</b> the goal.</p>`;
  box.classList.add('show');
}

function renderPhases() {
  let on = 0;
  PHASES.forEach(([, start], i) => { if (state.t >= start) on = i; });
  $('phases').innerHTML = PHASES.map(([name], i) => `<span class="phase ${i === on ? 'on' : ''}">${name}</span>`).join('');
}

function renderRound() {
  renderPhases();
  renderBids();
  renderPledges();
  $('scrub').value = Math.round(state.t * 1000);
  document.querySelectorAll('.cell').forEach((c) => c.classList.toggle('sel', Number(c.dataset.i) === state.index));
}

function select(index, play = false) {
  const n = state.run.eitherway.rounds.length;
  state.index = ((index % n) + n) % n;
  stop();
  state.t = play ? 0 : 1;
  renderAsk();
  renderRound();
  if (play) start();
}

function start() {
  if (state.t >= 1) state.t = 0;
  state.playing = true;
  $('play').textContent = 'Pause';
  let last = performance.now();
  const step = (now) => {
    if (!state.playing) return;
    state.t = Math.min(1, state.t + (now - last) / 14000);
    last = now;
    renderRound();
    if (state.t >= 1) stop(); else state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}
function stop() {
  state.playing = false;
  cancelAnimationFrame(state.raf);
  $('play').textContent = state.t >= 1 ? 'Play' : 'Resume';
}

// ---- with and without ------------------------------------------------------------------

function renderCompare() {
  const { plain, eitherway } = state.run;
  const row = (label, run, note) => `
    <div>
      <div class="rowlabel"><span><b>${label}</b></span><span>${note}</span></div>
      <div class="cells">${run.rounds.map((r, i) => {
        const k = outcomeOf(r);
        const tipText = `<b>${i + 1}. ${esc(r.title)}</b><br>${LABEL[k]}: ${f(r.raised, 1)} of ${f(r.goal, 1)} NEAR.<br>Money that wanted in: ${f(r.demandRatio)} times the goal.`;
        return `<button class="cell ${k}" data-i="${i}" data-tip="${esc(tipText)}" aria-label="Campaign ${i + 1}: ${LABEL[k]}">${GLYPH[k]}</button>`;
      }).join('')}</div>
    </div>`;
  $('rows').innerHTML =
    row('Ordinary crowdfunding', plain, `${plain.summary.funded} of ${plain.summary.rounds} funded`) +
    row('With EitherWay', eitherway, `${eitherway.summary.funded} of ${eitherway.summary.rounds} funded`);
  $('rows').querySelectorAll('.cell').forEach((c) => c.addEventListener('click', () => {
    select(Number(c.dataset.i), true);
    $('round').scrollIntoView({ behavior: 'smooth' });
  }));

  const p = plain.summary;
  const e = eitherway.summary;
  const stat = (k, v, tipText) => `<div class="stat" data-tip="${esc(tipText)}"><div class="k">${k}</div><div class="v num">${v}</div></div>`;
  $('stats').innerHTML =
    stat('Campaigns funded', `${p.funded} <small>to</small> ${e.funded} <small>of ${e.rounds}</small>`, 'Ordinary crowdfunding, then with underwriters. Same crowd, same campaigns.') +
    stat('Of those enough people wanted', `${p.viableFunded} <small>to</small> ${e.viableFunded} <small>of ${e.viable}</small>`, 'Counting only campaigns where the crowd wanted to give at least the goal. The others should fail, and do.') +
    stat('NEAR that reached projects', `${f(p.paidToProjects, 0)} <small>to</small> ${f(e.paidToProjects, 0)}`, 'Paid out to organizers of funded campaigns, after underwriter fees.') +
    stat('Tied up for nothing', `${f(p.lockedForNothing, 0)} <small>to</small> ${f(e.lockedForNothing, 0)} <small>NEAR</small>`, `Pledged to a campaign that failed and came back with no bonus. With underwriters, backers of failed campaigns were paid ${f(e.bonusPaid, 1)} NEAR in bonuses instead.`);
}

function renderSweep(s, mine = false) {
  if (!s) {
    $('sweeptitle').textContent = 'Across many different crowds';
    $('sweephint').textContent = 'The precomputed summary is not available here. Use the button below to compute one in your browser.';
    $('sweep').innerHTML = '';
    return;
  }
  $('sweeptitle').textContent = mine ? `Across ${s.seeds} new crowds, computed just now in this browser` : `Across ${s.seeds} different crowds`;
  $('sweephint').textContent = `${f(s.campaigns, 0)} campaigns run each way. EitherWay funded more campaigns in ${s.eitherWayBetterIn} of ${s.seeds} crowds and fewer in ${s.eitherWayWorseIn}.`;
  const pair = (title, a, b) => `
    <div class="pair"><div class="t">${title}</div>
      <div class="hbar"><span>Ordinary</span><div class="track"><div class="fill" style="width:${a * 100}%"></div><span class="lab num" style="left:${a * 100}%">${pct(a)}</span></div></div>
      <div class="hbar"><span>With EitherWay</span><div class="track"><div class="fill ew" style="width:${b * 100}%"></div><span class="lab num" style="left:${b * 100}%">${pct(b)}</span></div></div>
    </div>`;
  $('sweep').innerHTML =
    pair('Campaigns funded', s.fundedPlain, s.fundedEitherWay) +
    pair('Campaigns funded, counting only those enough people wanted', s.viableFundedPlain, s.viableFundedEitherWay);
}

function renderTiles(s) {
  const e = state.run.eitherway.summary;
  const p = state.run.plain.summary;
  const tile = (from, to, cap) => `<div class="tile"><div class="big num"><span class="from">${from}</span><span class="arrow">&rarr;</span><span>${to}</span></div><div class="cap">${cap}</div></div>`;
  if (s) {
    const less = 1 - s.lockedForNothingEitherWay / s.lockedForNothingPlain;
    $('tiles').innerHTML =
      tile(pct(s.fundedPlain), pct(s.fundedEitherWay), 'of campaigns funded') +
      tile(pct(s.viableFundedPlain), pct(s.viableFundedEitherWay), 'of the campaigns enough people wanted') +
      `<div class="tile"><div class="big num">${pct(less)} less</div><div class="cap">money tied up in failed campaigns for nothing</div></div>`;
    $('tilesnote').innerHTML = `In simulation: the same ${s.seeds} crowds run as ordinary crowdfunding, then with underwriters. <a href="#compare">How the simulation works</a>.`;
  } else {
    $('tiles').innerHTML =
      tile(`${p.funded}`, `${e.funded}`, `of ${e.rounds} campaigns funded, in the crowd shown below`) +
      tile(`${p.viableFunded}`, `${e.viableFunded}`, `of the ${e.viable} campaigns enough people wanted`) +
      `<div class="tile"><div class="big num">${f(e.bonusPaid, 1)} NEAR</div><div class="cap">paid to backers of campaigns that fell short</div></div>`;
    $('tilesnote').innerHTML = 'In simulation, for the crowd shown below. <a href="#compare">How the simulation works</a>.';
  }
}

// ---- underwriters -----------------------------------------------------------------------

function renderUnderwriters() {
  const list = state.run.eitherway.summary.underwriters;
  const top = Math.max(0.5, ...list.map((u) => Math.abs(u.profit)));
  $('uwtitle').textContent = `Profit and loss in crowd ${state.seed}`;
  $('uw').innerHTML = list.map((u) => {
    const w = (Math.abs(u.profit) / top) * 46;
    const neg = u.profit < 0;
    const tipText = `<b>${esc(u.id)}</b> won ${plural(u.won, 'auction')}: ${u.funded} funded, ${u.failed} fell short.<br>Fees earned ${f(u.fees)} NEAR. Bonuses paid ${f(u.bonuses)} NEAR.${u.profit < u.fees - u.bonuses - 0.005 ? '<br>The rest went on filling last gaps itself.' : ''}`;
    return `<div class="uwrow" data-tip="${esc(tipText)}">
      <div class="name"><b>${esc(u.id)}</b> ${esc(u.style)}<span>${esc(u.about)}</span></div>
      <div class="div"><div class="zero" style="left:50%"></div>
        <div class="fill ${neg ? 'neg' : ''}" style="${neg ? `right:50%;width:${w}%` : `left:50%;width:${w}%`}"></div>
        <span class="lab num" style="${neg ? `right:calc(50% + ${w}% + 8px)` : `left:calc(50% + ${w}% + 8px)`}">${neg ? '−' : '+'}${f(Math.abs(u.profit))}</span>
      </div></div>`;
  }).join('');
  const s = state.sweep;
  $('uwnote').innerHTML = s
    ? `Across ${s.seeds} crowds, mean profit per crowd: ${Object.entries(s.underwriterProfit).map(([k, v]) => `${k} ${v.mean >= 0 ? '+' : '−'}${f(Math.abs(v.mean))}`).join(', ')}. ` +
      (state.pros ? `With five competent underwriters and no amateurs, ${pct(state.pros.fundedEitherWay)} of campaigns are still funded, and the underwriters as a group ${state.pros.underwriterGroupProfit >= 0 ? 'earn' : 'lose'} ${f(Math.abs(state.pros.underwriterGroupProfit))} NEAR per crowd.${state.pros.underwriterGroupProfit >= 0 ? ' So the result does not depend on careless underwriters paying for it.' : ''}` : '')
    : '';
}

// ---- the live swarm -----------------------------------------------------------------------

async function getJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function renderLive(run) {
  const banner = $('livebanner');
  if (!run) {
    $('livebannertext').innerHTML = 'No recorded run yet. Start one with <code>node swarm/live.mjs --local</code>, or on testnet after <code>node scripts/setup.mjs</code>.';
    return;
  }
  const onChain = !['local', 'local rehearsal'].includes(run.network);
  const tx = (hash) => (hash && onChain ? `<a class="txl mono" href="${esc(run.explorer)}/txns/${esc(hash)}" target="_blank" rel="noopener">${esc(hash.slice(0, 6))}&hellip;</a>` : '');
  const acct = (id) => (onChain ? `<a href="${esc(run.explorer)}/address/${esc(id)}" target="_blank" rel="noopener">${esc(short(id))}</a>` : esc(short(id)));
  const when = new Date(run.startedAt).toUTCString().replace('GMT', 'UTC');
  banner.classList.toggle('on', onChain);
  banner.dataset.network = onChain ? run.network : 'local';
  $('livebannertext').innerHTML = onChain
    ? `<b>Recorded on NEAR ${esc(run.network)}</b>, ${esc(when)}. Contract <a href="${esc(run.explorer)}/address/${esc(run.contract)}" target="_blank" rel="noopener" class="mono">${esc(run.contract)}</a>. Every transaction below links to the explorer. ${run.llm ? `Interest and the guarantor's note were judged by ${esc(run.llm)} on NEAR AI Cloud.` : 'Agents used scripted strategies (no model calls).'}`
    : `<b>Latest recorded run</b>, ${esc(when)}: ${run.rounds.length} campaigns, run on a local chain. ${run.llm ? `Interest and the guarantor's notes were judged by ${esc(run.llm)} on NEAR AI Cloud.` : 'Agents used scripted strategies.'}`;

  // Latest campaign first.
  $('liverounds').innerHTML = [...run.rounds].reverse().map((r) => {
    const kind = outcomeOf(r);
    const text = esc(r.post.text).replace(TAG, '$1<span class="tag">#$2</span>');
    const bids = r.bids.length
      ? `<table><tr><th>Underwriter</th><th class="r">Asked</th><th class="r">Odds it saw</th><th></th></tr>${r.bids.map((b) =>
          `<tr><td>${acct(b.agent)} <span style="color:var(--muted)">${esc(b.style)}</span>${b.agent === r.underwriter ? ' <b>wins</b>' : ''}${b.note ? `<div style="color:var(--ink-2);font-size:13px">&ldquo;${esc(b.note)}&rdquo;</div>` : ''}</td><td class="r num">${bps(b.feeBps)}</td><td class="r num">${pct(b.odds)}</td><td class="r">${tx(b.commitTx)} ${tx(b.revealTx)}</td></tr>`).join('')}
          ${r.passed.map((p) => `<tr><td>${acct(p.agent)} <span style="color:var(--muted)">${esc(p.style)}</span></td><td class="r" style="color:var(--muted)">passed</td><td class="r num">${pct(p.odds)}</td><td></td></tr>`).join('')}</table>`
      : `<p style="color:var(--ink-2);font-size:14.5px;margin-top:8px">No underwriter bid. ${r.passed.map((p) => `${esc(short(p.agent))} saw ${pct(p.odds)}`).join(', ')}.</p>`;
    const pledges = r.pledges.length
      ? `<div class="scroll"><table><tr><th>Backer</th><th class="r">Pledged</th><th class="r">When</th><th class="r">Bonus</th><th></th></tr>${r.pledges.map((p) =>
          `<tr><td>${acct(p.agent)} <span style="color:var(--muted)">${esc(p.kind)}</span></td><td class="r num">${f(p.amount, 4)}</td><td class="r num">${pct(p.at)}</td><td class="r num">${p.bonus ? `+${f(p.bonus, 4)}` : ''}</td><td class="r">${tx(p.tx)}</td></tr>`).join('')}</table></div>`
      : '<p style="color:var(--ink-2);font-size:14.5px;margin-top:8px">Nobody pledged.</p>';
    const guarantee = r.underwriter
      ? `${acct(r.underwriter)} guarantees it for ${bps(r.clearingFeeBps)}, bond ${f(r.bond, 4)} NEAR`
      : 'No guarantor';
    const result = kind === 'funded' || kind === 'rescued'
      ? `${f(r.paidOut, 4)} NEAR paid to ${esc(short(r.organizer))}${r.underwriter ? `; ${esc(short(r.underwriter))} earned ${f(r.fee, 4)} NEAR` : ''}.`
      : r.underwriter ? `${plural(r.backers, 'backer')} refunded, plus ${f(r.bonusPaid, 4)} NEAR in bonuses from ${esc(short(r.underwriter))}.` : `${plural(r.backers, 'backer')} refunded, no bonus.`;
    const initials = (id) => esc(short(id).slice(0, 1).toUpperCase() + short(id).slice(-1));
    const thread = r.thread.filter((x) => x.text && x.text !== 'guarantee').map((x) =>
      `<div class="post" style="margin-left:22px"><div class="who"><span class="avatar">${initials(x.author)}</span><div><b>${acct(x.author)}</b> <span>${x.author === r.organizer ? 'organizer' : 'guarantor'}, reply ${tx(x.tx)}</span></div></div><div class="text">${esc(x.text).replace(TAG, '$1<span class="tag">#$2</span>')}</div></div>`).join('');
    return `<div class="card lr">
      <div>
        <h3><span class="badge ${kind}">${GLYPH[kind]} ${LABEL[kind]}</span> ${esc(r.title)}</h3>
        <div class="post">
          <div class="who"><span class="avatar">${esc(short(r.organizer).slice(0, 1).toUpperCase() + short(r.organizer).slice(-1))}</span><div><b>${acct(r.organizer)}</b> <span>announcement ${tx(r.post.tx)}</span></div></div>
          <div class="text">${text}</div>
          <div class="meta"><span>${plural(r.interested.length, 'like')} from backer agents</span><span>goal ${f(r.goal, 4)} NEAR</span><span>bonus up to ${bps(r.bonusBps)}</span></div>
        </div>
        ${thread}
      </div>
      <div>
        <div class="subhead" style="margin-top:0">Sealed-bid auction</div>${bids}
        <p style="font-size:14.5px;margin-top:8px"><b>${guarantee}</b> ${tx(r.txs.settle)}</p>
        <div class="subhead">Pledges: ${f(r.raised, 4)} of ${f(r.goal, 4)} NEAR</div>${pledges}
        <p style="font-size:14.5px;margin-top:10px"><b>${result}</b> ${tx(r.txs.finalize)}</p>
      </div>
    </div>`;
  }).join('');

  $('castbox').style.display = '';
  $('cast').innerHTML = `<tr><th>Account</th><th>Role</th><th>What its user told it</th></tr>` + run.cast.map((a) =>
    `<tr><td class="mono">${onChain ? `<a href="${esc(run.explorer)}/address/${esc(a.id)}" target="_blank" rel="noopener">${esc(a.id)}</a>` : esc(a.id)}</td><td>${esc(a.role)}${a.kind ? `, ${esc(a.kind)}` : ''}${a.style ? `, ${esc(a.style)}` : ''}</td><td>${esc(a.mandate ?? a.about ?? '')}</td></tr>`).join('');
}

// ---- wiring --------------------------------------------------------------------------------

function load(seed) {
  state.seed = seed;
  $('seed').value = seed;
  state.run = compare(seed);
  state.index = Math.min(state.index, state.run.eitherway.rounds.length - 1);
  renderTiles(state.sweep);
  renderCompare();
  renderUnderwriters();
  select(state.index);
}

$('play').addEventListener('click', () => (state.playing ? stop() : start()));
$('prev').addEventListener('click', () => select(state.index - 1));
$('next').addEventListener('click', () => select(state.index + 1));
$('scrub').addEventListener('input', (e) => { stop(); state.t = Number(e.target.value) / 1000; renderRound(); $('play').textContent = state.t >= 1 ? 'Play' : 'Resume'; });
$('seed').addEventListener('change', (e) => load(clamp(Math.round(Number(e.target.value)) || 1, 1, 99999)));
$('shuffle').addEventListener('click', () => load(1 + Math.floor(Math.random() * 9999)));

$('rerun').addEventListener('click', async () => {
  const button = $('rerun');
  button.disabled = true;
  const total = 40;
  const acc = { rounds: 0, fp: 0, fe: 0, v: 0, vp: 0, ve: 0, better: 0, worse: 0, lp: 0, le: 0 };
  for (let i = 0; i < total; i++) {
    $('rerunstate').textContent = `crowd ${i + 1} of ${total}`;
    await new Promise((r) => setTimeout(r, 0));
    const run = compare(100000 + Math.floor(Math.random() * 900000));
    const p = run.plain.summary;
    const e = run.eitherway.summary;
    acc.rounds += p.rounds; acc.fp += p.funded; acc.fe += e.funded; acc.v += e.viable; acc.vp += p.viableFunded; acc.ve += e.viableFunded;
    acc.better += e.funded > p.funded ? 1 : 0; acc.worse += e.funded < p.funded ? 1 : 0;
    acc.lp += p.lockedForNothing; acc.le += e.lockedForNothing;
  }
  renderSweep({
    seeds: total, campaigns: acc.rounds, fundedPlain: acc.fp / acc.rounds, fundedEitherWay: acc.fe / acc.rounds,
    viableFundedPlain: acc.vp / acc.v, viableFundedEitherWay: acc.ve / acc.v, eitherWayBetterIn: acc.better, eitherWayWorseIn: acc.worse,
  }, true);
  $('rerunstate').textContent = 'Done. These crowds were drawn at random just now.';
  button.disabled = false;
});

// A handle for the script that films the demo video (video/film.mjs).
window.__eitherway = { state, T, load, select, renderRound };

// First paint with one crowd, then bring in the precomputed files.
load(7);
(async () => {
  [state.sweep, state.pros] = await Promise.all([getJson('../data/sweep.json'), getJson('../data/sweep-pros.json')]);
  renderTiles(state.sweep);
  renderSweep(state.sweep);
  renderUnderwriters();
  renderLive(await getJson('../data/latest.json'));
})();
