// Waits for the testnet faucet to open, then creates the swarm's parent account.
//
//   node scripts/wait-faucet.mjs                 try every 5 minutes for up to 2 hours
//   node scripts/wait-faucet.mjs --every 10 --for 60
//
// It stops straight away if the faucet says the next allowance is hours off
// (exit code 2), so it never hammers the faucet. Exit code 0: the parent exists.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rpc } from '../swarm/near.mjs';
import { ROOT, ensureKey, loadConfig } from './keys.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const every = Number(flag('every', 5)) * 60_000;
const deadline = Date.now() + Number(flag('for', 120)) * 60_000; // minutes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => `${new Date().toISOString().slice(11, 16)} UTC`;

// Only one wait at a time, so two schedules can never double the requests.
const lock = join(ROOT, '.keys', 'wait-faucet.lock');
const minutes = Number(flag('for', 120));
if (existsSync(lock) && Date.now() - Number(readFileSync(lock, 'utf8')) < (minutes + 10) * 60_000) {
  console.log(`${now()} another wait for the faucet is already running`);
  process.exit(4);
}
writeFileSync(lock, String(Date.now()));
process.on('exit', () => { try { rmSync(lock); } catch { /* already gone */ } });

const config = loadConfig();
const rpc = new Rpc(config.rpc);
const id = config.parent;
const key = ensureKey(id);

for (;;) {
  if (await rpc.viewAccount(id)) {
    console.log(`${now()} ${id} exists. Next: node scripts/setup.mjs`);
    process.exit(0);
  }
  let status = 0;
  let text = '';
  try {
    const res = await fetch('https://helper.testnet.near.org/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.publicKey }),
      signal: AbortSignal.timeout(60_000),
    });
    status = res.status;
    text = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
  } catch (e) {
    text = `no answer (${e.message})`;
  }
  console.log(`${now()} faucet: ${status || '-'} ${text}`);

  if (status >= 200 && status < 300) {
    for (let i = 0; i < 20; i++) {
      if (await rpc.viewAccount(id)) {
        console.log(`${now()} created ${id}. Next: node scripts/setup.mjs`);
        process.exit(0);
      }
      await sleep(3000);
    }
    console.log(`${now()} the faucet answered, but ${id} is not visible yet`);
    process.exit(1);
  }

  const hours = Number(text.match(/retry in (\d+) hours?/i)?.[1] ?? NaN);
  if (hours >= 2) {
    console.log(`${now()} the next allowance is about ${hours} hours away: stopping`);
    process.exit(2);
  }
  if (Date.now() + every > deadline) {
    console.log(`${now()} still closed: giving up for now`);
    process.exit(3);
  }
  await sleep(every);
}
