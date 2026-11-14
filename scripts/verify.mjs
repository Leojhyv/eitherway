// Checks a recorded swarm run against RULES.md, from the outside.
//
//   node scripts/verify.mjs                       the run the page shows (data/latest.json)
//   node scripts/verify.mjs data/runs/<file>.json a specific run
//
// For a testnet run it reads the contract's state from the chain itself and
// trusts nothing in the recording except which campaigns and accounts to look
// at. A local run has no chain, so it checks the state the recording
// captured. Either way it re-derives every auction and every payout with its
// own arithmetic and compares.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rpc } from '../swarm/near.mjs';
import { ROOT, loadConfig } from './keys.mjs';

const file = process.argv[2] ?? join(ROOT, 'data', 'latest.json');
const run = JSON.parse(readFileSync(file, 'utf8'));
const onChain = !['local', 'local rehearsal'].includes(run.network);
const rpc = onChain ? new Rpc(loadConfig().rpc) : null;
const view = (method, args) => rpc.view(run.contract, method, args);

let failed = 0;
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const big = BigInt;
const near = (y) => (Number(big(y) / 10n ** 18n) / 1e6).toFixed(4);

console.log(`${file}\n${run.network}, contract ${run.contract}, ${run.rounds.length} campaigns; reading ${onChain ? 'the chain' : 'the recorded state (a local run has no chain to read)'}\n`);

for (const r of run.rounds) {
  const c = onChain ? await view('get_campaign', { campaign_id: r.id }) : r.campaign;
  const bids = onChain ? await view('get_bids', { campaign_id: r.id }) : r.chainBids;
  const pledges = onChain ? await view('get_pledges', { campaign_id: r.id, from_index: 0, limit: 200 }) : r.chainPledges;
  console.log(`campaign ${r.id}: "${c.title}" -> ${c.status}`);

  // R2: the bond.
  check(big(c.bond) === (big(c.goal) * big(c.bonus_bps)) / 10000n, `R2  bond is goal x bonus: ${near(c.bond)} NEAR`);

  // R5: re-run the auction from the bids on chain.
  const revealed = bids.map((b, i) => ({ ...b, i })).filter((b) => b.revealed).sort((a, b) => a.fee_bps - b.fee_bps || a.i - b.i);
  const best = revealed[0];
  const winner = best && best.fee_bps <= c.max_fee_bps ? best.account : null;
  const clearing = winner ? (revealed[1] ? Math.min(revealed[1].fee_bps, c.max_fee_bps) : c.max_fee_bps) : 0;
  check(c.underwriter === winner, `R5  winner is the lowest revealed bid within the limit: ${winner ?? 'nobody'}`);
  check(c.clearing_fee_bps === clearing, `R5  winner is paid the runner-up's price: ${clearing} bps`);
  check(bids.every((b) => /^[0-9a-f]{64}$/.test(b.commitment)), `R3  every bid was a sealed hash (${bids.length} bids)`);

  // R6: pledges.
  const raised = pledges.reduce((s, p) => s + big(p.amount), 0n);
  const bonuses = pledges.reduce((s, p) => s + big(p.bonus), 0n);
  check(raised === big(c.raised), `R6  pledges add up to the amount raised: ${near(raised)} NEAR from ${pledges.length} backers`);
  check(raised <= big(c.goal), 'R6  the campaign never took more than its goal');
  check(pledges.every((p) => big(p.bonus) <= (big(p.amount) * big(c.bonus_bps)) / 10000n), 'R6  no pledge earned more than the full bonus rate');
  check(bonuses <= big(c.bond), `I3  bonuses earned (${near(bonuses)}) never exceed the bond (${near(c.bond)})`);

  // R7 / R8: the outcome.
  if (c.status === 'Funded') {
    check(raised === big(c.goal), 'R7  funded exactly at the goal');
    check(big(c.bonus_paid) === 0n, 'R7  no bonus is paid on a funded campaign');
  } else if (c.status === 'Failed') {
    check(raised < big(c.goal), 'R8  failed campaigns are below the goal');
    check(big(c.bonus_paid) === (winner ? bonuses : 0n), `R8  bonuses paid equal bonuses earned: ${near(c.bonus_paid)} NEAR`);
    check(c.refunded_upto === c.backer_count, 'I5  every backer was refunded');
  }
  check(c.closed, 'I5  the campaign is closed and holds nothing');
  console.log('');
}

if (onChain) {
  // I1: nothing created, nothing lost. Every account that ever used this
  // contract is in the cast, so their free balances must add up to the vault.
  const totals = await view('get_totals', {});
  let free = 0n;
  for (const a of run.cast) free += big((await view('get_account', { account_id: a.id })).balance);
  const open = (await view('get_campaigns', { from_index: 0, limit: 100 })).filter((c) => !c.closed).length;
  console.log('the whole contract');
  check(open > 0 || free === big(totals.vault), `I1  free balances of all ${run.cast.length} agents (${near(free)}) equal the vault (${near(totals.vault)})${open ? ` [${open} campaigns still open: skipped]` : ''}`);
  const acct = await rpc.viewAccount(run.contract);
  check(big(acct.amount) >= big(totals.vault), `I1  the contract account holds at least the vault: ${near(acct.amount)} NEAR`);
  console.log('');
}

console.log(failed ? `${failed} of ${checks} checks FAILED` : `all ${checks} checks passed`);
process.exit(failed ? 1 : 0);
