// EitherWay rules engine: RULES.md as a plain state machine.
//
// The NEAR contract in contract/ implements the same rules. This file exists so
// the market can run with no chain (the simulation, the page, the tests), and
// so every scenario can be replayed through both and compared.
//
// Amounts are BigInt yoctoNEAR. Times are integer milliseconds. Every method
// checks first and changes state only after all checks pass, so a rejected
// call leaves the market untouched, the way a failed transaction does.

import { sha256Hex } from './sha256.mjs';

export const BPS = 10000n;
export const NEAR = 10n ** 24n;

export const LIMITS = Object.freeze({
  MAX_BONUS_BPS: 2000,
  MAX_FEE_BPS: 2000,
  MIN_GOAL: NEAR / 100n,
  MAX_GOAL: 100000n * NEAR,
  MIN_PLEDGE: NEAR / 1000n,
  MAX_BIDS: 16,
  MAX_BACKERS: 200,
  MIN_WINDOW: 10,
  MAX_WINDOW: 30 * 86400,
  REFUND_PAGE: 100,
  MAX_TITLE: 120,
  MAX_POST: 200,
});

export class RuleError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
const need = (ok, code, message) => {
  if (!ok) throw new RuleError(code, message);
};

/** R3: the sealed bid an underwriter sends during the commit window. */
export const commitment = (campaignId, account, feeBps, salt) =>
  sha256Hex(`ew1:${campaignId}:${account}:${feeBps}:${salt}`);

/** R2: the bond every bidder locks. */
export const bondFor = (goal, bonusBps) => (goal * BigInt(bonusBps)) / BPS;

/** How much of the funding window is still ahead, in parts per million. */
export const PPM = 1000000n;
export const waitShare = (c, now) => (BigInt(c.deadline - now) * PPM) / BigInt(c.deadline - c.revealEnd);

/** R6: the bonus a pledge earns if the campaign falls short. */
export const bonusFor = (amount, bonusBps, sharePpm) => (amount * BigInt(bonusBps) * sharePpm) / (BPS * PPM);

/** RULES.md section 5: the chance of success at which guaranteeing breaks even. */
export const breakEvenOdds = (bonusBps, feeBps) =>
  bonusBps + feeBps === 0 ? 1 : bonusBps / (bonusBps + feeBps);

const utf8Length = (s) => new TextEncoder().encode(s).length;

const blankAccount = () => ({
  balance: 0n,
  org_created: 0, org_funded: 0, org_failed: 0,
  uw_won: 0, uw_funded: 0, uw_failed: 0, uw_fees: 0n, uw_bonus_paid: 0n,
  bk_pledged: 0n, bk_bonus: 0n,
});

export class Market {
  constructor() {
    this.accounts = new Map();
    this.campaigns = [];
    this.events = [];
    this.vault = 0n; // all NEAR the market holds: deposits minus withdrawals
  }

  // ---- internals -----------------------------------------------------------

  #acct(id) {
    let a = this.accounts.get(id);
    if (!a) {
      a = blankAccount();
      this.accounts.set(id, a);
    }
    return a;
  }
  #peek(id) {
    return this.accounts.get(id) ?? blankAccount();
  }
  #campaign(id) {
    const c = this.campaigns[id];
    need(c !== undefined, 'E_NO_CAMPAIGN', `campaign ${id} does not exist`);
    return c;
  }
  #emit(event, data) {
    this.events.push({ event, ...data });
  }

  phaseOf(c, now) {
    if (c.status !== 'Open') return c.status;
    if (now < c.commitEnd) return 'Commit';
    if (now < c.revealEnd) return 'Reveal';
    if (now < c.deadline) return 'Funding';
    return 'Expired';
  }

  // ---- R1 balances ---------------------------------------------------------

  deposit(account, amount) {
    need(amount > 0n, 'E_AMOUNT', 'deposit must be positive');
    this.#acct(account).balance += amount;
    this.vault += amount;
    this.#emit('deposit', { account, amount });
  }

  withdraw(account, amount) {
    need(amount > 0n, 'E_AMOUNT', 'withdrawal must be positive');
    need(this.#peek(account).balance >= amount, 'E_BALANCE', 'not enough free balance');
    this.#acct(account).balance -= amount;
    this.vault -= amount;
    this.#emit('withdraw', { account, amount });
  }

  // ---- R2 create -----------------------------------------------------------

  createCampaign(organizer, p, now) {
    const L = LIMITS;
    need(p.goal >= L.MIN_GOAL && p.goal <= L.MAX_GOAL, 'E_GOAL', 'goal out of range');
    need(Number.isInteger(p.bonusBps) && p.bonusBps >= 1 && p.bonusBps <= L.MAX_BONUS_BPS, 'E_BONUS', 'bonus_bps out of range');
    need(Number.isInteger(p.maxFeeBps) && p.maxFeeBps >= 0 && p.maxFeeBps <= L.MAX_FEE_BPS, 'E_FEE', 'max_fee_bps out of range');
    for (const w of [p.commitSecs, p.revealSecs, p.fundingSecs]) {
      need(Number.isInteger(w) && w >= L.MIN_WINDOW && w <= L.MAX_WINDOW, 'E_WINDOW', 'window out of range');
    }
    need(utf8Length(p.title) >= 1 && utf8Length(p.title) <= L.MAX_TITLE, 'E_TEXT', 'title length out of range');
    need(utf8Length(p.socialPost ?? '') <= L.MAX_POST, 'E_TEXT', 'social_post too long');

    const id = this.campaigns.length;
    const commitEnd = now + p.commitSecs * 1000;
    const revealEnd = commitEnd + p.revealSecs * 1000;
    this.campaigns.push({
      id,
      organizer,
      beneficiary: p.beneficiary ?? organizer,
      title: p.title,
      socialPost: p.socialPost ?? '',
      goal: p.goal,
      bonusBps: p.bonusBps,
      maxFeeBps: p.maxFeeBps,
      bond: bondFor(p.goal, p.bonusBps),
      createdAt: now,
      commitEnd,
      revealEnd,
      deadline: revealEnd + p.fundingSecs * 1000,
      bids: [],
      auctionSettled: false,
      underwriter: null,
      clearingFeeBps: 0,
      raised: 0n,
      backers: [],
      pledges: new Map(),
      bonuses: new Map(), // account -> bonus it is owed if the campaign falls short
      bonusOwed: 0n,
      status: 'Open',
      refundedUpto: 0,
      bonusPaid: 0n,
      closed: false,
    });
    this.#acct(organizer).org_created += 1;
    this.#emit('campaign_created', { id, organizer, goal: p.goal, bonus_bps: p.bonusBps, max_fee_bps: p.maxFeeBps });
    return id;
  }

  // ---- R3 commit -----------------------------------------------------------

  commitBid(account, id, commitmentHex, now, attached = 0n) {
    const c = this.#campaign(id);
    need(this.phaseOf(c, now) === 'Commit', 'E_PHASE', 'bids are only accepted in the commit window');
    need(/^[0-9a-f]{64}$/.test(commitmentHex), 'E_COMMITMENT', 'commitment must be 64 lowercase hex characters');
    need(!c.bids.some((b) => b.account === account), 'E_DUPLICATE', 'one bid per account');
    need(c.bids.length < LIMITS.MAX_BIDS, 'E_FULL', 'too many bids');
    need(this.#peek(account).balance + attached >= c.bond, 'E_BALANCE', 'not enough free balance for the bond');

    const a = this.#acct(account);
    a.balance += attached;
    this.vault += attached;
    a.balance -= c.bond;
    c.bids.push({ account, commitment: commitmentHex, revealed: false, feeBps: null });
    this.#emit('bid_committed', { id, account, bond: c.bond });
  }

  // ---- R4 reveal -----------------------------------------------------------

  revealBid(account, id, feeBps, salt, now) {
    const c = this.#campaign(id);
    need(this.phaseOf(c, now) === 'Reveal', 'E_PHASE', 'bids are only revealed in the reveal window');
    const bid = c.bids.find((b) => b.account === account);
    need(bid !== undefined, 'E_NO_BID', 'no bid from this account');
    need(!bid.revealed, 'E_DUPLICATE', 'bid already revealed');
    need(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= 10000, 'E_FEE', 'fee_bps out of range');
    need(commitment(id, account, feeBps, salt) === bid.commitment, 'E_MISMATCH', 'reveal does not match the commitment');

    bid.revealed = true;
    bid.feeBps = feeBps;
    this.#emit('bid_revealed', { id, account, fee_bps: feeBps });
  }

  // ---- R5 settle the auction -------------------------------------------------

  settleAuction(id, now) {
    const c = this.#campaign(id);
    need(!c.auctionSettled, 'E_SETTLED', 'auction already settled');
    need(now >= c.revealEnd, 'E_PHASE', 'the reveal window is still open');
    this.#settle(c);
  }

  /** Who wins and at what fee. Pure: reads the bids, changes nothing. */
  #auctionOutcome(c) {
    const revealed = c.bids.map((b, i) => ({ ...b, i })).filter((b) => b.revealed);
    // Lowest fee first; ties go to the earlier commit.
    revealed.sort((x, y) => x.feeBps - y.feeBps || x.i - y.i);
    const best = revealed[0];
    if (!best || best.feeBps > c.maxFeeBps) return { winner: null, clearingFeeBps: 0 };
    const runnerUp = revealed[1];
    return {
      winner: best.account,
      clearingFeeBps: runnerUp ? Math.min(runnerUp.feeBps, c.maxFeeBps) : c.maxFeeBps,
    };
  }

  #settle(c) {
    const { winner, clearingFeeBps } = this.#auctionOutcome(c);
    if (winner) {
      c.underwriter = winner;
      c.clearingFeeBps = clearingFeeBps;
      this.#acct(winner).uw_won += 1;
    }
    for (const b of c.bids) {
      if (b.account !== winner) this.#acct(b.account).balance += c.bond;
    }
    c.auctionSettled = true;
    this.#emit('auction_settled', { id: c.id, underwriter: c.underwriter, clearing_fee_bps: c.clearingFeeBps });
  }

  // ---- R6 pledge, R7 funded --------------------------------------------------

  pledge(account, id, amount, now, attached = 0n) {
    const c = this.#campaign(id);
    need(this.phaseOf(c, now) === 'Funding', 'E_PHASE', 'pledges are only accepted in the funding window');
    need(amount >= LIMITS.MIN_PLEDGE, 'E_AMOUNT', 'pledge is below the minimum');
    const isNew = !c.pledges.has(account);
    need(!isNew || c.backers.length < LIMITS.MAX_BACKERS, 'E_FULL', 'too many backers');
    const gap = c.goal - c.raised;
    const taken = amount < gap ? amount : gap;
    // The first pledge settles the auction (R5), which hands a losing bidder
    // its bond back. Count that bond as available, as the contract does.
    let unlocked = 0n;
    if (!c.auctionSettled && c.bids.some((b) => b.account === account)) {
      if (this.#auctionOutcome(c).winner !== account) unlocked = c.bond;
    }
    need(this.#peek(account).balance + attached + unlocked >= taken, 'E_BALANCE', 'not enough free balance');

    if (!c.auctionSettled) this.#settle(c);
    const a = this.#acct(account);
    a.balance += attached;
    this.vault += attached;
    a.balance -= taken;
    a.bk_pledged += taken;
    if (isNew) c.backers.push(account);
    // The bonus is earned by waiting: a pledge made when funding opens earns
    // the full rate, one made halfway earns half, one made at the end nothing.
    const bonus = bonusFor(taken, c.bonusBps, waitShare(c, now));
    c.pledges.set(account, (c.pledges.get(account) ?? 0n) + taken);
    c.bonuses.set(account, (c.bonuses.get(account) ?? 0n) + bonus);
    c.bonusOwed += bonus;
    c.raised += taken;
    this.#emit('pledged', { id, account, amount: taken, bonus, raised: c.raised });

    if (c.raised === c.goal) this.#fund(c);
    return taken;
  }

  #fund(c) {
    const fee = c.underwriter ? (c.goal * BigInt(c.clearingFeeBps)) / BPS : 0n;
    this.#acct(c.beneficiary).balance += c.goal - fee;
    this.#acct(c.organizer).org_funded += 1;
    if (c.underwriter) {
      const u = this.#acct(c.underwriter);
      u.balance += c.bond + fee;
      u.uw_funded += 1;
      u.uw_fees += fee;
    }
    c.status = 'Funded';
    c.closed = true;
    this.#emit('funded', { id: c.id, beneficiary: c.beneficiary, paid: c.goal - fee, underwriter: c.underwriter, fee });
  }

  // ---- R8 fell short ---------------------------------------------------------

  finalize(id, now, limit = LIMITS.REFUND_PAGE) {
    const c = this.#campaign(id);
    need(c.status !== 'Funded', 'E_PHASE', 'campaign was funded');
    need(!c.closed, 'E_CLOSED', 'campaign is already closed');
    need(now >= c.deadline, 'E_PHASE', 'the deadline has not passed');
    need(limit >= 1, 'E_AMOUNT', 'limit must be at least 1');

    if (!c.auctionSettled) this.#settle(c);
    if (c.status === 'Open') {
      c.status = 'Failed';
      this.#acct(c.organizer).org_failed += 1;
      if (c.underwriter) this.#acct(c.underwriter).uw_failed += 1;
    }

    const end = Math.min(c.backers.length, c.refundedUpto + Math.min(limit, LIMITS.REFUND_PAGE));
    for (let i = c.refundedUpto; i < end; i++) {
      const backer = c.backers[i];
      const pledged = c.pledges.get(backer);
      const bonus = c.underwriter ? c.bonuses.get(backer) : 0n;
      const a = this.#acct(backer);
      a.balance += pledged + bonus;
      a.bk_bonus += bonus;
      c.bonusPaid += bonus;
      this.#emit('refunded', { id, account: backer, pledge: pledged, bonus });
    }
    c.refundedUpto = end;

    if (c.refundedUpto === c.backers.length) {
      if (c.underwriter) {
        const u = this.#acct(c.underwriter);
        u.balance += c.bond - c.bonusPaid;
        u.uw_bonus_paid += c.bonusPaid;
      }
      c.closed = true;
      this.#emit('failed', { id, raised: c.raised, bonus_paid: c.bonusPaid, underwriter: c.underwriter });
    }
    return { closed: c.closed, refunded: c.refundedUpto };
  }

  // ---- views (same JSON shape as the contract) ---------------------------------

  campaignView(id, now) {
    const c = this.#campaign(id);
    return {
      id: c.id,
      organizer: c.organizer,
      beneficiary: c.beneficiary,
      title: c.title,
      social_post: c.socialPost,
      goal: c.goal.toString(),
      bonus_bps: c.bonusBps,
      max_fee_bps: c.maxFeeBps,
      bond: c.bond.toString(),
      created_at: c.createdAt,
      commit_end: c.commitEnd,
      reveal_end: c.revealEnd,
      deadline: c.deadline,
      status: c.status,
      phase: this.phaseOf(c, now),
      auction_settled: c.auctionSettled,
      underwriter: c.underwriter,
      clearing_fee_bps: c.clearingFeeBps,
      raised: c.raised.toString(),
      bonus_owed: (c.underwriter ? c.bonusOwed : 0n).toString(),
      backer_count: c.backers.length,
      bid_count: c.bids.length,
      refunded_upto: c.refundedUpto,
      bonus_paid: c.bonusPaid.toString(),
      closed: c.closed,
    };
  }

  bidsView(id) {
    return this.#campaign(id).bids.map((b) => ({
      account: b.account,
      commitment: b.commitment,
      revealed: b.revealed,
      fee_bps: b.feeBps,
    }));
  }

  pledgesView(id) {
    const c = this.#campaign(id);
    return c.backers.map((account) => ({
      account,
      amount: c.pledges.get(account).toString(),
      bonus: c.bonuses.get(account).toString(),
    }));
  }

  accountView(id) {
    const a = this.#peek(id);
    return {
      balance: a.balance.toString(),
      org_created: a.org_created, org_funded: a.org_funded, org_failed: a.org_failed,
      uw_won: a.uw_won, uw_funded: a.uw_funded, uw_failed: a.uw_failed,
      uw_fees: a.uw_fees.toString(), uw_bonus_paid: a.uw_bonus_paid.toString(),
      bk_pledged: a.bk_pledged.toString(), bk_bonus: a.bk_bonus.toString(),
    };
  }

  /** I1: what the market holds, split into free and locked. */
  totals() {
    let free = 0n;
    for (const a of this.accounts.values()) free += a.balance;
    let bonds = 0n;
    let pledges = 0n;
    for (const c of this.campaigns) {
      if (c.closed) continue;
      if (!c.auctionSettled) bonds += c.bond * BigInt(c.bids.length);
      else if (c.underwriter) bonds += c.bond;
      for (let i = c.refundedUpto; i < c.backers.length; i++) pledges += c.pledges.get(c.backers[i]);
      // Bonuses already paid out of the winner's bond during a paged refund.
      bonds -= c.bonusPaid;
    }
    return { vault: this.vault, free, bonds, pledges };
  }
}
