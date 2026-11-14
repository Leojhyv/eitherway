// The swarm, live: 20 backer agents, 5 underwriter agents and 3 organizers
// acting in real time, each from its own account.
//
//   node swarm/live.mjs --local            local run: rules engine in memory, no keys needed
//   node swarm/live.mjs                    NEAR testnet: real transactions (run scripts/setup.mjs first)
//
//   --rounds 3            campaigns to run
//   --seed 7              which crowd (same seeds as the simulation)
//   --windows 90,45,150   commit, reveal and funding windows in seconds
//   --scale 0.01          shrink every amount (on testnet: the scale setup recorded)
//   --save run.json       write the run record there instead of data/
//   --llm                 let a model judge interest and write the guarantor's note (needs NEARAI_API_KEY)
//   --speed 20            local runs only: fast-forward the clock
//
// The agents are the same classes the simulation uses (swarm/agents.mjs).
// Here they find campaigns through near.social posts, signal interest with
// likes, and act through the contract. Every run is saved under data/runs/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, breakEvenOdds } from '../engine/market.mjs';
import { normal, shuffle, stream, uniform } from '../engine/rng.mjs';
import { GAS, LocalChain, NearChain } from './chain.mjs';
import { Llm, mandateText } from './llm.mjs';
import { Rpc, TxError, formatNear, parseNear } from './near.mjs';
import { DEFAULTS, PROJECTS, TOPICS, buildCast, near, num } from './sim.mjs';
import { KvSocial, LocalSocial } from './social.mjs';
import { ROOT, loadConfig, loadKey } from '../scripts/keys.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const local = args.includes('--local');
// On testnet, scripts/setup.mjs records the seed and scale it funded the agents for.
const deploymentFile = join(ROOT, 'data', 'deployment.json');
const deployment = !local && existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, 'utf8')) : null;
const seed = Number(flag('seed', deployment?.seed ?? 7));
const rounds = Number(flag('rounds', 3));
const scale = Number(flag('scale', local ? 1 : deployment?.scale ?? 0.01));
const saveTo = flag('save');
const [commitSecs, revealSecs, fundingSecs] = flag('windows', local ? '10,10,30' : '90,45,150').split(',').map(Number);
const pollMs = Number(flag('poll', local ? 500 : 4000));
const useLlm = args.includes('--llm');
const speed = local ? Number(flag('speed', 1)) : 1;
const quiet = args.includes('--quiet');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));
const started = Date.now();
const log = (line) => { if (!quiet) console.log(`[${String(Math.round(((Date.now() - started) * speed) / 1000)).padStart(4)}s] ${line}`); };
const scaled = (yocto) => (yocto * BigInt(Math.round(scale * 1e6))) / 1000000n;
const fmt = (yocto) => formatNear(yocto, 4);
const pct = (bps) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
const tag = (topic) => topic.replace(/\s+/g, '');

/** Runs `fn` over items, a few at a time. Failures are returned, not thrown. */
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: e }; }
    }
  }));
  return out;
}

// ---- cast, chain, social ---------------------------------------------------------

const config = local ? { parent: null, contract: 'escrow.local', explorer: '' } : loadConfig();
const fullName = (id) => (local ? id : `${id}.${config.parent}`);

const cast = buildCast(seed);
for (const b of cast.backers) { b.id = fullName(b.id); b.cap = scaled(b.cap); }
for (const u of cast.underwriters) u.id = fullName(u.id);
const organizers = cast.organizers.map((o) => ({ ...o, id: fullName(o.id) }));
const agents = [...cast.backers, ...cast.underwriters];
const capital = scaled(near(DEFAULTS.capital));
const short = (id) => id.split('.')[0];

let chain;
let social;
if (local) {
  chain = new LocalChain({ speed });
  social = new LocalSocial();
  // Funded as scripts/setup.mjs funds them on testnet: two allowances (or the
  // capital) plus 0.05 NEAR for gas, topped up when a wallet runs low.
  const forGas = parseNear('0.05');
  for (const b of cast.backers) chain.fund(b.id, b.cap * 2n + forGas);
  for (const u of cast.underwriters) chain.fund(u.id, capital + forGas);
  for (const o of organizers) chain.fund(o.id, forGas + parseNear('0.02') * BigInt(rounds));
} else {
  const rpc = new Rpc(config.rpc, { log });
  const keys = [...agents.map((a) => a.id), ...organizers.map((o) => o.id)].map(loadKey);
  chain = new NearChain({ rpc, contractId: config.contract, keys, explorer: config.explorer, parentKey: loadKey(config.parent) });
  social = new KvSocial({ network: config.network, accounts: chain.accounts, log });
}
const llm = new Llm({ log });
if (useLlm && !llm.available) throw new Error('--llm needs NEARAI_API_KEY in the environment');

/** Free balance inside the contract, tracked locally between reads to save RPC calls. */
const balance = new Map();
const refresh = async (ids) => {
  const views = await pool(ids, 4, (id) => chain.view('get_account', { account_id: id }));
  ids.forEach((id, i) => { if (!views[i].error) balance.set(id, BigInt(views[i].balance)); });
};

/** The most gas each kind of call burnt, to show the limits in GAS (chain.mjs) leave room. */
const gasUsed = {};
let roundNow = 0;

/** Sends one contract call for an agent and reports what happened. */
async function act(who, method, callArgs, opts = {}) {
  try {
    const r = await chain.call(who, method, callArgs, opts);
    if (r.gasBurnt) {
      const g = (gasUsed[method] ??= { calls: 0, attachedTgas: GAS[method], maxBurntTgas: 0 });
      g.calls++;
      g.maxBurntTgas = Math.max(g.maxBurntTgas, Math.round(Number(r.gasBurnt) / 1e10) / 100);
    }
    return { ok: true, hash: r.hash, value: r.value };
  } catch (e) {
    if (!(e instanceof TxError)) throw e;
    // The wallet could not cover the deposit and the gas NEAR holds back while
    // the call runs: top it up from the parent once, and try again.
    const lack = e.message.match(/"NotEnoughBalance":\{"balance":"(\d+)","cost":"(\d+)"/);
    if (lack && !opts.retried && (await topUp(who, BigInt(lack[2]) - BigInt(lack[1]) + FEE_BUFFER, roundNow, ` to cover ${method}`))) {
      return act(who, method, callArgs, { ...opts, retried: true });
    }
    if (method === 'pledge' && e.code === 'E_PHASE') log(`  ${short(who).padEnd(10)} was too late: the campaign had just closed`);
    else log(`  ${short(who)} ${method} was rejected: ${e.message.slice(0, 90)}`);
    return { ok: false, hash: e.hash, error: e.message };
  }
}

// ---- wallets -----------------------------------------------------------------------

// Kept in an agent's own account after a deposit: enough for the gas NEAR
// holds back on its next calls (a pledge or a bid: about 0.021 NEAR) and fees.
const FEE_BUFFER = parseNear('0.03');
const topUps = [];
async function topUp(who, give, roundNo, why = '') {
  try {
    const r = await chain.topUp(who, give);
    topUps.push({ agent: who, amount: num(give), round: roundNo, tx: r.hash });
    log(`  ${short(who)}'s wallet topped up with ${fmt(give)} NEAR from the parent account${why}`);
    return true;
  } catch (e) {
    log(`  could not top up ${short(who)}: ${String(e.message).slice(0, 90)}`);
    return false;
  }
}
/** Tops an agent's own account up from the parent when it cannot cover `amount` and what it keeps for gas. */
async function ensureWallet(who, amount, roundNo) {
  let wallet;
  try { wallet = await chain.walletBalance(who); } catch { return; }
  const missing = amount + FEE_BUFFER - wallet;
  if (missing > 0n) await topUp(who, missing + FEE_BUFFER, roundNo);
}

// ---- one round ---------------------------------------------------------------------

const run = {
  network: local ? 'local' : config.network,
  contract: chain.contractId,
  explorer: config.explorer,
  seed, scale, windows: { commitSecs, revealSecs, fundingSecs },
  llm: useLlm ? llm.model : null,
  startedAt: new Date().toISOString(),
  cast: [
    ...cast.backers.map((b) => ({ id: b.id, role: 'backer', kind: b.kind, cap: num(b.cap), mandate: mandateText(b, 1) })),
    ...cast.underwriters.map((u) => ({ id: u.id, role: 'underwriter', style: u.style, about: u.cfg.about })),
    ...organizers.map((o) => ({ id: o.id, role: 'organizer', about: o.about })),
  ],
  rounds: [],
};

/** What one like is typically worth in pledges. Underwriters learn it as they go. */
let perLike = (num(cast.backers.reduce((s, b) => s + b.cap, 0n)) / cast.backers.length) * 0.75;

async function waitFor(id, wanted) {
  for (;;) {
    const c = await chain.view('get_campaign', { campaign_id: id });
    if (wanted.includes(c.phase)) return c;
    await sleep(pollMs);
  }
}

async function playRound(index) {
  roundNow = index;
  const r = stream(seed, `live:${index}`);
  const organizer = organizers[Math.floor(r() * organizers.length)];
  const topic = TOPICS[Math.floor(r() * TOPICS.length)];
  const title = PROJECTS[topic][Math.floor(r() * PROJECTS[topic].length)];

  // The organizer sizes the goal from its own sense of demand (see sim.mjs).
  let potential = 0n;
  const taste = new Map();
  for (const b of cast.backers) {
    if (b.kind === 'hunter') continue;
    const weight = b.interests[topic] ?? 0;
    const t = weight === 0 ? 0 : Math.min(1, weight * (0.6 + 0.8 * stream(seed, `live-taste:${b.id}:${index}`)()));
    taste.set(b.id, t);
    potential += (b.cap * BigInt(Math.round(t * 1000))) / 1000n;
  }
  const demandRatio = Math.min(2.6, Math.max(0.45, organizer.demand * Math.exp(DEFAULTS.demandSpread * normal(r))));
  const floor = scaled(near(1)) > LIMITS.MIN_GOAL ? scaled(near(1)) : LIMITS.MIN_GOAL;
  let goal = near(Math.round((num(potential) / demandRatio) * 1e4) / 1e4);
  if (goal < floor) goal = floor;
  const bonusBps = [300, 500, 500, 800][Math.floor(r() * 4)];
  const maxFeeBps = Math.round(bonusBps * uniform(r, 1.1, 1.7));

  // 1. Announce on near.social and open the campaign. The post id is chosen
  //    first so the campaign can point at its announcement for ever.
  const postId = social.nextId();
  const ref = `${organizer.id}/${postId}`;
  const created = await act(organizer.id, 'create_campaign', {
    title, goal: goal.toString(), bonus_bps: bonusBps, max_fee_bps: maxFeeBps,
    commit_secs: commitSecs, reveal_secs: revealSecs, funding_secs: fundingSecs,
    beneficiary: organizer.id, social_post: ref,
  });
  if (!created.ok) throw new Error(`could not create the campaign: ${created.error}`);
  const id = created.value;
  const text =
    `${title}\n\nGoal: ${fmt(goal)} NEAR. If we fall short, every backer gets their pledge back ` +
    `plus up to ${pct(bonusBps)} for the wait, paid by whoever guarantees this.\n\n` +
    `#eitherway #${tag(topic)}\ncampaign ${chain.contractId}#${id}`;
  const announced = await social.post(organizer.id, text, postId);
  log(`campaign ${id}: "${title}" by ${short(organizer.id)}: goal ${fmt(goal)} NEAR, bonus ${pct(bonusBps)}, max fee ${pct(maxFeeBps)}`);

  const round = {
    id, title, topic, organizer: organizer.id, goal: num(goal), bonusBps, maxFeeBps,
    demandRatio: Math.round(demandRatio * 100) / 100,
    post: { ref, text, tx: announced.hash },
    txs: { create: created.hash },
    interested: [], bids: [], passed: [], pledges: [], thread: [],
  };
  await refresh(agents.map((a) => a.id));

  // 2. Backer agents read the announcement and decide whether their user
  //    cares. Those who do say so in public, with a like.
  const posted = await (async () => {
    for (let i = 0; i < 20; i++) {
      const p = await social.getPost(ref);
      if (p) return p;
      await sleep(1500);
    }
    return { text };
  })();
  await pool(cast.backers, useLlm ? 4 : 20, async (b) => {
    if (b.kind === 'hunter') return;
    let match = taste.get(b.id) ?? 0;
    let why;
    if (useLlm) {
      const judged = await llm.match(mandateText(b, 1), { title, text: posted.text });
      if (judged) ({ match, why } = judged);
      // A faint match is not interest: the user did not ask for this.
      if (match < 0.35) match = 0;
    }
    b.match.set(id, match);
    if (b.valueFor({ id, topic }) >= LIMITS.MIN_PLEDGE) {
      const liked = await social.like(b.id, ref);
      round.interested.push({ agent: b.id, match: Math.round(match * 100) / 100, why, tx: liked.hash });
    }
  });
  log(`  ${round.interested.length} of ${cast.backers.length} backer agents liked the announcement`);

  // Read the interest back from near.social, as anyone could, giving the
  // indexer a few seconds to catch up with the likes just sent.
  let likes = 0;
  for (let i = 0; i < 10; i++) {
    try { likes = (await social.likers(ref)).length; } catch { /* indexer busy: try again */ }
    if (likes >= round.interested.length) break;
    await sleep(2000);
  }
  if (likes === 0) likes = round.interested.length; // indexer unreachable: fall back to our own count

  // 3. Underwriter agents read that interest and send sealed bids.
  const opened = (await chain.view('get_campaign', { campaign_id: id }));
  const commitFor = opened.commit_end - chain.now();
  // Leave the underwriters time to get their bids in.
  const margin = local ? 4_000 : 25_000;
  if (commitFor > margin) await sleep(Math.min(commitFor - margin, commitSecs * 400));
  const record = await chain.view('get_account', { account_id: organizer.id });
  const base = (likes * perLike) / num(goal);
  round.likes = likes;
  await pool(cast.underwriters, 5, async (u) => {
    let hint = base * Math.exp(u.cfg.noise * 0.5 * normal(stream(seed, `live-hint:${u.id}:${index}`)));
    let note;
    if (useLlm) {
      const read = await llm.assess(
        `Campaign: ${title}\nGoal: ${fmt(goal)} NEAR\nBonus if it fails: ${pct(bonusBps)} (you would pay it)\n` +
          `Interest so far: ${likes} likes on the announcement; one like has typically meant about ${perLike.toFixed(3)} NEAR pledged\n` +
          `Organizer's record: ${record.org_funded} funded, ${record.org_failed} failed`,
      );
      if (read) { hint *= Math.exp(0.15 * read.lean); note = read.why; }
    }
    const c = await chain.view('get_campaign', { campaign_id: id });
    const view = { now: chain.now(), minPledge: LIMITS.MIN_PLEDGE, me: { id: u.id, balance: balance.get(u.id) ?? 0n }, campaigns: [{ ...c, topic, guaranteed: false, organizer_record: record, hint }] };
    for (const a of u.decide(view)) {
      if (a.type !== 'commit') continue;
      const sent = await act(u.id, 'commit_bid', { campaign_id: id, commitment: a.commitment });
      if (sent.ok) {
        balance.set(u.id, (balance.get(u.id) ?? 0n) - BigInt(c.bond));
        round.bids.push({ agent: u.id, style: u.style, feeBps: a.note.feeBps, odds: Math.round(a.note.odds * 100) / 100, note, revealed: false, commitTx: sent.hash });
      } else {
        u.sealed.set(id, { ...u.sealed.get(id), passed: true });
      }
    }
    const s = u.sealed.get(id);
    if (s?.passed) round.passed.push({ agent: u.id, style: u.style, odds: Math.round(s.odds * 100) / 100, feeBps: s.feeBps });
  });
  log(`  ${round.bids.length} sealed bids in (${round.passed.length} underwriters passed)`);

  // 4. Reveal.
  await waitFor(id, ['Reveal', 'Funding', 'Expired']);
  await pool(cast.underwriters, 5, async (u) => {
    const c = await chain.view('get_campaign', { campaign_id: id });
    const view = { now: chain.now(), minPledge: LIMITS.MIN_PLEDGE, me: { id: u.id, balance: balance.get(u.id) ?? 0n }, campaigns: [{ ...c, topic, guaranteed: false }] };
    for (const a of u.decide(view)) {
      if (a.type !== 'reveal') continue;
      const sent = await act(u.id, 'reveal_bid', { campaign_id: id, fee_bps: a.feeBps, salt: a.salt });
      const bid = round.bids.find((b) => b.agent === u.id);
      if (sent.ok && bid) { bid.revealed = true; bid.revealTx = sent.hash; }
    }
  });

  // 5. Settle the auction. Anyone may; here the organizer does.
  await waitFor(id, ['Funding', 'Expired']);
  const settled = await act(organizer.id, 'settle_auction', { campaign_id: id });
  round.txs.settle = settled.hash;
  let c = await chain.view('get_campaign', { campaign_id: id });
  await refresh(cast.underwriters.map((u) => u.id));
  if (c.underwriter) {
    const odds = breakEvenOdds(bonusBps, c.clearing_fee_bps);
    const winner = round.bids.find((b) => b.agent === c.underwriter);
    log(`  ${short(c.underwriter)} guarantees it for a ${pct(c.clearing_fee_bps)} fee (its own bid: ${pct(winner?.feeBps ?? 0)}), bond ${fmt(c.bond)} NEAR`);
    const pledgeText =
      `I am guaranteeing this campaign. I have locked ${fmt(c.bond)} NEAR: if the goal is missed, it pays every backer's bonus. ` +
      `My fee if it succeeds: ${pct(c.clearing_fee_bps)}.${winner?.note ? ` Why: ${winner.note}` : ''} #eitherway`;
    const reply = await social.reply(c.underwriter, pledgeText, ref);
    round.thread.push({ author: c.underwriter, role: 'guarantor', tx: reply.hash, text: pledgeText });
    round.impliedOdds = Math.round(odds * 100) / 100;
  } else {
    log('  no underwriter would guarantee it at this fee: it runs as an ordinary all-or-nothing campaign');
  }

  // 6. Funding. Every agent gets a look each tick and decides for itself.
  const order = stream(seed, `live-order:${index}`);
  while (c.phase === 'Funding') {
    const now = chain.now();
    const wanted = [];
    for (const agent of shuffle(order, agents)) {
      const view = { now, minPledge: LIMITS.MIN_PLEDGE, me: { id: agent.id, balance: balance.get(agent.id) ?? 0n }, campaigns: [{ ...c, topic, guaranteed: c.auction_settled && c.underwriter !== null }] };
      for (const a of agent.decide(view)) if (a.type === 'pledge') wanted.push({ agent, a });
    }
    await pool(wanted, 6, async ({ agent, a }) => {
      const sent = await act(agent.id, 'pledge', { campaign_id: id, amount: a.amount.toString() });
      if (!sent.ok) return;
      const taken = BigInt(sent.value);
      balance.set(agent.id, (balance.get(agent.id) ?? 0n) - taken);
      const at = Math.min(1, Math.max(0, (now - c.reveal_end) / (c.deadline - c.reveal_end)));
      round.pledges.push({ agent: agent.id, kind: a.note?.rescue ? 'rescue' : agent.kind ?? agent.role, amount: num(taken), at: Math.round(at * 100) / 100, tx: sent.hash });
      log(`  ${short(agent.id).padEnd(10)} ${a.note?.rescue ? 'fills the gap with' : 'pledges'} ${fmt(taken)} NEAR`);
    });
    await sleep(pollMs);
    c = await chain.view('get_campaign', { campaign_id: id });
  }

  // 7. Close it. If the goal was missed, anyone can trigger the refunds.
  if (c.status === 'Open') {
    c = await waitFor(id, ['Expired', 'Funded', 'Failed']);
    for (let tries = 0; !c.closed && tries < 8; tries++) {
      const done = await act(organizer.id, 'finalize', { campaign_id: id, limit: 50 });
      round.txs.finalize = done.hash;
      c = await chain.view('get_campaign', { campaign_id: id });
      if (!done.ok && !c.closed) await sleep(pollMs);
    }
    if (!c.closed) log('  the campaign did not close yet; anyone can still call finalize on it');
  }
  const funded = c.status === 'Funded';
  const pledges = await chain.view('get_pledges', { campaign_id: id, from_index: 0, limit: 200 });
  const bids = await chain.view('get_bids', { campaign_id: id });
  const fee = funded && c.underwriter ? (BigInt(c.goal) * BigInt(c.clearing_fee_bps)) / 10000n : 0n;
  const outcome = funded
    ? `Funded: ${fmt(c.goal)} NEAR from ${c.backer_count} backers.${c.underwriter ? ` ${short(c.underwriter)} earned its ${fmt(fee)} NEAR fee for guaranteeing it.` : ''} Thank you. #eitherway`
    : c.backer_count === 0
      ? `We fell short of ${fmt(c.goal)} NEAR: nobody pledged, so there is nothing to refund. #eitherway`
      : `We fell short: ${fmt(c.raised)} of ${fmt(c.goal)} NEAR. All ${c.backer_count} backers have their pledge back` +
        `${c.underwriter ? `, plus ${fmt(c.bonus_paid)} NEAR in bonuses paid by ${short(c.underwriter)}` : ''}. #eitherway`;
  const closing = await social.reply(organizer.id, outcome, ref);
  round.thread.push({ author: organizer.id, role: 'organizer', tx: closing.hash, text: outcome });
  log(`  ${funded ? 'FUNDED' : 'FELL SHORT'}: ${fmt(c.raised)} of ${fmt(c.goal)} NEAR from ${c.backer_count} backers` +
    (funded ? '' : c.underwriter ? `; ${fmt(c.bonus_paid)} NEAR paid in bonuses` : '; pledges returned, no bonus'));

  for (const u of cast.underwriters) u.learn(c, funded);
  // A funded campaign proves each like was worth at least goal / likes. A
  // failed one proves nothing (people may simply have held back), so only
  // funded campaigns move the estimate.
  if (funded && likes > 0) perLike = 0.7 * perLike + 0.3 * Math.max(perLike, num(c.goal) / likes);

  Object.assign(round, {
    status: c.status, raised: num(c.raised), backers: c.backer_count, bond: num(c.bond),
    underwriter: c.underwriter, clearingFeeBps: c.clearing_fee_bps, fee: num(fee), bonusPaid: num(c.bonus_paid),
    paidOut: funded ? num(BigInt(c.goal) - fee) : 0,
    rescued: round.pledges.some((p) => p.kind === 'rescue'),
    chainBids: bids, chainPledges: pledges, campaign: c,
  });
  for (const p of round.pledges) {
    const onChain = pledges.find((x) => x.account === p.agent);
    if (onChain) p.bonus = funded || !c.underwriter ? 0 : num(onChain.bonus);
  }
  run.rounds.push(round);

  // Next round's allowance for the backers who spent theirs.
  await refresh(agents.map((a) => a.id));
  await pool(cast.backers, 4, async (b) => {
    const have = balance.get(b.id) ?? 0n;
    if (have >= b.cap) return;
    await ensureWallet(b.id, b.cap - have, index + 1);
    const sent = await act(b.id, 'deposit', {}, { deposit: b.cap - have });
    if (sent.ok) balance.set(b.id, b.cap);
  });
}

// ---- main --------------------------------------------------------------------------

log(`${run.network}: ${cast.backers.length} backers, ${cast.underwriters.length} underwriters, ${organizers.length} organizers; contract ${chain.contractId}`);
log(`windows: commit ${commitSecs}s, reveal ${revealSecs}s, funding ${fundingSecs}s; amounts x${scale}${useLlm ? `; model ${llm.model}` : '; scripted (no model calls)'}`);

// Each agent moves its budget into the contract once (R1). After that it can
// act without attaching NEAR, and the contract can never send it anywhere else.
await refresh(agents.map((a) => a.id));
await pool(agents, 4, async (a) => {
  const want = a.role === 'backer' ? a.cap : capital;
  const have = balance.get(a.id) ?? 0n;
  if (have < want) {
    await ensureWallet(a.id, want - have, 0);
    const sent = await act(a.id, 'deposit', {}, { deposit: want - have });
    if (sent.ok) balance.set(a.id, want);
  }
});
const startBalances = new Map(balance);

for (let i = 0; i < rounds; i++) await playRound(i);

await refresh(agents.map((a) => a.id));
run.finishedAt = new Date().toISOString();
run.totals = await chain.view('get_totals');
run.results = {
  funded: run.rounds.filter((x) => x.status === 'Funded').length,
  failed: run.rounds.filter((x) => x.status === 'Failed').length,
  bonusPaid: run.rounds.reduce((s, x) => s + x.bonusPaid, 0),
  feesPaid: run.rounds.reduce((s, x) => s + x.fee, 0),
  underwriters: await Promise.all(cast.underwriters.map(async (u) => {
    const a = await chain.view('get_account', { account_id: u.id });
    return { id: u.id, style: u.style, profit: num(BigInt(a.balance) - capital), won: a.uw_won, funded: a.uw_funded, failed: a.uw_failed, fees: num(a.uw_fees), bonuses: num(a.uw_bonus_paid) };
  })),
  modelCalls: llm.calls, modelTokens: llm.tokens,
  toppedUp: num(chain.toppedUp),
};
run.topUps = topUps;
run.gas = gasUsed;
void startBalances;

const stamp = run.startedAt.replace(/[:.]/g, '-');
const name = local ? 'local' : config.network;
const body = JSON.stringify(run, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
let savedAs = saveTo;
if (saveTo) {
  writeFileSync(saveTo, body);
} else {
  const dir = join(ROOT, 'data', 'runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}-${stamp}.json`), body);
  writeFileSync(join(ROOT, 'data', `latest-${name}.json`), body);
  // The page shows data/latest.json. A local run never replaces a testnet run there.
  if (!local || !existsSync(join(ROOT, 'data', 'latest-testnet.json'))) writeFileSync(join(ROOT, 'data', 'latest.json'), body);
  savedAs = `data/latest-${name}.json`;
}

log('');
log(`${run.results.funded} funded, ${run.results.failed} fell short; bonuses paid ${run.results.bonusPaid.toFixed(4)} NEAR, fees earned ${run.results.feesPaid.toFixed(4)} NEAR`);
for (const u of run.results.underwriters) log(`  ${short(u.id)} (${u.style}): won ${u.won}, profit ${u.profit >= 0 ? '+' : ''}${u.profit.toFixed(4)} NEAR`);
if (topUps.length) log(`${topUps.length} wallet top-ups from the parent account, ${num(chain.toppedUp).toFixed(4)} NEAR in all`);
const gasLine = Object.entries(gasUsed).map(([m, g]) => `${m} ${g.maxBurntTgas} of ${g.attachedTgas}`).join(', ');
if (gasLine) log(`most gas burnt per call, in Tgas (of what was attached): ${gasLine}`);
log(`saved ${savedAs}`);
if (quiet) console.log(`seed ${seed}: ` + run.rounds.map((x) => `${x.status === 'Funded' ? (x.rescued ? 'RESCUED' : 'funded') : x.underwriter ? `short+bonus(${x.bonusPaid.toFixed(2)})` : 'short'}${x.underwriter ? '' : '(no guarantor)'}`).join(' | '));
