// Writes engine/fixtures/scenarios.json: scripted and random call sequences,
// with what the JavaScript engine answered to each call and the final state.
// contract/core/tests/differential.rs replays the same calls through the Rust
// rules and requires identical answers, error codes and balances.
//
//   node engine/fixtures.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Market, RuleError, NEAR, commitment } from './market.mjs';
import { mulberry32 } from './rng.mjs';

const n = (x) => BigInt(Math.round(x * 1e6)) * (NEAR / 1000000n);
const S = 1000;

// Every participant gets a valid NEAR account id, so the same scenarios can be
// replayed through the built contract (contract/vm), which checks them.
const FULL = { A: 'alice', B: 'bob', C: 'carol', x: 'xena', y: 'yuri', z: 'zed' };
const acct = (name) => `${FULL[name] ?? name}.test`;

/** Runs calls against a fresh market and records each one. */
class Recorder {
  constructor(name) {
    this.name = name;
    this.m = new Market();
    this.ops = [];
    this.seen = new Set();
  }
  #run(t, op, fn) {
    const entry = { t, ...op };
    try {
      const value = fn();
      entry.ok = true;
      if (value !== undefined) entry.value = typeof value === 'bigint' ? value.toString() : value;
    } catch (e) {
      if (!(e instanceof RuleError)) throw e;
      entry.ok = false;
      entry.code = e.code;
    }
    entry.vault = this.m.vault.toString();
    this.ops.push(entry);
    return entry.ok;
  }
  deposit(t, who, amount) {
    who = acct(who);
    this.seen.add(who);
    return this.#run(t, { op: 'deposit', who, amount: amount.toString() }, () => this.m.deposit(who, amount));
  }
  withdraw(t, who, amount) {
    who = acct(who);
    this.seen.add(who);
    return this.#run(t, { op: 'withdraw', who, amount: amount.toString() }, () => this.m.withdraw(who, amount));
  }
  create(t, who, p) {
    who = acct(who);
    p = { ...p, beneficiary: acct(p.beneficiary) };
    this.seen.add(who).add(p.beneficiary);
    const op = {
      op: 'create', who, title: p.title, social_post: p.socialPost ?? '', beneficiary: p.beneficiary,
      goal: p.goal.toString(), bonus_bps: p.bonusBps, max_fee_bps: p.maxFeeBps,
      commit_secs: p.commitSecs, reveal_secs: p.revealSecs, funding_secs: p.fundingSecs,
    };
    return this.#run(t, op, () => this.m.createCampaign(who, p, t));
  }
  commit(t, who, id, fee, salt, attached = 0n) {
    who = acct(who);
    this.seen.add(who);
    const hex = commitment(id, who, fee, salt);
    return this.#run(t, { op: 'commit', who, id, commitment: hex, attached: attached.toString() }, () => this.m.commitBid(who, id, hex, t, attached));
  }
  commitRaw(t, who, id, hex) {
    who = acct(who);
    this.seen.add(who);
    return this.#run(t, { op: 'commit', who, id, commitment: hex, attached: '0' }, () => this.m.commitBid(who, id, hex, t));
  }
  reveal(t, who, id, fee, salt) {
    who = acct(who);
    this.seen.add(who);
    return this.#run(t, { op: 'reveal', who, id, fee_bps: fee, salt }, () => this.m.revealBid(who, id, fee, salt, t));
  }
  settle(t, id) {
    return this.#run(t, { op: 'settle', id }, () => this.m.settleAuction(id, t));
  }
  pledge(t, who, id, amount, attached = 0n) {
    who = acct(who);
    this.seen.add(who);
    return this.#run(t, { op: 'pledge', who, id, amount: amount.toString(), attached: attached.toString() }, () => this.m.pledge(who, id, amount, t, attached));
  }
  finalize(t, id, limit = 100) {
    return this.#run(t, { op: 'finalize', id, limit }, () => this.m.finalize(id, t, limit));
  }
  finish(t) {
    const { m } = this;
    const accounts = {};
    for (const who of [...this.seen].sort()) accounts[who] = m.accountView(who);
    return {
      name: this.name,
      ops: this.ops,
      final: {
        t,
        vault: m.vault.toString(),
        accounts,
        campaigns: m.campaigns.map((c) => m.campaignView(c.id, t)),
        bids: m.campaigns.map((c) => m.bidsView(c.id)),
        pledges: m.campaigns.map((c) => m.pledgesView(c.id)),
      },
    };
  }
}

const base = { title: 'Open-source indexer', socialPost: 'org/1794000000000', beneficiary: 'org', goal: n(100), bonusBps: 500, maxFeeBps: 600, commitSecs: 60, revealSecs: 60, fundingSecs: 60 };

function workedExample(name, fundIt) {
  const r = new Recorder(name);
  for (const a of ['A', 'B', 'C', 'x', 'y']) r.deposit(0, a, n(1000));
  r.create(0, 'org', base);
  r.commit(1 * S, 'A', 0, 200, 'sa'); r.commit(2 * S, 'B', 0, 350, 'sb'); r.commit(3 * S, 'C', 0, 500, 'sc');
  r.reveal(61 * S, 'C', 0, 500, 'sc'); r.reveal(62 * S, 'A', 0, 200, 'sa'); r.reveal(63 * S, 'B', 0, 350, 'sb');
  r.pledge(121 * S, 'x', 0, n(40));
  r.pledge(122 * S, 'y', 0, fundIt ? n(80) : n(20));
  r.finalize(181 * S, 0);
  r.withdraw(182 * S, 'A', n(1));
  return r.finish(200 * S);
}

function rescue() {
  const r = new Recorder('rescue-by-the-guarantor');
  for (const a of ['A', 'B', 'x']) r.deposit(0, a, n(1000));
  r.create(0, 'org', base);
  r.commit(1 * S, 'A', 0, 200, 'sa'); r.commit(2 * S, 'B', 0, 350, 'sb');
  r.reveal(61 * S, 'A', 0, 200, 'sa'); r.reveal(62 * S, 'B', 0, 350, 'sb');
  r.pledge(121 * S, 'x', 0, n(95));
  r.pledge(170 * S, 'A', 0, n(5));
  return r.finish(200 * S);
}

function edgeCases() {
  const r = new Recorder('edge-cases');
  r.deposit(0, 'A', n(10)); r.deposit(0, 'B', n(10)); r.deposit(0, 'x', n(300));
  r.deposit(0, 'zero', 0n);                                   // E_AMOUNT
  r.withdraw(0, 'nobody', n(1));                              // E_BALANCE
  r.create(0, 'org', { ...base, goal: n(0.001) });            // E_GOAL
  r.create(0, 'org', { ...base, bonusBps: 0 });               // E_BONUS
  r.create(0, 'org', { ...base, maxFeeBps: 2001 });           // E_FEE
  r.create(0, 'org', { ...base, revealSecs: 5 });             // E_WINDOW
  r.create(0, 'org', { ...base, title: 'é'.repeat(61) });     // E_TEXT (122 bytes)
  r.create(0, 'org', { ...base, title: 'é'.repeat(60) });     // ok: 120 bytes -> id 0
  r.create(0, 'org', { ...base, bonusBps: 2000, maxFeeBps: 0 }); // id 1: free guarantee only
  r.commitRaw(1 * S, 'A', 0, 'ABCDEF'.padEnd(64, '0'));       // E_COMMITMENT (uppercase)
  r.commit(1 * S, 'A', 7, 100, 's');                          // E_NO_CAMPAIGN
  r.commit(1 * S, 'A', 0, 100, 's');
  r.commit(1 * S, 'A', 0, 100, 's');                          // E_DUPLICATE
  r.commit(2 * S, 'B', 0, 20000, 's');                        // commits fine, cannot reveal
  r.commit(2 * S, 'A', 1, 0, 's', n(15));                     // id 1, bond 20, partly attached
  r.reveal(30 * S, 'A', 0, 100, 's');                         // E_PHASE
  r.reveal(61 * S, 'B', 0, 20000, 's');                       // E_FEE
  r.reveal(61 * S, 'A', 0, 100, 'wrong');                     // E_MISMATCH
  r.reveal(61 * S, 'x', 0, 100, 's');                         // E_NO_BID
  r.reveal(61 * S, 'A', 0, 100, 's');
  r.reveal(61 * S, 'A', 0, 100, 's');                         // E_DUPLICATE
  r.reveal(61 * S, 'A', 1, 0, 's');                           // zero fee bid
  r.settle(100 * S, 0);                                       // E_PHASE
  r.pledge(100 * S, 'x', 0, n(1));                            // E_PHASE
  r.settle(120 * S, 0);
  r.settle(120 * S, 0);                                       // E_SETTLED
  r.pledge(121 * S, 'x', 0, n(0.0001));                       // E_AMOUNT
  r.pledge(121 * S, 'A', 0, n(50));                           // E_BALANCE
  r.pledge(121 * S, 'x', 0, n(30));
  r.pledge(122 * S, 'x', 0, n(30));                           // same backer again
  r.pledge(123 * S, 'x', 1, n(100));                          // funds id 1 at a zero fee
  r.finalize(150 * S, 0);                                     // E_PHASE (deadline not passed)
  r.finalize(181 * S, 1);                                     // E_PHASE (funded)
  r.finalize(181 * S, 0, 0);                                  // E_AMOUNT
  r.finalize(181 * S, 0);
  r.finalize(182 * S, 0);                                     // E_CLOSED
  return r.finish(200 * S);
}

function paged() {
  const r = new Recorder('paged-refund');
  r.deposit(0, 'A', n(10));
  r.create(0, 'org', base);
  r.commit(1 * S, 'A', 0, 200, 'sa');
  r.reveal(61 * S, 'A', 0, 200, 'sa');
  for (let i = 0; i < 130; i++) r.pledge(121 * S, `b${i}`, 0, n(0.5) + BigInt(i), n(0.5) + BigInt(i));
  r.finalize(181 * S, 0);
  r.finalize(182 * S, 0, 20);
  r.finalize(183 * S, 0);
  return r.finish(200 * S);
}

function limits() {
  const r = new Recorder('limits');
  r.create(0, 'org', base);
  for (let i = 0; i < 17; i++) r.commit(1 * S, `u${i}`, 0, 100 + i, 's', n(5)); // the 17th: E_FULL
  for (let i = 0; i < 16; i++) r.reveal(61 * S, `u${i}`, 0, 100 + i, 's');
  for (let i = 0; i < 201; i++) r.pledge(121 * S, `b${i}`, 0, n(0.001), n(0.001)); // the 201st: E_FULL
  r.pledge(122 * S, 'b0', 0, n(0.001), n(0.001));                               // an existing backer may add
  r.finalize(181 * S, 0);
  r.finalize(181 * S, 0);
  r.finalize(181 * S, 0);
  return r.finish(200 * S);
}

function fuzz(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const r = new Recorder(`fuzz-${seed}`);
  const people = Array.from({ length: 10 }, (_, i) => `p${i}`);
  for (const p of people) r.deposit(0, p, n(1 + Math.floor(rnd() * 50)));
  let now = 0;
  const secrets = new Map();
  for (let step = 0; step < 130; step++) {
    now += Math.floor(rnd() * 25) * S;
    const who = pick(people);
    const count = r.m.campaigns.length;
    const id = count ? Math.floor(rnd() * (count + 0.2)) : 0;
    const roll = rnd();
    if (roll < 0.08) {
      r.create(now, who, {
        title: `campaign ${step}`, socialPost: '', beneficiary: pick(people),
        goal: n(1 + Math.floor(rnd() * 30)) + BigInt(Math.floor(rnd() * 1000)),
        bonusBps: 1 + Math.floor(rnd() * 2000), maxFeeBps: Math.floor(rnd() * 2001),
        commitSecs: 10 + Math.floor(rnd() * 60), revealSecs: 10 + Math.floor(rnd() * 60), fundingSecs: 10 + Math.floor(rnd() * 120),
      });
    } else if (roll < 0.3) {
      const fee = rnd() < 0.03 ? 10001 : Math.floor(rnd() * 2500);
      const attached = rnd() < 0.2 ? n(Math.floor(rnd() * 3)) : 0n;
      if (r.commit(now, who, id, fee, `s${seed}`, attached)) secrets.set(`${id}:${who}`, fee);
    } else if (roll < 0.5) {
      r.reveal(now, who, id, secrets.get(`${id}:${who}`) ?? 0, `s${seed}`);
    } else if (roll < 0.83) {
      const attached = rnd() < 0.2 ? n(Math.floor(rnd() * 4)) : 0n;
      r.pledge(now, who, id, n(0.001 + rnd() * 12) + BigInt(Math.floor(rnd() * 7)), attached);
    } else if (roll < 0.92) {
      r.finalize(now, id, Math.floor(rnd() * 5));
    } else if (roll < 0.97) {
      r.settle(now, id);
    } else {
      r.withdraw(now, who, n(Math.floor(rnd() * 5)));
    }
  }
  now += 400 * 86400 * S;
  for (const c of r.m.campaigns) while (!c.closed) r.finalize(now, c.id);
  return r.finish(now);
}

const scenarios = [
  workedExample('worked-example-funded', true),
  workedExample('worked-example-fell-short', false),
  rescue(),
  edgeCases(),
  paged(),
  limits(),
  ...Array.from({ length: 12 }, (_, i) => fuzz(i + 1)),
];

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'fixtures'), { recursive: true });
const file = join(here, 'fixtures', 'scenarios.json');
writeFileSync(file, JSON.stringify({ generated_by: 'engine/fixtures.mjs', scenarios }));

const calls = scenarios.reduce((sum, s) => sum + s.ops.length, 0);
const rejected = scenarios.reduce((sum, s) => sum + s.ops.filter((o) => !o.ok).length, 0);
const codes = new Set(scenarios.flatMap((s) => s.ops.filter((o) => !o.ok).map((o) => o.code)));
console.log(`${scenarios.length} scenarios, ${calls} calls (${rejected} rejected, ${codes.size} distinct error codes)`);
console.log(`error codes covered: ${[...codes].sort().join(' ')}`);
console.log(`wrote ${file}`);
