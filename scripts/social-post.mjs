// Posts to the real near.social (mainnet) from your own account, or shows
// exactly what it would send.
//
//   node scripts/social-post.mjs "Your text #eitherway"
//       Dry run (the default): prints the transaction. Nothing is sent.
//
//   node scripts/social-post.mjs "Your text" --send --account you.near --key-file path/to/key.json
//       Sends it. The key file is {"secretKey": "ed25519:..."}.
//
//   --reply-to alice.near/1759140000000     post as a reply in that thread
//
// Use a function-call key limited to the receiver `social` and the method
// `__fastdata_kv`: such a key cannot move funds. Create one with near-cli:
//
//   near account add-key you.near grant-function-call-access --allowance '0.1 NEAR' \
//     --contract-account-id social --function-names __fastdata_kv use-manually-provided-public-key <key> ...
//
// Everything on near.social is public and permanent. Say in your profile if
// the account is automated.

import { readFileSync } from 'node:fs';
import { Account, MAINNET_RPCS, Rpc } from '../swarm/near.mjs';
import { KvSocial, socialArgs } from '../swarm/social.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};
const text = args[0];
if (!text || text.startsWith('--')) {
  console.log('usage: node scripts/social-post.mjs "text" [--reply-to account/post_id] [--send --account you.near --key-file key.json]');
  process.exit(1);
}
if (text.length > 25000) throw new Error('near.social posts are at most 25,000 characters');

const replyTo = flag('reply-to');
const id = String(Date.now());
const record = replyTo ? socialArgs.reply(id, text, replyTo) : socialArgs.post(id, text);

console.log('receiver: social (mainnet)');
console.log('method:   __fastdata_kv   gas: 1 Ggas   deposit: 0');
console.log(`args:     ${JSON.stringify(record, null, 2)}`);

if (!args.includes('--send')) {
  console.log('\nDry run: nothing was sent. Add --send --account <you.near> --key-file <file> to post it.');
  process.exit(0);
}

const accountId = flag('account');
const keyFile = flag('key-file');
if (!accountId || !keyFile) throw new Error('--send needs --account and --key-file');
const { secretKey } = JSON.parse(readFileSync(keyFile, 'utf8'));
const account = new Account(new Rpc(MAINNET_RPCS), accountId, secretKey);
const social = new KvSocial({ network: 'mainnet', accounts: new Map([[accountId, account]]) });
const sent = replyTo ? await social.reply(accountId, text, replyTo) : await social.post(accountId, text, id);
console.log(`\nsent: transaction ${sent.hash}`);
console.log('The transaction shows as failed on explorers. That is how near.social works: the data is still indexed.');
console.log(`check: https://api2.near.social/v1/tx/${sent.hash}`);
console.log(`post:  https://near.social/${sent.ref}`);
