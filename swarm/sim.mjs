// Simulation mode: the whole market with scripted agents, no chain and no
// model calls. Runs the same agent code (swarm/agents.mjs) against the same
// rules (engine/market.mjs) the contract enforces.
//
// It works in Node and in the browser, and is fully repeatable from a seed.
//
// The comparison it is built for: the same crowd, the same projects, the same
// wishes, run twice. Once as ordinary all-or-nothing crowdfunding (nobody
// guarantees anything), once with underwriters bidding to guarantee each
// campaign. See README.md for what this does and does not show.

import { Market, NEAR, BPS, LIMITS, breakEvenOdds } from '../engine/market.mjs';
import { stream, normal, uniform, shuffle } from '../engine/rng.mjs';
import { Backer, Underwriter, UNDERWRITER_STYLES } from './agents.mjs';

const MICRO = NEAR / 1000000n;
export const near = (x) => BigInt(Math.round(x * 1e6)) * MICRO;
export const num = (yocto) => Number(BigInt(yocto) / MICRO) / 1e6;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pad = (i) => String(i).padStart(2, '0');

export const PROJECTS = {
  'dev tools': ['Open-source indexer starter kit', 'Editor extension for near-sdk', 'Contract fuzzing harness', 'One-command local testnet'],
  education: ['Rust for NEAR video course', 'Student workshop series', 'Docs translated into Hindi', 'Beginner guide to NEAR accounts'],
  community: ['Builder meetup in Lagos', 'Hackathon travel fund', 'Monthly builder newsletter', 'Community call recordings archive'],
  infrastructure: ['Public archival RPC node', 'A testnet faucet that does not run dry', 'Validator uptime monitor', 'Open status page for NEAR RPCs'],
  research: ['Study of fees across NEAR Intents routes', 'Report on agent spending patterns', 'Benchmark of agent marketplaces', 'Survey of sub-account usage'],
  art: ['Open icon set for NEAR apps', 'Short documentary on builders', 'Poster series for meetups', 'Illustrated NEAR explainer'],
};
export const TOPICS = Object.keys(PROJECTS);

export const DEFAULTS = Object.freeze({
  rounds: 30,
  backers: 20,
  // How the crowd splits, as in the brief: 20 buyers with scripted strategies.
  mix: { believer: 3, follower: 9, holdout: 6, hunter: 2 },
  underwriters: ['sharp', 'careful', 'steady', 'bold', 'rookie'],
  // Organizers differ in how well they size a goal. `demand` is the typical
  // ratio of money that wants in to the goal they set.
  organizers: [
    { id: 'org-1', about: 'sizes goals conservatively', demand: 1.45 },
    { id: 'org-2', about: 'sizes goals about right', demand: 1.15 },
    { id: 'org-3', about: 'asks for too much', demand: 0.85 },
  ],
  demandSpread: 0.3,
  capital: 40,           // NEAR each underwriter starts with
  ticks: 20,             // decision points in the funding window
  guarantee: true,       // false = ordinary crowdfunding, same crowd
});

/** The cast. Preferences come from the seed only, so both regimes share them. */
export function buildCast(seed, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const kinds = Object.entries(o.mix).flatMap(([kind, count]) => Array(count).fill(kind));
  const order = shuffle(stream(seed, 'kinds'), kinds);
  const backers = order.slice(0, o.backers).map((kind, i) => {
    const r = stream(seed, `backer:${i}`);
    const picked = shuffle(r, TOPICS).slice(0, 2 + Math.floor(r() * 2));
    const interests = Object.fromEntries(picked.map((t, j) => [t, j === 0 ? 1 : 0.5 + 0.5 * r()]));
    return new Backer({
      id: `backer-${pad(i + 1)}`,
      kind,
      cap: near(uniform(r, 4, 12)),
      interests,
      lockCostBps: Math.round(uniform(r, 100, 700)),
      joinAt: uniform(r, 0.15, 0.6),
      rnd: stream(seed, `backer-rnd:${i}`),
    });
  });
  const underwriters = o.underwriters.map(
    (style, i) => new Underwriter({ id: `uw-${i + 1}`, style, rnd: stream(seed, `uw:${i}`) }),
  );
  return { backers, underwriters, organizers: o.organizers };
}

/** Runs `rounds` campaigns one after another. Returns every round and a summary. */
export function runSimulation(seed, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { backers, underwriters, organizers } = buildCast(seed, o);
  const m = new Market();
  const byId = new Map([...backers, ...underwriters].map((a) => [a.id, a]));
  const order = stream(seed, `order:${o.guarantee}`);
  const rounds = [];
  const lockedForNothing = new Map(backers.map((b) => [b.id, 0n]));

  for (const u of underwriters) m.deposit(u.id, near(o.capital));

  for (let round = 0; round < o.rounds; round++) {
    const r = stream(seed, `round:${round}`);
    const t0 = round * 1_000_000;
    const organizer = organizers[Math.floor(r() * organizers.length)];
    const topic = TOPICS[Math.floor(r() * TOPICS.length)];
    const title = PROJECTS[topic][Math.floor(r() * PROJECTS[topic].length)];
    const id = m.campaigns.length;

    // What each backer would put in. Fixed by the seed, identical in both regimes.
    let potential = 0n;
    let interested = 0;
    for (const b of backers) {
      if (b.kind === 'hunter') continue;
      const weight = b.interests[topic] ?? 0;
      const taste = stream(seed, `taste:${b.id}:${round}`)();
      b.match.set(id, weight === 0 ? 0 : clamp(weight * (0.6 + 0.8 * taste), 0, 1));
      const value = b.valueFor({ id, topic });
      if (value >= LIMITS.MIN_PLEDGE) { potential += value; interested += 1; }
    }

    const demandRatio = clamp(organizer.demand * Math.exp(o.demandSpread * normal(r)), 0.45, 2.6);
    const goal = near(Math.max(1, Math.round((num(potential) / demandRatio) * 100) / 100));
    const bonusBps = [300, 500, 500, 800][Math.floor(r() * 4)];
    const maxFeeBps = Math.round(bonusBps * uniform(r, 1.1, 1.7));

    for (const b of backers) {
      const have = BigInt(m.accountView(b.id).balance);
      if (have < b.cap) m.deposit(b.id, b.cap - have); // this round's allowance
    }

    m.createCampaign(organizer.id, {
      title, socialPost: '', beneficiary: organizer.id, goal, bonusBps, maxFeeBps,
      commitSecs: 60, revealSecs: 60, fundingSecs: 600,
    }, t0);
    const record = m.accountView(organizer.id);
    const before = new Map(underwriters.map((u) => [u.id, BigInt(m.accountView(u.id).balance)]));

    const log = { bids: [], passed: [], pledges: [] };
    const viewFor = (agent, now, extra = {}) => {
      const c = m.campaignView(id, now);
      return {
        now,
        minPledge: LIMITS.MIN_PLEDGE,
        me: { id: agent.id, balance: BigInt(m.accountView(agent.id).balance) },
        campaigns: [{ ...c, topic, guaranteed: c.auction_settled && c.underwriter !== null, organizer_record: record, ...extra }],
      };
    };
    const act = (agent, action, now) => {
      try {
        if (action.type === 'commit') {
          m.commitBid(agent.id, action.id, action.commitment, now);
          log.bids.push({ agent: agent.id, style: agent.style, feeBps: action.note.feeBps, odds: action.note.odds, revealed: false });
        } else if (action.type === 'reveal') {
          m.revealBid(agent.id, action.id, action.feeBps, action.salt, now);
          log.bids.find((b) => b.agent === agent.id).revealed = true;
        } else if (action.type === 'pledge') {
          const c = m.campaigns[action.id];
          const at = clamp((now - c.revealEnd) / (c.deadline - c.revealEnd), 0, 1);
          const taken = m.pledge(agent.id, action.id, action.amount, now);
          log.pledges.push({ at, agent: agent.id, kind: action.note?.rescue ? 'rescue' : agent.kind ?? agent.role, amount: num(taken) });
        }
      } catch (e) {
        if (e.code === undefined) throw e; // a rule saying no is normal; anything else is a bug
      }
    };

    // Commit and reveal. Each underwriter sees its own noisy read of demand.
    if (o.guarantee) {
      for (const u of underwriters) {
        const hint = demandRatio * Math.exp(u.cfg.noise * normal(stream(seed, `hint:${u.id}:${round}`)));
        for (const a of u.decide(viewFor(u, t0 + 20_000, { hint }))) act(u, a, t0 + 20_000);
        const s = u.sealed.get(id);
        if (s?.passed) log.passed.push({ agent: u.id, style: u.style, feeBps: s.feeBps, odds: s.odds });
      }
      for (const u of underwriters) for (const a of u.decide(viewFor(u, t0 + 80_000))) act(u, a, t0 + 80_000);
    }
    m.settleAuction(id, t0 + 120_000);

    // Funding: everyone gets a look at each tick, in random order.
    const step = 600_000 / o.ticks;
    for (let tick = 0; tick < o.ticks && m.campaigns[id].status === 'Open'; tick++) {
      const now = t0 + 120_000 + Math.floor(tick * step);
      for (const agent of shuffle(order, [...backers, ...underwriters])) {
        if (m.campaigns[id].status !== 'Open') break;
        for (const a of agent.decide(viewFor(agent, now))) act(agent, a, now);
      }
    }

    const end = t0 + 725_000;
    if (m.campaigns[id].status === 'Open') while (!m.campaigns[id].closed) m.finalize(id, end);
    const c = m.campaignView(id, end);
    const funded = c.status === 'Funded';
    for (const u of underwriters) u.learn(c, funded);

    const raw = m.campaigns[id];
    if (!funded && !c.underwriter) {
      for (const [who, amount] of raw.pledges) lockedForNothing.set(who, (lockedForNothing.get(who) ?? 0n) + amount);
    }
    const fee = funded && c.underwriter ? (BigInt(c.goal) * BigInt(c.clearing_fee_bps)) / BPS : 0n;

    rounds.push({
      id, organizer: organizer.id, title, topic,
      goal: num(c.goal), bonusBps, maxFeeBps, bond: num(c.bond),
      demandRatio: Math.round(demandRatio * 100) / 100,
      potential: num(potential),
      interested,
      bids: log.bids, passed: log.passed,
      underwriter: c.underwriter,
      clearingFeeBps: c.clearing_fee_bps,
      impliedOdds: c.underwriter ? breakEvenOdds(bonusBps, c.clearing_fee_bps) : null,
      pledges: log.pledges,
      status: c.status,
      raised: num(c.raised),
      backers: c.backer_count,
      fee: num(fee),
      bonusPaid: num(c.bonus_paid),
      paidOut: funded ? num(BigInt(c.goal) - fee) : 0,
      underwriterDelta: c.underwriter ? num(BigInt(m.accountView(c.underwriter).balance) - before.get(c.underwriter)) : 0,
      rescued: log.pledges.some((p) => p.kind === 'rescue'),
    });
  }

  // I1 and I5 must hold at the end of every run.
  const t = m.totals();
  if (t.vault !== t.free || t.bonds !== 0n || t.pledges !== 0n) throw new Error('simulation broke conservation');

  const viable = rounds.filter((x) => x.demandRatio >= 1);
  const summary = {
    rounds: rounds.length,
    funded: rounds.filter((x) => x.status === 'Funded').length,
    viable: viable.length,
    viableFunded: viable.filter((x) => x.status === 'Funded').length,
    guaranteed: rounds.filter((x) => x.underwriter).length,
    rescued: rounds.filter((x) => x.rescued).length,
    paidToProjects: rounds.reduce((s, x) => s + x.paidOut, 0),
    feesPaid: rounds.reduce((s, x) => s + x.fee, 0),
    bonusPaid: rounds.reduce((s, x) => s + x.bonusPaid, 0),
    lockedForNothing: num([...lockedForNothing.values()].reduce((a, b) => a + b, 0n)),
    underwriters: underwriters.map((u) => {
      const a = m.accountView(u.id);
      return {
        id: u.id, style: u.style, about: UNDERWRITER_STYLES[u.style].about,
        profit: num(BigInt(a.balance) - near(o.capital)),
        won: a.uw_won, funded: a.uw_funded, failed: a.uw_failed,
        fees: num(a.uw_fees), bonuses: num(a.uw_bonus_paid),
      };
    }),
    backers: backers.map((b) => {
      const a = m.accountView(b.id);
      return { id: b.id, kind: b.kind, pledged: num(a.bk_pledged), bonus: num(a.bk_bonus), lockedForNothing: num(lockedForNothing.get(b.id)) };
    }),
  };
  return { seed, guarantee: o.guarantee, rounds, summary };
}

/** The same seed twice: ordinary crowdfunding, then EitherWay. */
export function compare(seed, opts = {}) {
  return {
    seed,
    plain: runSimulation(seed, { ...opts, guarantee: false }),
    eitherway: runSimulation(seed, { ...opts, guarantee: true }),
  };
}

/** Many seeds, for an answer that does not depend on one lucky crowd. */
export function sweep(seeds, opts = {}) {
  const rows = seeds.map((seed) => {
    const { plain, eitherway } = compare(seed, opts);
    return { seed, plain: plain.summary, eitherway: eitherway.summary };
  });
  const total = (pick) => rows.reduce((s, row) => s + pick(row), 0);
  const rate = (a, b) => (b === 0 ? 0 : a / b);
  const profitByStyle = {};
  for (const row of rows) {
    for (const u of row.eitherway.underwriters) {
      (profitByStyle[u.style] ??= []).push(u.profit);
    }
  }
  return {
    seeds: seeds.length,
    campaigns: total((x) => x.plain.rounds),
    fundedPlain: rate(total((x) => x.plain.funded), total((x) => x.plain.rounds)),
    fundedEitherWay: rate(total((x) => x.eitherway.funded), total((x) => x.eitherway.rounds)),
    viableFundedPlain: rate(total((x) => x.plain.viableFunded), total((x) => x.plain.viable)),
    viableFundedEitherWay: rate(total((x) => x.eitherway.viableFunded), total((x) => x.eitherway.viable)),
    paidToProjectsPlain: total((x) => x.plain.paidToProjects),
    paidToProjectsEitherWay: total((x) => x.eitherway.paidToProjects),
    lockedForNothingPlain: total((x) => x.plain.lockedForNothing),
    lockedForNothingEitherWay: total((x) => x.eitherway.lockedForNothing),
    bonusPaid: total((x) => x.eitherway.bonusPaid),
    feesPaid: total((x) => x.eitherway.feesPaid),
    guaranteedShare: rate(total((x) => x.eitherway.guaranteed), total((x) => x.eitherway.rounds)),
    rescued: total((x) => x.eitherway.rescued),
    eitherWayBetterIn: rows.filter((x) => x.eitherway.funded > x.plain.funded).length,
    eitherWayWorseIn: rows.filter((x) => x.eitherway.funded < x.plain.funded).length,
    underwriterGroupProfit: Object.values(profitByStyle).flat().reduce((a, b) => a + b, 0) / rows.length,
    underwriterProfit: Object.fromEntries(
      Object.entries(profitByStyle).map(([style, list]) => [style, {
        mean: list.reduce((a, b) => a + b, 0) / list.length,
        lostMoneyShare: list.filter((p) => p < 0).length / list.length,
      }]),
    ),
  };
}
