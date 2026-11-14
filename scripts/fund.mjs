// Creates the swarm's parent account without the faucet.
//
//   node scripts/fund.mjs            shows the funding address and what it holds
//   node scripts/fund.mjs --create   creates the parent from it once it is funded
//
// Send testnet NEAR from any wallet to the funding address it prints (an
// implicit account: its key is in .keys/, and sending NEAR to it creates it).
// --create then registers the parent named in swarm.config.json through the
// `testnet` registrar, passing on everything but a little for fees, with the
// parent key that scripts/setup.mjs expects.

import { Account, Rpc, b58decode, formatNear, parseNear, TGAS } from '../swarm/near.mjs';
import { ensureKey, loadConfig } from './keys.mjs';

const config = loadConfig();
if (config.network !== 'testnet') throw new Error('this script is for testnet');
const rpc = new Rpc(config.rpc);

const funder = ensureKey('implicit-funder');
const funderId = Buffer.from(b58decode(funder.publicKey.replace('ed25519:', ''))).toString('hex');
const parentKey = ensureKey(config.parent);

const state = await rpc.viewAccount(funderId);
const parentState = await rpc.viewAccount(config.parent);
console.log(`funding address (testnet): ${funderId}`);
console.log(`it holds: ${state ? formatNear(state.amount, 4) : '0'} NEAR`);
console.log(`parent ${config.parent}: ${parentState ? `exists, ${formatNear(parentState.amount, 4)} NEAR` : 'not created yet'}`);

if (!process.argv.includes('--create')) {
  console.log('\nSend testnet NEAR to the funding address, then run: node scripts/fund.mjs --create');
  process.exit(0);
}
if (parentState) {
  console.log('\nThe parent already exists. Next: node scripts/setup.mjs');
  process.exit(0);
}
if (!state) throw new Error('the funding address has no NEAR yet');

const keep = parseNear('0.05');
const amount = BigInt(state.amount) - keep;
if (amount < parseNear('1')) throw new Error('send at least 1 testnet NEAR to the funding address first');

const account = new Account(rpc, funderId, funder.secretKey);
const r = await account.call('testnet', 'create_account', { new_account_id: config.parent, new_public_key: parentKey.publicKey }, { deposit: amount, gas: 100n * TGAS });
console.log(`\ncreated ${config.parent} with ${formatNear(amount, 4)} NEAR  tx ${r.hash}`);
console.log('Next: node scripts/setup.mjs --plan, then node scripts/setup.mjs');
