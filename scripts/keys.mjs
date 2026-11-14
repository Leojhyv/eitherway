// Where the swarm keeps its testnet keys: .keys/<account>.json, never in git.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newKeyPair } from '../swarm/near.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.keys');

const fileFor = (accountId) => join(DIR, `${accountId}.json`);

export const hasKey = (accountId) => existsSync(fileFor(accountId));

export function loadKey(accountId) {
  if (!hasKey(accountId)) throw new Error(`no key for ${accountId} in .keys/ (run scripts/setup.mjs first)`);
  return JSON.parse(readFileSync(fileFor(accountId), 'utf8'));
}

/** Returns the saved key pair for an account, creating and saving one if needed. */
export function ensureKey(accountId) {
  if (hasKey(accountId)) return loadKey(accountId);
  mkdirSync(DIR, { recursive: true });
  const pair = { accountId, ...newKeyPair() };
  writeFileSync(fileFor(accountId), JSON.stringify(pair, null, 2));
  return pair;
}

/** Deployment settings shared by every script. */
export function loadConfig() {
  const file = join(ROOT, 'swarm.config.json');
  if (!existsSync(file)) throw new Error('swarm.config.json is missing');
  return JSON.parse(readFileSync(file, 'utf8'));
}
