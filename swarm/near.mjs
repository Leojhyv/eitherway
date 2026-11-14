// A small NEAR client with no dependencies: keys, transaction encoding,
// signing, and JSON-RPC with failover. Node 20+.
//
// It exists so the whole swarm runs with nothing to install, and so a reader
// can see every byte that gets signed.

import { createHash, createPrivateKey, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';

// ---- base58 --------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function b58decode(text) {
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`not base58: ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

// ---- keys ----------------------------------------------------------------------

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** A fresh ed25519 key pair in NEAR's text format. */
export function newKeyPair() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  return {
    publicKey: `ed25519:${b58encode(pub)}`,
    secretKey: `ed25519:${b58encode(Buffer.concat([seed, pub]))}`,
  };
}

function loadKey(secretKey) {
  const raw = b58decode(secretKey.replace(/^ed25519:/, ''));
  if (raw.length !== 64) throw new Error('secret key must be 64 bytes');
  const seed = raw.subarray(0, 32);
  const pub = raw.subarray(32);
  return {
    pub,
    publicKey: `ed25519:${b58encode(pub)}`,
    key: createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64url(seed), x: b64url(pub) }, format: 'jwk' }),
  };
}

const publicKeyBytes = (publicKey) => b58decode(publicKey.replace(/^ed25519:/, ''));

// ---- borsh ---------------------------------------------------------------------

class Writer {
  parts = [];
  u8(v) { this.parts.push(Uint8Array.of(v)); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; }
  u128(v) {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0);
    b.writeBigUInt64LE(BigInt(v) >> 64n, 8);
    this.parts.push(b);
    return this;
  }
  raw(bytes) { this.parts.push(bytes); return this; }
  bytes(bytes) { return this.u32(bytes.length).raw(bytes); }
  string(s) { return this.bytes(Buffer.from(s, 'utf8')); }
  key(publicKey) { return this.u8(0).raw(publicKeyBytes(publicKey)); }
  done() { return Buffer.concat(this.parts); }
}

// ---- actions -------------------------------------------------------------------

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;

export const actions = {
  createAccount: () => ({ kind: 0 }),
  deployContract: (code) => ({ kind: 1, code }),
  functionCall: (method, args = {}, gas = 30n * TGAS, deposit = 0n) => ({
    kind: 2, method, args: Buffer.from(JSON.stringify(args)), gas, deposit,
  }),
  transfer: (deposit) => ({ kind: 3, deposit }),
  addFullAccessKey: (publicKey) => ({ kind: 5, publicKey }),
  addFunctionCallKey: (publicKey, receiverId, methodNames = [], allowance = null) => ({
    kind: 5, publicKey, receiverId, methodNames, allowance,
  }),
  deleteAccount: (beneficiaryId) => ({ kind: 7, beneficiaryId }),
};

function writeAction(w, a) {
  w.u8(a.kind);
  switch (a.kind) {
    case 0: break;
    case 1: w.bytes(a.code); break;
    case 2: w.string(a.method).bytes(a.args).u64(a.gas).u128(a.deposit); break;
    case 3: w.u128(a.deposit); break;
    case 5:
      w.key(a.publicKey).u64(0); // access key nonce
      if (a.receiverId === undefined) {
        w.u8(1); // full access
      } else {
        w.u8(0);
        if (a.allowance === null) w.u8(0); else w.u8(1).u128(a.allowance);
        w.string(a.receiverId).u32(a.methodNames.length);
        for (const m of a.methodNames) w.string(m);
      }
      break;
    case 7: w.string(a.beneficiaryId); break;
    default: throw new Error(`unsupported action ${a.kind}`);
  }
}

/** Encodes and signs a transaction. Returns { base64, hash }. */
export function signTransaction({ signerId, secretKey, nonce, receiverId, blockHash, actionList }) {
  const k = loadKey(secretKey);
  const w = new Writer();
  w.string(signerId).key(k.publicKey).u64(nonce).string(receiverId).raw(b58decode(blockHash)).u32(actionList.length);
  for (const a of actionList) writeAction(w, a);
  const tx = w.done();
  const digest = createHash('sha256').update(tx).digest();
  const signature = ed25519Sign(null, digest, k.key);
  return {
    base64: Buffer.concat([tx, Uint8Array.of(0), signature]).toString('base64'),
    hash: b58encode(digest),
  };
}

// ---- rpc -----------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TESTNET_RPCS = [
  'https://rpc.testnet.fastnear.com',
  'https://near-testnet.drpc.org',
  'https://rpc.testnet.near.org',
];
export const MAINNET_RPCS = ['https://rpc.mainnet.fastnear.com', 'https://near.drpc.org', 'https://rpc.mainnet.near.org'];

export class RpcError extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
  }
}

/** JSON-RPC with pacing and failover. Public endpoints rate-limit per IP. */
export class Rpc {
  constructor(urls = TESTNET_RPCS, { gapMs = 200, log = () => {} } = {}) {
    this.urls = urls;
    this.gapMs = gapMs;
    this.log = log;
    this.current = 0;
    this.queue = Promise.resolve();
    this.calls = 0;
  }

  /** Spaces requests out, in order, so a burst of agents cannot trip a limit. */
  #paced() {
    const turn = this.queue.then(() => sleep(this.gapMs));
    this.queue = turn.catch(() => {});
    return turn;
  }

  async call(method, params) {
    let lastError;
    for (let attempt = 0; attempt < this.urls.length * 3; attempt++) {
      await this.#paced();
      const url = this.urls[this.current % this.urls.length];
      try {
        this.calls++;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.calls, method, params }),
          signal: AbortSignal.timeout(40_000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
        const body = await res.json();
        if (body.error) {
          // Some providers answer 200 with a rate-limit error inside.
          if (body.error.code === -429 || /rate|limit|too many/i.test(body.error.message ?? '')) throw new Error('rate limited');
          // A real answer from the chain ("account does not exist"): do not retry.
          throw new RpcError(body.error.cause?.name ?? body.error.data ?? body.error.message, body.error);
        }
        return body.result;
      } catch (e) {
        if (e instanceof RpcError) throw e;
        lastError = e;
        this.log(`rpc ${new URL(url).host} ${method}: ${e.message}; switching`);
        this.current++;
        await sleep(400 * (attempt + 1));
      }
    }
    throw new Error(`all RPC endpoints failed for ${method}: ${lastError?.message}`);
  }

  async viewAccount(accountId) {
    try {
      return await this.call('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId });
    } catch (e) {
      if (e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/.test(`${e.message} ${JSON.stringify(e.cause)}`)) return null;
      throw e;
    }
  }

  async view(contractId, method, args = {}) {
    const result = await this.call('query', {
      request_type: 'call_function', finality: 'optimistic', account_id: contractId,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    // A view that fails inside the contract comes back as a result with an error in it.
    if (result.error) throw new RpcError(String(result.error), result);
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
  }

  accessKey(accountId, publicKey) {
    return this.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey });
  }

  sendTx(base64, waitUntil = 'EXECUTED_OPTIMISTIC') {
    return this.call('send_tx', { signed_tx_base64: base64, wait_until: waitUntil });
  }
}

// ---- accounts ------------------------------------------------------------------

/** Reads the contract's own error ("E_PHASE: ...") out of a failed outcome. */
export function failureText(failure) {
  const text = JSON.stringify(failure);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/);
  return m ? m[1] : text;
}

export class TxError extends Error {
  constructor(message, hash) {
    super(message);
    this.hash = hash;
    this.code = message.match(/^(E_[A-Z_]+)/)?.[1];
  }
}

export class Account {
  /** lookupDelayMs: the wait between lookups of a transaction whose send timed out. */
  constructor(rpc, accountId, secretKey, { lookupDelayMs = 5000 } = {}) {
    this.rpc = rpc;
    this.accountId = accountId;
    this.secretKey = secretKey;
    this.publicKey = loadKey(secretKey).publicKey;
    this.nonce = null;
    this.lookupDelayMs = lookupDelayMs;
    this.chain = Promise.resolve(); // one transaction at a time per account
  }

  /** A sent transaction's outcome, found by its hash, or null if it never landed. */
  async lookup(hash, tries) {
    for (let i = 0; i < tries; i++) {
      try {
        return await this.rpc.call('tx', { tx_hash: hash, sender_account_id: this.accountId, wait_until: 'EXECUTED_OPTIMISTIC' });
      } catch {
        await sleep(this.lookupDelayMs);
      }
    }
    return null;
  }

  /** Signs and sends. Resolves to { hash, value, gasBurnt, failure }. */
  send(receiverId, actionList, { waitUntil = 'EXECUTED_OPTIMISTIC', allowFailure = false } = {}) {
    const run = async (attempt) => {
      const key = await this.rpc.accessKey(this.accountId, this.publicKey);
      // The chain's nonce is the floor; keep our own count for back-to-back sends.
      this.nonce = Math.max(this.nonce ?? 0, key.nonce) + 1;
      const signed = signTransaction({
        signerId: this.accountId, secretKey: this.secretKey, nonce: this.nonce,
        receiverId, blockHash: key.block_hash, actionList,
      });
      let result;
      try {
        result = await this.rpc.sendTx(signed.base64, waitUntil);
      } catch (e) {
        const text = `${e.message} ${JSON.stringify(e.cause ?? '')}`;
        // A timeout, or a resend that reached a node after the first copy had
        // landed, does not mean the transaction failed: look it up by its hash.
        if (/TIMEOUT|timed out|all RPC endpoints failed/i.test(text)) result = await this.lookup(signed.hash, 8);
        else if (/InvalidNonce/.test(text)) result = await this.lookup(signed.hash, 2);
        if (!result) {
          // A stale nonce from a lagging node: take the chain's and try once more.
          const onChain = text.match(/"ak_nonce":\s*(\d+)/);
          if (onChain && attempt === 0) {
            this.nonce = Number(onChain[1]);
            return run(1);
          }
          this.nonce = null;
          throw new TxError(`${e.message} ${JSON.stringify(e.cause ?? '').slice(0, 300)}`, signed.hash);
        }
      }
      const status = result.status ?? {};
      const gasBurnt = (result.receipts_outcome ?? []).reduce((g, r) => g + BigInt(r.outcome.gas_burnt), BigInt(result.transaction_outcome?.outcome.gas_burnt ?? 0));
      if (status.Failure !== undefined) {
        if (!allowFailure) throw new TxError(failureText(status.Failure), signed.hash);
        return { hash: signed.hash, failure: failureText(status.Failure), gasBurnt };
      }
      let value;
      if (typeof status.SuccessValue === 'string' && status.SuccessValue.length) {
        const text = Buffer.from(status.SuccessValue, 'base64').toString('utf8');
        try { value = JSON.parse(text); } catch { value = text; }
      }
      return { hash: signed.hash, value, gasBurnt };
    };
    const next = this.chain.then(() => run(0), () => run(0));
    this.chain = next.catch(() => {});
    return next;
  }

  call(contractId, method, args = {}, { gas = 30n * TGAS, deposit = 0n, ...rest } = {}) {
    return this.send(contractId, [actions.functionCall(method, args, gas, deposit)], rest);
  }

  /** Creates `newId` (a sub-account of this one), funds it and gives it a key. */
  createSubAccount(newId, publicKey, amount) {
    return this.send(newId, [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(publicKey)]);
  }
}

// ---- amounts -------------------------------------------------------------------

/** "1.25" -> 1250000000000000000000000n */
export function parseNear(text) {
  const [whole, frac = ''] = String(text).split('.');
  return BigInt(whole || '0') * NEAR + BigInt((frac + '0'.repeat(24)).slice(0, 24));
}

/** 1250000000000000000000000n -> "1.25" (rounded down to `digits`). */
export function formatNear(yocto, digits = 4) {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(24 - digits);
  const units = abs / scale;
  const whole = units / 10n ** BigInt(digits);
  const frac = (units % 10n ** BigInt(digits)).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
