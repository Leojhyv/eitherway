// Rule-by-rule tests for the engine. Run: node --test engine/test/market.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Market, RuleError, NEAR, LIMITS, commitment, bondFor, breakEvenOdds } from '../market.mjs';
import { sha256Hex } from '../sha256.mjs';
import { mulberry32 } from '../rng.mjs';

const n = (x) => BigInt(Math.round(x * 1e6)) * (NEAR / 1000000n);
const S = 1000; // one second in ms

const fails = (fn, code) =>
  assert.throws(fn, (e) => e instanceof RuleError && e.code === code, `expected ${code}`);

/** I1 must hold after every step. */
const conserved = (m) => {
  const t = m.totals();
  assert.equal(t.vault, t.free + t.bonds + t.pledges, 'I1: vault = free + bonds + pledges');
};

/** A campaign with goal 100, bonus 5%, max fee 6%, and 60 s windows, created at t=0. */
const setup = (over = {}) => {
  const m = new Market();
  for (const a of ['A', 'B', 'C', 'x', 'y', 'z']) m.deposit(a, n(1000));
  const id = m.createCampaign('org', {
    title: 'Open-source indexer', goal: n(100), bonusBps: 500, maxFeeBps: 600,
    commitSecs: 60, revealSecs: 60, fundingSecs: 60, beneficiary: 'org', ...over,
  }, 0);
  return { m, id };
};
const bid = (m, id, who, fee, t = 1 * S) => m.commitBid(who, id, commitment(id, who, fee, `salt-${who}`), t);
const reveal = (m, id, who, fee, t = 61 * S) => m.revealBid(who, id, fee, `salt-${who}`, t);
const FUND = 120 * S; // funding opens: a pledge made now earns the full bonus
const AFTER = 181 * S;

test('sha256 matches Node crypto', () => {
  for (const s of ['', 'abc', 'ew1:0:uw-1.eitherway.testnet:350:salt', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(200)]) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  }
});

test('R2: the bond is goal x bonus, rounded down', () => {
  assert.equal(bondFor(n(100), 500), n(5));
  assert.equal(bondFor(1001n, 500), 50n);
});

test('R2: create rejects out-of-range parameters', () => {
  const m = new Market();
  const ok = { title: 't', goal: n(1), bonusBps: 500, maxFeeBps: 600, commitSecs: 60, revealSecs: 60, fundingSecs: 60 };
  fails(() => m.createCampaign('o', { ...ok, goal: LIMITS.MIN_GOAL - 1n }, 0), 'E_GOAL');
  fails(() => m.createCampaign('o', { ...ok, goal: LIMITS.MAX_GOAL + 1n }, 0), 'E_GOAL');
  fails(() => m.createCampaign('o', { ...ok, bonusBps: 0 }, 0), 'E_BONUS');
  fails(() => m.createCampaign('o', { ...ok, bonusBps: 2001 }, 0), 'E_BONUS');
  fails(() => m.createCampaign('o', { ...ok, maxFeeBps: 2001 }, 0), 'E_FEE');
  fails(() => m.createCampaign('o', { ...ok, commitSecs: 9 }, 0), 'E_WINDOW');
  fails(() => m.createCampaign('o', { ...ok, title: '' }, 0), 'E_TEXT');
  assert.equal(m.createCampaign('o', ok, 0), 0);
  assert.equal(m.accountView('o').org_created, 1);
});

test('R1: withdraw returns only free balance', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200);
  assert.equal(m.accountView('A').balance, n(995).toString());
  fails(() => m.withdraw('A', n(996)), 'E_BALANCE');
  m.withdraw('A', n(995));
  conserved(m);
});

test('R3: commit locks the bond, one bid per account, only in the commit window', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200);
  fails(() => bid(m, id, 'A', 300), 'E_DUPLICATE');
  fails(() => bid(m, id, 'B', 300, 60 * S), 'E_PHASE');
  fails(() => m.commitBid('B', id, 'nothex', 1 * S), 'E_COMMITMENT');
  m.deposit('poor', n(1));
  fails(() => bid(m, id, 'poor', 300), 'E_BALANCE');
  // Attached NEAR counts towards the bond.
  m.commitBid('poor', id, commitment(id, 'poor', 300, 's'), 1 * S, n(4));
  assert.equal(m.accountView('poor').balance, '0');
  conserved(m);
});

test('R4: a reveal must match the commitment and come in the reveal window', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200);
  fails(() => reveal(m, id, 'A', 200, 30 * S), 'E_PHASE');
  fails(() => reveal(m, id, 'A', 201), 'E_MISMATCH');
  fails(() => reveal(m, id, 'B', 200), 'E_NO_BID');
  reveal(m, id, 'A', 200);
  fails(() => reveal(m, id, 'A', 200), 'E_DUPLICATE');
});

test('R5: lowest fee wins and is paid the runner-up price (worked example)', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200); bid(m, id, 'B', 350); bid(m, id, 'C', 500);
  reveal(m, id, 'C', 500); reveal(m, id, 'A', 200); reveal(m, id, 'B', 350);
  fails(() => m.settleAuction(id, 100 * S), 'E_PHASE');
  m.settleAuction(id, FUND);
  const c = m.campaignView(id, FUND);
  assert.equal(c.underwriter, 'A');
  assert.equal(c.clearing_fee_bps, 350);
  assert.equal(m.accountView('A').balance, n(995).toString());
  assert.equal(m.accountView('B').balance, n(1000).toString());
  assert.equal(m.accountView('C').balance, n(1000).toString());
  fails(() => m.settleAuction(id, FUND), 'E_SETTLED');
  conserved(m);
});

test('R5: a lone bidder is paid the reserve; ties go to the earlier commit', () => {
  let { m, id } = setup();
  bid(m, id, 'A', 100); reveal(m, id, 'A', 100);
  m.settleAuction(id, FUND);
  assert.equal(m.campaignView(id, FUND).clearing_fee_bps, 600);

  ({ m, id } = setup());
  bid(m, id, 'B', 300); bid(m, id, 'A', 300);
  reveal(m, id, 'A', 300); reveal(m, id, 'B', 300);
  m.settleAuction(id, FUND);
  assert.equal(m.campaignView(id, FUND).underwriter, 'B');
  assert.equal(m.campaignView(id, FUND).clearing_fee_bps, 300);
});

test('R5: the runner-up price is capped at the reserve', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 100); bid(m, id, 'B', 900);
  reveal(m, id, 'A', 100); reveal(m, id, 'B', 900);
  m.settleAuction(id, FUND);
  assert.equal(m.campaignView(id, FUND).clearing_fee_bps, 600);
});

test('R5: no eligible bid means unguaranteed, and every bond unlocks', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 700); bid(m, id, 'B', 100); // B never reveals
  reveal(m, id, 'A', 700);                    // above the 6% reserve
  m.settleAuction(id, FUND);
  const c = m.campaignView(id, FUND);
  assert.equal(c.underwriter, null);
  assert.equal(m.accountView('A').balance, n(1000).toString());
  assert.equal(m.accountView('B').balance, n(1000).toString());
  conserved(m);
});

test('R6: pledges are trimmed at the goal, and only taken in the funding window', () => {
  const { m, id } = setup();
  fails(() => m.pledge('x', id, n(10), 100 * S), 'E_PHASE');
  fails(() => m.pledge('x', id, LIMITS.MIN_PLEDGE - 1n, FUND), 'E_AMOUNT');
  assert.equal(m.pledge('x', id, n(70), FUND), n(70));
  assert.equal(m.pledge('y', id, n(50), FUND), n(30)); // trimmed to the gap
  assert.equal(m.accountView('y').balance, n(970).toString());
  fails(() => m.pledge('z', id, n(1), FUND), 'E_PHASE'); // already funded
  conserved(m);
});

test('R6: the first pledge settles the auction, and a losing bidder may pledge its unlocked bond', () => {
  const { m, id } = setup();
  m.deposit('thin', n(5));
  bid(m, id, 'A', 200); bid(m, id, 'thin', 400);
  reveal(m, id, 'A', 200); reveal(m, id, 'thin', 400);
  assert.equal(m.accountView('thin').balance, '0');
  assert.equal(m.pledge('thin', id, n(5), FUND), n(5));
  assert.equal(m.campaignView(id, FUND).underwriter, 'A');
  conserved(m);
});

test('R7: funded pays the organizer goal minus fee and the underwriter bond plus fee', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200); bid(m, id, 'B', 350);
  reveal(m, id, 'A', 200); reveal(m, id, 'B', 350);
  m.pledge('x', id, n(60), FUND);
  m.pledge('y', id, n(40), FUND);
  const c = m.campaignView(id, FUND);
  assert.equal(c.status, 'Funded');
  assert.equal(c.closed, true);
  assert.equal(m.accountView('org').balance, n(96.5).toString());       // I4
  assert.equal(m.accountView('A').balance, n(1003.5).toString());
  assert.equal(m.accountView('A').uw_fees, n(3.5).toString());
  assert.equal(m.accountView('org').org_funded, 1);
  fails(() => m.finalize(id, AFTER), 'E_PHASE');
  conserved(m);
  const t = m.totals();
  assert.equal(t.bonds + t.pledges, 0n);                                 // I5
});

test('R7: an unguaranteed campaign pays the organizer the whole goal', () => {
  const { m, id } = setup();
  m.pledge('x', id, n(100), FUND);
  assert.equal(m.accountView('org').balance, n(100).toString());
});

test('R8: fell short refunds pledge plus bonus, and the underwriter keeps the rest (worked example)', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200); bid(m, id, 'B', 350);
  reveal(m, id, 'A', 200); reveal(m, id, 'B', 350);
  m.pledge('x', id, n(40), FUND);
  m.pledge('y', id, n(20), FUND);
  fails(() => m.finalize(id, FUND), 'E_PHASE');
  const r = m.finalize(id, AFTER);
  assert.deepEqual(r, { closed: true, refunded: 2 });
  assert.equal(m.accountView('x').balance, n(1002).toString());          // I2: 40 back + 2
  assert.equal(m.accountView('y').balance, n(1001).toString());
  assert.equal(m.accountView('A').balance, n(997).toString());           // I3: lost 3 of a 5 bond
  assert.equal(m.accountView('A').uw_bonus_paid, n(3).toString());
  assert.equal(m.accountView('org').balance, '0');                       // I4
  assert.equal(m.accountView('org').org_failed, 1);
  fails(() => m.finalize(id, AFTER), 'E_CLOSED');
  conserved(m);
  const t = m.totals();
  assert.equal(t.bonds + t.pledges, 0n);
});

test('R6: the bonus is earned by waiting, so a last-second pledge earns almost nothing', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200); reveal(m, id, 'A', 200);
  m.pledge('x', id, n(40), 120 * S);          // when funding opens: full 5%
  m.pledge('y', id, n(20), 150 * S);          // halfway: 2.5%
  m.pledge('z', id, n(10), 180 * S - 1);      // one millisecond before the deadline
  assert.equal(m.campaignView(id, 180 * S - 1).bonus_owed, (n(2) + n(0.5) + 8n * 10n ** 18n).toString());
  assert.deepEqual(m.pledgesView(id).map((p) => p.bonus), [n(2).toString(), n(0.5).toString(), (8n * 10n ** 18n).toString()]);
  m.finalize(id, AFTER);
  assert.equal(m.accountView('x').balance, n(1002).toString());
  assert.equal(m.accountView('y').balance, n(1000.5).toString());
  assert.equal(m.accountView('z').balance, (n(1000) + 8n * 10n ** 18n).toString());
  assert.equal(m.accountView('A').balance, (n(997.5) - 8n * 10n ** 18n).toString());
  conserved(m);
});

test('R6: a backer who pledges twice earns each pledge its own bonus', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200); reveal(m, id, 'A', 200);
  m.pledge('x', id, n(10), 120 * S);
  m.pledge('x', id, n(10), 150 * S);
  assert.deepEqual(m.pledgesView(id), [{ account: 'x', amount: n(20).toString(), bonus: n(0.75).toString() }]);
});

test('R8: an unguaranteed failure refunds exactly the pledge', () => {
  const { m, id } = setup();
  m.pledge('x', id, n(40), FUND);
  m.finalize(id, AFTER);
  assert.equal(m.accountView('x').balance, n(1000).toString());
});

test('R8: a campaign nobody backed costs the underwriter nothing', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200); reveal(m, id, 'A', 200);
  m.finalize(id, AFTER);
  assert.equal(m.accountView('A').balance, n(1000).toString());
  assert.equal(m.campaignView(id, AFTER).closed, true);
});

test('R8: refunds are paged, and conservation holds between pages', () => {
  const m = new Market();
  const id = m.createCampaign('org', { title: 't', goal: n(100), bonusBps: 500, maxFeeBps: 600, commitSecs: 60, revealSecs: 60, fundingSecs: 60 }, 0);
  m.deposit('A', n(10));
  bid(m, id, 'A', 200); reveal(m, id, 'A', 200);
  for (let i = 0; i < 150; i++) {
    m.deposit(`b${i}`, n(0.5));
    m.pledge(`b${i}`, id, n(0.5), FUND);
  }
  let r = m.finalize(id, AFTER);
  assert.deepEqual(r, { closed: false, refunded: 100 });
  conserved(m);
  r = m.finalize(id, AFTER);
  assert.deepEqual(r, { closed: true, refunded: 150 });
  conserved(m);
  assert.equal(m.accountView('b0').balance, n(0.525).toString());
  assert.equal(m.accountView('A').balance, n(10 - 3.75).toString());
});

test('R10: rescuing a near-miss costs the underwriter less than paying the bonus', () => {
  const { m, id } = setup();
  bid(m, id, 'A', 200); bid(m, id, 'B', 350);
  reveal(m, id, 'A', 200); reveal(m, id, 'B', 350);
  m.pledge('x', id, n(95), FUND);
  m.pledge('A', id, n(5), FUND); // the guarantor fills the gap
  assert.equal(m.campaignView(id, FUND).status, 'Funded');
  // A paid 5 and earned 3.5: down 1.5, instead of 4.75 in bonuses.
  assert.equal(m.accountView('A').balance, n(998.5).toString());
});

test('break-even odds follow b / (b + f)', () => {
  assert.equal(breakEvenOdds(500, 200).toFixed(4), '0.7143');
  assert.equal(breakEvenOdds(500, 350).toFixed(4), '0.5882');
});

test('fuzz: 300 random markets keep every invariant', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = mulberry32(seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const m = new Market();
    const people = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const start = new Map();
    for (const p of people) {
      const amt = n(1 + Math.floor(rnd() * 50));
      m.deposit(p, amt);
      start.set(p, amt);
    }
    let now = 0;
    const secrets = new Map();
    for (let step = 0; step < 120; step++) {
      now += Math.floor(rnd() * 25) * S;
      const who = pick(people);
      const id = m.campaigns.length ? Math.floor(rnd() * m.campaigns.length) : 0;
      const before = m.totals().vault;
      try {
        const roll = rnd();
        if (roll < 0.08) {
          m.createCampaign(who, {
            title: `c${step}`, goal: n(1 + Math.floor(rnd() * 30)) + BigInt(Math.floor(rnd() * 1000)),
            bonusBps: 1 + Math.floor(rnd() * 2000), maxFeeBps: Math.floor(rnd() * 2001),
            commitSecs: 10 + Math.floor(rnd() * 60), revealSecs: 10 + Math.floor(rnd() * 60), fundingSecs: 10 + Math.floor(rnd() * 120),
            beneficiary: pick(people),
          }, now);
        } else if (roll < 0.3) {
          const fee = Math.floor(rnd() * 2500);
          m.commitBid(who, id, commitment(id, who, fee, `s${seed}`), now);
          secrets.set(`${id}:${who}`, fee);
        } else if (roll < 0.5) {
          m.revealBid(who, id, secrets.get(`${id}:${who}`) ?? 0, `s${seed}`, now);
        } else if (roll < 0.85) {
          m.pledge(who, id, n(0.001 + rnd() * 12) + BigInt(Math.floor(rnd() * 7)), now);
        } else if (roll < 0.95) {
          m.finalize(id, now, 1 + Math.floor(rnd() * 5));
        } else {
          m.settleAuction(id, now);
        }
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        assert.equal(m.totals().vault, before, 'a rejected call must not move money');
      }
      conserved(m);
    }
    // Close everything, then check the end state.
    now += 400 * 86400 * S;
    for (const c of m.campaigns) {
      while (!c.closed) m.finalize(c.id, now);
    }
    conserved(m);
    const t = m.totals();
    assert.equal(t.bonds + t.pledges, 0n, 'I5: nothing stays locked');
    let total = 0n;
    for (const p of people) total += BigInt(m.accountView(p).balance);
    let startTotal = 0n;
    for (const v of start.values()) startTotal += v;
    assert.equal(total, startTotal, 'I1: money only moved between accounts');
    for (const c of m.campaigns) {
      if (c.status === 'Failed') assert.ok(c.bonusPaid <= c.bond, 'I3: bonuses never exceed the bond');
    }
  }
});
