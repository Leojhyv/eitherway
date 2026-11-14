// Puts the swarm on NEAR testnet: the contract and one sub-account per agent.
//
//   node scripts/setup.mjs                 create accounts, deploy, set profiles
//   node scripts/setup.mjs --plan          only show what it would do and what it costs
//   node scripts/setup.mjs --scale 0.005   a fixed scale (default: the largest that fits the parent's balance)
//
// It needs the parent account in swarm.config.json to exist and hold testnet
// NEAR, with its key in .keys/<parent>.json. Get one from the faucet:
//
//   node scripts/faucet.mjs <name>.testnet
//
// Safe to run again: it skips whatever already exists.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, Rpc, actions, formatNear, parseNear, NEAR } from '../swarm/near.mjs';
import { DEFAULTS, buildCast, near } from '../swarm/sim.mjs';
import { socialArgs } from '../swarm/social.mjs';
import { mandateText } from '../swarm/llm.mjs';
import { ROOT, ensureKey, loadConfig, loadKey } from './keys.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const planOnly = args.includes('--plan');
const seed = Number(flag('seed', 9));
const rounds = Number(flag('rounds', 4));

const config = loadConfig();
const rpc = new Rpc(config.rpc, { log: (l) => console.log(`  ${l}`) });
const wasm = readFileSync(join(ROOT, 'contract', 'res', 'eitherway.wasm'));
const GAS_RESERVE = parseNear('0.05'); // for an agent's transaction fees over a run
const FEES = parseNear('0.2'); // the parent's own transactions during setup
const RESERVE = parseNear(flag('reserve', '1')); // kept by the parent to top up backers between rounds

// What each account needs at a given scale.
const cast = buildCast(seed);
// Storage costs 1 NEAR per 100 kB; leave room for campaign records too.
const contractFunds = (BigInt(wasm.length) * NEAR) / 100000n + parseNear('0.4');
function plan(scale) {
  const scaled = (yocto) => (yocto * BigInt(Math.round(scale * 1e6))) / 1000000n;
  const wants = [{ id: config.contract, amount: contractFunds, role: 'contract' }];
  for (const b of cast.backers) wants.push({ id: `${b.id}.${config.parent}`, amount: scaled(b.cap) * 2n + GAS_RESERVE, role: `backer (${b.kind})`, agent: b });
  for (const u of cast.underwriters) wants.push({ id: `${u.id}.${config.parent}`, amount: scaled(near(DEFAULTS.capital)) + GAS_RESERVE, role: `underwriter (${u.style})`, agent: u });
  for (const o of cast.organizers) wants.push({ id: `${o.id}.${config.parent}`, amount: GAS_RESERVE + parseNear('0.02') * BigInt(rounds), role: 'organizer', agent: o });
  return { wants, total: wants.reduce((sum, w) => sum + w.amount, 0n) };
}

console.log(`network: ${config.network}   parent: ${config.parent}   contract: ${config.contract}`);
console.log(`contract size: ${(wasm.length / 1024).toFixed(1)} kB`);

const parentState = await rpc.viewAccount(config.parent);
const balance = parentState ? BigInt(parentState.amount) : parseNear(flag('balance', '10'));
console.log(parentState
  ? `parent balance: ${formatNear(balance, 3)} NEAR`
  : `the parent does not exist yet; planning for a parent holding ${formatNear(balance, 2)} NEAR`);

// Every agent's budget is scaled to fit what the parent holds.
let scale = flag('scale', 'auto');
if (scale === 'auto') {
  scale = 0;
  for (let step = 1; step <= 40; step++) {
    if (plan(step * 0.0005).total + RESERVE + FEES <= balance) scale = step * 0.0005;
  }
  scale = Math.round(scale * 10000) / 10000;
} else {
  scale = Number(scale);
}
const { wants, total } = plan(scale || 0.0005);
console.log(`scale: x${scale}   ${wants.length} accounts need ${formatNear(total, 3)} NEAR; the parent keeps ${formatNear(RESERVE, 2)} for top-ups and about ${formatNear(FEES, 1)} for fees`);

if (planOnly) {
  for (const w of wants) console.log(`  ${w.id.padEnd(44)} ${formatNear(w.amount, 4).padStart(8)} NEAR  ${w.role}`);
  if (!parentState) console.log(`\nCreate the parent first:  node scripts/faucet.mjs ${config.parent}   (or node scripts/fund.mjs)`);
  process.exit(0);
}
if (!parentState) {
  console.log(`\nThe parent account ${config.parent} does not exist yet.`);
  console.log(`Create it first:  node scripts/faucet.mjs ${config.parent}   (or node scripts/fund.mjs)`);
  process.exit(1);
}
if (scale < 0.002 || total + FEES > balance) {
  console.log(`\nNot enough NEAR in the parent: the smallest workable swarm needs ${formatNear(plan(0.002).total + FEES + RESERVE, 2)} NEAR.`);
  process.exit(1);
}

const parent = new Account(rpc, config.parent, loadKey(config.parent).secretKey);

// 1. Sub-accounts. Only the parent can create <name>.<parent>.
for (const w of wants) {
  const key = ensureKey(w.id);
  const exists = await rpc.viewAccount(w.id);
  if (exists) {
    const short = w.amount - BigInt(exists.amount);
    if (short > parseNear('0.01')) {
      await parent.send(w.id, [actions.transfer(short)]);
      console.log(`topped up ${w.id} by ${formatNear(short, 4)} NEAR`);
    }
    continue;
  }
  const r = await parent.createSubAccount(w.id, key.publicKey, w.amount);
  console.log(`created ${w.id} with ${formatNear(w.amount, 4)} NEAR  (${w.role})  tx ${r.hash}`);
}

// 2. The contract.
const contract = new Account(rpc, config.contract, loadKey(config.contract).secretKey);
const state = await rpc.viewAccount(config.contract);
const codeHash = (await import('node:crypto')).createHash('sha256').update(wasm).digest();
const { b58encode } = await import('../swarm/near.mjs');
if (state.code_hash !== b58encode(codeHash)) {
  const r = await contract.send(config.contract, [actions.deployContract(wasm)]);
  console.log(`deployed the contract to ${config.contract}  tx ${r.hash}`);
} else {
  console.log('contract already deployed and up to date');
}
console.log('contract rules:', JSON.stringify(await rpc.view(config.contract, 'get_rules')));

// 3. near.social profiles, so every agent says in public that it is automated.
const website = flag('website', 'https://github.com/');
for (const w of wants) {
  if (!w.agent) continue;
  const account = new Account(rpc, w.id, loadKey(w.id).secretKey);
  const about = w.agent.role === 'backer'
    ? `Automated account. A backer agent in the EitherWay swarm. My user told me: "${mandateText(w.agent, scale)}"`
    : w.agent.role === 'underwriter'
      ? `Automated account. An underwriter agent in the EitherWay swarm (${w.agent.style}: ${w.agent.cfg.about}). I guarantee crowdfunding campaigns and pay the bonus if they fall short.`
      : `Automated account. An organizer in the EitherWay swarm demo (${w.agent.about}).`;
  const sent = await account.send(config.social.receiver, [
    actions.functionCall('__fastdata_kv', socialArgs.profile({ name: w.id.split('.')[0], about, website }), 1_000_000_000n, 0n),
  ], { allowFailure: true });
  console.log(`profile set for ${w.id}  tx ${sent.hash}`);
}

// 4. What the live runner needs to know: the seed and scale the agents were funded for.
const deployment = {
  network: config.network, parent: config.parent, contract: config.contract,
  seed, rounds, scale, reserve: formatNear(RESERVE, 2), createdAt: new Date().toISOString(),
  accounts: wants.map((w) => ({ id: w.id, role: w.role, funded: formatNear(w.amount, 4) })),
};
writeFileSync(join(ROOT, 'data', 'deployment.json'), JSON.stringify(deployment, null, 2));
console.log(`\nwrote data/deployment.json (seed ${seed}, scale x${scale})`);
console.log(`Ready. Run the swarm:  node swarm/live.mjs --rounds ${rounds} --llm`);
