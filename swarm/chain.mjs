// Two places the live swarm can run, behind one interface:
//
//   NearChain   the real contract on NEAR, one sub-account and key per agent
//   LocalChain  the rules engine in memory, on the wall clock
//
// The runner (swarm/live.mjs) and the checker (scripts/verify.mjs) only ever
// talk to this interface, so a local run on LocalChain exercises the same code
// that later signs real transactions.
//
//   view(method, args)                       -> JSON, like a contract view call
//   call(who, method, args, { deposit })     -> { hash, value, gasBurnt }, or throws TxError
//   now()                                    -> milliseconds
//   walletBalance(who)                       -> NEAR the agent can spend outside the contract
//   topUp(who, amount)                       -> sends the agent NEAR from the parent account

import { Market, RuleError } from '../engine/market.mjs';
import { Account, TxError, TGAS, actions } from './near.mjs';

const STORAGE_PRICE = 10n ** 19n; // yoctoNEAR per byte an account stores

// The gas each call gets, in Tgas. When a call is signed, NEAR holds back
// about 0.001 NEAR per Tgas attached, plus about 0.001 NEAR, and returns what
// was not burnt once the call has run (measured on testnet, November 2026). An
// agent's wallet is small, so each call gets what it needs with a wide margin
// rather than the most any call could use: a deposit burns about 2 Tgas.
export const GAS = { deposit: 10, withdraw: 30, create_campaign: 20, commit_bid: 20, reveal_bid: 20, settle_auction: 20, pledge: 20, finalize: 60 };
export const gasFor = (method) => BigInt(GAS[method] ?? 30) * TGAS;
/** NEAR held back while a call with this much gas runs. */
export const gasReserve = (gas) => gas * 10n ** 9n + 10n ** 21n;

export class NearChain {
  constructor({ rpc, contractId, keys, explorer, parentKey = null }) {
    this.kind = 'near';
    this.rpc = rpc;
    this.contractId = contractId;
    this.explorer = explorer;
    this.accounts = new Map();
    for (const k of keys) this.accounts.set(k.accountId, new Account(rpc, k.accountId, k.secretKey));
    // The parent account pays agents' allowances between rounds.
    this.parent = parentKey ? new Account(rpc, parentKey.accountId, parentKey.secretKey) : null;
    this.toppedUp = 0n;
  }
  now() {
    return Date.now();
  }
  view(method, args = {}) {
    return this.rpc.view(this.contractId, method, args);
  }
  async call(who, method, args = {}, { deposit = 0n, gas = gasFor(method) } = {}) {
    const account = this.accounts.get(who);
    if (!account) throw new Error(`no key loaded for ${who}`);
    return account.call(this.contractId, method, args, { deposit, gas });
  }
  /** What an agent can spend from its own account: its balance minus what its storage needs. */
  async walletBalance(who) {
    const a = await this.rpc.viewAccount(who);
    return a ? BigInt(a.amount) - BigInt(a.storage_usage) * STORAGE_PRICE : 0n;
  }
  async topUp(who, amount) {
    if (!this.parent) throw new Error('no parent key loaded for top-ups');
    const r = await this.parent.send(who, [actions.transfer(amount)]);
    this.toppedUp += amount;
    return r;
  }
  txUrl(hash) {
    return `${this.explorer}/txns/${hash}`;
  }
}

export class LocalChain {
  /** speed > 1 fast-forwards the local clock. */
  constructor({ speed = 1 } = {}) {
    this.kind = 'local';
    this.speed = speed;
    this.t0 = Date.now();
    this.contractId = 'escrow.local';
    this.m = new Market();
    this.count = 0;
    this.wallets = new Map(); // NEAR an agent holds outside the contract
    this.toppedUp = 0n;
  }
  now() {
    return Math.floor(this.t0 + (Date.now() - this.t0) * this.speed);
  }
  fund(who, amount) {
    this.wallets.set(who, (this.wallets.get(who) ?? 0n) + amount);
  }
  async walletBalance(who) {
    return this.wallets.get(who) ?? 0n;
  }
  async topUp(who, amount) {
    this.fund(who, amount);
    this.toppedUp += amount;
    return { hash: `local-topup-${++this.count}` };
  }
  async view(method, args = {}) {
    const m = this.m;
    const now = this.now();
    switch (method) {
      case 'get_campaign': return args.campaign_id < m.campaigns.length ? m.campaignView(args.campaign_id, now) : null;
      case 'get_campaigns': {
        const from = args.from_index ?? 0;
        const to = Math.min(m.campaigns.length, from + (args.limit ?? 50));
        return Array.from({ length: Math.max(0, to - from) }, (_, i) => m.campaignView(from + i, now));
      }
      case 'get_bids': return m.bidsView(args.campaign_id);
      case 'get_pledges': return m.pledgesView(args.campaign_id).slice(args.from_index ?? 0, (args.from_index ?? 0) + (args.limit ?? 100));
      case 'get_account': return m.accountView(args.account_id);
      case 'get_totals': return { vault: m.vault.toString(), campaigns: m.campaigns.length };
      default: throw new Error(`unknown view ${method}`);
    }
  }
  async call(who, method, args = {}, { deposit = 0n, gas = gasFor(method) } = {}) {
    const m = this.m;
    const now = this.now();
    const hash = `local-${++this.count}`;
    const wallet = this.wallets.get(who) ?? 0n;
    // As on NEAR: the wallet must cover the deposit and the gas held back while the call runs.
    const cost = deposit + gasReserve(gas);
    if (cost > wallet) throw new TxError(`E_WALLET: not enough NEAR in the agent wallet {"NotEnoughBalance":{"balance":"${wallet}","cost":"${cost}"}}`, hash);
    let value;
    try {
      switch (method) {
        case 'deposit': m.deposit(who, deposit); break;
        case 'withdraw': m.withdraw(who, BigInt(args.amount)); this.fund(who, BigInt(args.amount)); break;
        case 'create_campaign':
          value = m.createCampaign(who, {
            title: args.title, socialPost: args.social_post ?? '', beneficiary: args.beneficiary ?? who,
            goal: BigInt(args.goal), bonusBps: args.bonus_bps, maxFeeBps: args.max_fee_bps,
            commitSecs: args.commit_secs, revealSecs: args.reveal_secs, fundingSecs: args.funding_secs,
          }, now);
          break;
        case 'commit_bid': m.commitBid(who, args.campaign_id, args.commitment, now, deposit); break;
        case 'reveal_bid': m.revealBid(who, args.campaign_id, args.fee_bps, args.salt, now); break;
        case 'settle_auction': m.settleAuction(args.campaign_id, now); break;
        case 'pledge': value = m.pledge(who, args.campaign_id, BigInt(args.amount), now, deposit).toString(); break;
        case 'finalize': value = m.finalize(args.campaign_id, now, args.limit ?? 100); break;
        default: throw new Error(`unknown method ${method}`);
      }
    } catch (e) {
      if (e instanceof RuleError) throw new TxError(e.message, hash);
      throw e;
    }
    if (deposit > 0n) this.wallets.set(who, wallet - deposit);
    return { hash, value };
  }
  txUrl(hash) {
    return `#${hash}`;
  }
}
