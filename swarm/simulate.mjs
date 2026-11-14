// Simulation mode from the command line. No chain, no keys, no model calls.
//
//   node swarm/simulate.mjs                 one run, seed 7, 30 campaigns
//   node swarm/simulate.mjs --seed 3        another crowd
//   node swarm/simulate.mjs --sweep 200     200 crowds, summary only
//   node swarm/simulate.mjs --json out.json save the full run

import { writeFileSync } from 'node:fs';
import { compare, sweep, DEFAULTS } from './sim.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const seed = Number(flag('seed', 7));
const rounds = Number(flag('rounds', DEFAULTS.rounds));
const opts = { rounds };
// --careless: swap in two underwriters that do not think: one copies the
// crowd, one assumes every campaign succeeds.
if (args.includes('--careless')) opts.underwriters = ['sharp', 'careful', 'steady', 'herd', 'naive'];
// --pros: five underwriters that all read demand well, to check the result
// does not depend on careless ones subsidising backers.
if (args.includes('--pros')) opts.underwriters = ['sharp', 'careful', 'steady', 'sharp', 'steady'];
// --believers N: how many of the 20 backers pledge without waiting for anyone.
if (flag('believers')) {
  const b = Number(flag('believers'));
  opts.mix = { believer: b, follower: 12 - b, holdout: 6, hunter: 2 };
}
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const fix = (x, d = 2) => x.toFixed(d);

if (args.includes('--sweep')) {
  const count = Number(flag('sweep', 200));
  const s = sweep(Array.from({ length: count }, (_, i) => i + 1), opts);
  console.log(`\n${s.seeds} different crowds, ${s.campaigns} campaigns each way\n`);
  console.log('                                   ordinary     EitherWay');
  console.log(`campaigns funded                   ${pct(s.fundedPlain).padStart(8)}     ${pct(s.fundedEitherWay).padStart(9)}`);
  console.log(`  of those with enough demand      ${pct(s.viableFundedPlain).padStart(8)}     ${pct(s.viableFundedEitherWay).padStart(9)}`);
  console.log(`NEAR that reached projects         ${fix(s.paidToProjectsPlain, 0).padStart(8)}     ${fix(s.paidToProjectsEitherWay, 0).padStart(9)}`);
  console.log(`NEAR tied up for nothing           ${fix(s.lockedForNothingPlain, 0).padStart(8)}     ${fix(s.lockedForNothingEitherWay, 0).padStart(9)}   (pledged to a failed campaign, returned with no bonus)`);
  console.log(`bonuses paid to backers                             ${fix(s.bonusPaid, 0).padStart(9)}`);
  console.log(`fees earned by underwriters                         ${fix(s.feesPaid, 0).padStart(9)}`);
  console.log(`\ncampaigns that found a guarantor: ${pct(s.guaranteedShare)}; rescued by their guarantor: ${s.rescued}`);
  console.log(`EitherWay funded more campaigns in ${s.eitherWayBetterIn} of ${s.seeds} crowds, fewer in ${s.eitherWayWorseIn}.\n`);
  console.log(`underwriters as a group: ${(s.underwriterGroupProfit >= 0 ? '+' : '') + fix(s.underwriterGroupProfit)} NEAR per run`);
  console.log('by strategy (mean profit in NEAR per run, and runs that lost money):');
  for (const [style, r] of Object.entries(s.underwriterProfit)) {
    console.log(`  ${style.padEnd(8)} ${(r.mean >= 0 ? '+' : '') + fix(r.mean)}`.padEnd(22) + `lost money in ${pct(r.lostMoneyShare)} of runs`);
  }
  if (flag('json')) writeFileSync(flag('json'), JSON.stringify(s, null, 2));
} else {
  const run = compare(seed, opts);
  const p = run.plain.summary;
  const e = run.eitherway.summary;
  console.log(`\nseed ${seed}: ${rounds} campaigns, 20 backers, 5 underwriters, 3 organizers\n`);
  console.log(' #  project                                    goal  want  guarantor  fee   odds   ordinary   EitherWay');
  run.eitherway.rounds.forEach((r, i) => {
    const o = run.plain.rounds[i];
    const result = (x) => (x.status === 'Funded' ? (x.rescued ? 'funded*' : 'funded ') : `${pct(x.raised / x.goal).padStart(4)}   `);
    console.log(
      `${String(i + 1).padStart(2)}  ${r.title.slice(0, 40).padEnd(40)} ${fix(r.goal, 1).padStart(6)} ${('x' + fix(r.demandRatio)).padStart(5)}  ` +
      `${(r.underwriter ?? '-').padEnd(9)} ${(r.underwriter ? fix(r.clearingFeeBps / 100, 1) + '%' : '-').padStart(5)} ${(r.impliedOdds ? pct(r.impliedOdds) : '-').padStart(5)}   ` +
      `${result(o)}    ${result(r)}${r.status === 'Failed' && r.bonusPaid ? ` +${fix(r.bonusPaid)} bonus` : ''}`,
    );
  });
  console.log('\n   want = money that wanted in / goal.  odds = break-even odds implied by the winning fee.  * = rescued by its guarantor\n');
  console.log('                                   ordinary     EitherWay');
  console.log(`campaigns funded                   ${String(p.funded).padStart(8)}     ${String(e.funded).padStart(9)}   of ${rounds}`);
  console.log(`  of those with enough demand      ${String(p.viableFunded).padStart(8)}     ${String(e.viableFunded).padStart(9)}   of ${e.viable}`);
  console.log(`NEAR that reached projects         ${fix(p.paidToProjects, 1).padStart(8)}     ${fix(e.paidToProjects, 1).padStart(9)}`);
  console.log(`NEAR tied up for nothing           ${fix(p.lockedForNothing, 1).padStart(8)}     ${fix(e.lockedForNothing, 1).padStart(9)}`);
  console.log(`bonuses paid to backers            ${'-'.padStart(8)}     ${fix(e.bonusPaid, 1).padStart(9)}`);
  console.log('\nunderwriters:');
  for (const u of e.underwriters) {
    console.log(`  ${u.id}  ${u.style.padEnd(8)} won ${String(u.won).padStart(2)}  funded ${String(u.funded).padStart(2)}  failed ${String(u.failed).padStart(2)}  fees +${fix(u.fees)}  bonuses -${fix(u.bonuses)}  profit ${(u.profit >= 0 ? '+' : '') + fix(u.profit)}   (${u.about})`);
  }
  console.log('');
  if (flag('json')) writeFileSync(flag('json'), JSON.stringify(run));
}
