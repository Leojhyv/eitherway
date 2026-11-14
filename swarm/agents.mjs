// The agents. Each one represents a single user and decides for itself.
//
// An agent never touches the market directly. A runner shows it what it could
// see (`decide(view)`) and it answers with the actions it wants to take. The
// simulation runner executes those against the rules engine; the live runner
// signs them as NEAR transactions from the agent's own sub-account. The agent
// code is identical in both.
//
// Everything here is scripted: no model calls. The live runner can replace the
// two judgment calls (how well a campaign matches a user's interests, and how
// likely it is to be funded) with a language model; see swarm/llm.mjs.

import { BPS, commitment } from '../engine/market.mjs';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const big = (x) => BigInt(x);

/** How far through its funding window a campaign is, 0 to 1. */
export const elapsed = (c, now) => clamp((now - c.reveal_end) / (c.deadline - c.reveal_end), 0, 1);
export const progress = (c) => Number((big(c.raised) * 10000n) / big(c.goal)) / 10000;

// ---- underwriters --------------------------------------------------------------

export const UNDERWRITER_STYLES = {
  // noise:   how badly it actually reads demand.
  // doubt:   how badly it *believes* it reads demand. Below noise = overconfident.
  // margin:  profit it adds on top of its break-even fee.
  // minOdds: below this it will not guarantee at all.
  // caution: how far it marks its own odds down before bidding. Winning an
  //          auction means being the most optimistic bidder, so an underwriter
  //          that does not allow for that overpays (the winner's curse).
  sharp:   { noise: 0.12, doubt: 0.12, margin: 0.15, minOdds: 0.55, learn: 0.12, trust: 0.6, caution: 0.3, about: 'reads demand well and knows it' },
  careful: { noise: 0.22, doubt: 0.35, margin: 0.45, minOdds: 0.65, learn: 0.10, trust: 1.0, caution: 0.6, about: 'only sure things, fat margin' },
  steady:  { noise: 0.18, doubt: 0.20, margin: 0.25, minOdds: 0.55, learn: 0.12, trust: 0.6, caution: 0.6, about: 'a decent read, a fair margin' },
  bold:    { noise: 0.45, doubt: 0.15, margin: 0.05, minOdds: 0.40, learn: 0.15, trust: 0.2, caution: 0.0, about: 'overconfident, bids low to win' },
  rookie:  { noise: 0.80, doubt: 0.40, margin: 0.25, minOdds: 0.50, learn: 0.30, trust: 0.3, caution: 0.0, about: 'reads demand badly, learns fast from losses' },
  // Not in the default cast. Swap them in (--careless) to watch the market punish them.
  herd:    { noise: 0.60, doubt: 0.30, margin: 0.20, minOdds: 0.50, learn: 0.10, trust: 0.4, caution: 0.0, about: 'copies what recent auctions cleared at' },
  naive:   { noise: 9.99, doubt: 0.00, margin: 0.00, minOdds: 0.00, learn: 0.00, trust: 0.0, caution: 0.0, about: 'assumes everything gets funded' },
};

// What experience says about how demand turns into success: a campaign with
// less money wanting in than its goal almost never makes it, and one with a
// third more almost always does. Fitted to this market the way a working
// underwriter would learn it (see README, "What the simulation assumes").
const SLOPE = 12;
const SHIFT = -0.7;

const EXPOSURE = 0.6;

export class Underwriter {
  constructor({ id, style, rnd }) {
    this.id = id;
    this.role = 'underwriter';
    this.style = style;
    this.cfg = UNDERWRITER_STYLES[style];
    this.rnd = rnd;
    this.bias = -this.cfg.caution; // correction to its own optimism; learning moves it
    this.sealed = new Map();  // campaign id -> { feeBps, salt, odds }
    this.recentOdds = [];     // what the last few auctions implied (herd only)
  }

  /**
   * Its estimate that the campaign reaches the goal.
   * `hint` is this agent's own read of demand / goal: above 1 means it thinks
   * more money wants in than the goal needs. In the simulation the runner
   * hands each underwriter a noisy copy of the truth. Live, it comes from the
   * interest the announcement drew on near.social.
   */
  odds(c, hint) {
    if (this.style === 'naive') return 0.8;
    const record = c.organizer_record ?? { org_created: 0, org_funded: 0, org_failed: 0 };
    const track = (record.org_funded - record.org_failed) / (record.org_funded + record.org_failed + 2);
    // An uncertain read flattens the odds: the less it trusts its own read,
    // the closer to a coin flip. (Logistic-normal approximation.)
    const spread = SLOPE * this.cfg.doubt;
    const read = (SLOPE * Math.log(clamp(hint, 0.05, 20)) + SHIFT) / Math.sqrt(1 + (Math.PI / 8) * spread * spread);
    let x = read + this.bias + this.cfg.trust * track;
    if (this.style === 'herd' && this.recentOdds.length) {
      const crowd = this.recentOdds.reduce((a, b) => a + b, 0) / this.recentOdds.length;
      x = 0.3 * x + 0.7 * Math.log(crowd / (1 - crowd));
    }
    return clamp(1 / (1 + Math.exp(-x)), 0.02, 0.98);
  }

  /**
   * The lowest fee worth taking: break-even for its odds, plus its margin.
   * EXPOSURE is the share of the bond a failed campaign typically costs: a
   * failed campaign is rarely full, and late pledges earn little bonus (R6).
   */
  feeFor(c, odds) {
    return Math.max(1, Math.ceil(((c.bonus_bps * EXPOSURE * (1 - odds)) / odds) * (1 + this.cfg.margin)));
  }

  decide(view) {
    const out = [];
    for (const c of view.campaigns) {
      const mine = this.sealed.get(c.id);

      if (c.phase === 'Commit' && !mine && c.hint !== undefined) {
        const odds = this.odds(c, c.hint);
        const feeBps = this.feeFor(c, odds);
        this.sealed.set(c.id, { feeBps, odds, salt: null, passed: true });
        if (odds < this.cfg.minOdds || feeBps > c.max_fee_bps) continue;      // not worth guaranteeing
        if (view.me.balance < big(c.bond)) continue;                           // cannot afford the bond
        const salt = Math.floor(this.rnd() * 2 ** 48).toString(36);
        this.sealed.set(c.id, { feeBps, odds, salt, passed: false });
        out.push({ type: 'commit', id: c.id, commitment: commitment(c.id, this.id, feeBps, salt), note: { feeBps, odds } });
      }

      if (c.phase === 'Reveal' && mine && !mine.passed && !mine.revealed) {
        mine.revealed = true;
        out.push({ type: 'reveal', id: c.id, feeBps: mine.feeBps, salt: mine.salt });
      }

      // R10: when a campaign it guarantees is close, filling the gap can be
      // cheaper than paying the bonus.
      if (c.phase === 'Funding' && c.underwriter === this.id && elapsed(c, view.now) >= 0.85 && !mine?.rescued) {
        const gap = big(c.goal) - big(c.raised);
        const fee = (big(c.goal) * big(c.clearing_fee_bps)) / BPS;
        if (gap > 0n && gap < big(c.bonus_owed) + fee && view.me.balance >= gap) {
          if (mine) mine.rescued = true;
          out.push({ type: 'pledge', id: c.id, amount: gap, note: { rescue: true } });
        }
      }
    }
    return out;
  }

  /**
   * Called once per finished campaign. An underwriter learns from the ones it
   * guaranteed: winning an auction means it was the most optimistic bidder,
   * so those are exactly the cases where its judgment needs correcting.
   */
  learn(c, funded) {
    const mine = this.sealed.get(c.id);
    if (mine && c.underwriter === this.id) this.bias += this.cfg.learn * ((funded ? 1 : 0) - mine.odds) * 4;
    if (c.underwriter) {
      const implied = c.bonus_bps / (c.bonus_bps + c.clearing_fee_bps);
      this.recentOdds.push(clamp(implied, 0.05, 0.95));
      if (this.recentOdds.length > 4) this.recentOdds.shift();
    }
  }
}

// ---- backers -------------------------------------------------------------------

export const BACKER_KINDS = {
  believer: 'pledges as soon as funding opens',
  follower: 'joins once enough others have',
  holdout: 'hopes others will pay; pledges only if its money is what closes the gap',
  hunter: 'does not care about the project; pledges early to guaranteed campaigns it expects to fail, for the bonus',
};

export class Backer {
  /**
   * cap: the most this user will put into one campaign (yocto, BigInt).
   * interests: { topic: weight 0..1 }.
   * lockCostBps: what having money tied up for a campaign is worth to this
   *   user. If the bonus covers it, a failed campaign is no longer a loss.
   * joinAt: for followers, the share of the goal that must already be pledged.
   */
  constructor({ id, kind, cap, interests, lockCostBps, joinAt, rnd }) {
    this.id = id;
    this.role = 'backer';
    this.kind = kind;
    this.cap = cap;
    this.interests = interests;
    this.lockCostBps = lockCostBps;
    this.joinAt = joinAt;
    this.rnd = rnd;
    this.match = new Map();   // campaign id -> 0..1, how much this user wants it
    this.done = new Set();    // campaigns already pledged to
  }

  /** How much this user would put into a campaign it cares about. */
  valueFor(c) {
    if (this.kind === 'hunter') return this.cap / 2n;
    if (!this.match.has(c.id)) {
      const weight = this.interests[c.topic] ?? 0;
      this.match.set(c.id, weight === 0 ? 0 : clamp(weight * (0.6 + 0.8 * this.rnd()), 0, 1));
    }
    return (this.cap * BigInt(Math.round(this.match.get(c.id) * 1000))) / 1000n;
  }

  /**
   * Does the bonus make a failed campaign painless for this user? The bonus
   * on offer shrinks as the window runs out (R6), so this is true early and
   * stops being true late.
   */
  covered(c, now) {
    return c.guaranteed && c.bonus_bps * (1 - elapsed(c, now)) >= this.lockCostBps;
  }

  wants(c, now) {
    const done = progress(c);
    const time = elapsed(c, now);
    const value = this.valueFor(c);
    switch (this.kind) {
      case 'believer':
        return true;
      case 'follower':
        // With a bonus that covers the wait, there is no reason to wait for others.
        return this.covered(c, now) || done >= this.joinAt;
      case 'holdout': {
        const gap = big(c.goal) - big(c.raised);
        const pivotal = time >= 0.7 && gap <= (value * 3n) / 2n;
        // Guaranteed and falling behind: failing now pays, so join.
        return pivotal || (this.covered(c, now) && done < time);
      }
      case 'hunter': {
        // A bet against the guarantor: a slow start on a campaign the auction
        // itself priced as doubtful. It has to go in early to earn anything,
        // and if the campaign then fills, it has paid for the project.
        const odds = c.bonus_bps / (c.bonus_bps + c.clearing_fee_bps);
        return this.covered(c, now) && time >= 0.15 && done <= 0.2 && odds <= 0.8;
      }
      default:
        return false;
    }
  }

  decide(view) {
    const out = [];
    for (const c of view.campaigns) {
      if (c.phase !== 'Funding' || this.done.has(c.id)) continue;
      const value = this.valueFor(c);
      if (value < view.minPledge || !this.wants(c, view.now)) continue;
      const amount = value < view.me.balance ? value : view.me.balance;
      if (amount < view.minPledge) continue;
      this.done.add(c.id);
      out.push({ type: 'pledge', id: c.id, amount });
    }
    return out;
  }
}
