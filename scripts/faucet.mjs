// Asks the testnet faucet to create and fund one top-level account.
//   node scripts/faucet.mjs <name>.testnet
import { ensureKey } from './keys.mjs';

const id = process.argv[2];
if (!id?.endsWith('.testnet')) throw new Error('usage: node scripts/faucet.mjs <name>.testnet');
const key = ensureKey(id);
const res = await fetch('https://helper.testnet.near.org/account', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.publicKey }),
});
console.log(res.status, (await res.text()).slice(0, 400));
