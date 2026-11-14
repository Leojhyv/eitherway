// Prints the implicit account id (64 hex chars) for a saved key, creating the key if needed.
import { ensureKey } from './keys.mjs';
import { b58decode } from '../swarm/near.mjs';
const name = process.argv[2] ?? 'implicit-funder';
const key = ensureKey(name);
console.log(Buffer.from(b58decode(key.publicKey.replace('ed25519:', ''))).toString('hex'));
