// Tests for the parts around the rules: the NEAR client, the simulation, the
// local chain and the near.social record format. Run: node --test swarm/test/swarm.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { Account, RpcError, actions, b58decode, b58encode, formatNear, newKeyPair, parseNear, signTransaction, TxError, NEAR, TGAS } from '../near.mjs';
import { GAS, LocalChain, gasReserve } from '../chain.mjs';
import { LocalSocial, socialArgs, splitRef } from '../social.mjs';
import { compare, runSimulation } from '../sim.mjs';
import { Backer, Underwriter } from '../agents.mjs';
import { commitment } from '../../engine/market.mjs';
import { mulberry32 } from '../../engine/rng.mjs';

test('base58 round-trips, including leading zeros', () => {
  for (const hex of ['00', '0000ff', 'deadbeef', '00'.repeat(32), 'ff'.repeat(64), '01020304050607']) {
    const bytes = Buffer.from(hex, 'hex');
    assert.equal(Buffer.from(b58decode(b58encode(bytes))).toString('hex'), hex);
  }
  assert.equal(b58encode(Buffer.from('hello world')), 'StV1DL6CwTryKyV');
});

test('a signed transaction verifies against its public key', () => {
  const key = newKeyPair();
  const signed = signTransaction({
    signerId: 'backer-01.eitherway.testnet', secretKey: key.secretKey, nonce: 7,
    receiverId: 'escrow.eitherway.testnet', blockHash: b58encode(Buffer.alloc(32, 9)),
    actionList: [actions.functionCall('pledge', { campaign_id: 0, amount: '5' }, 30_000_000_000_000n, NEAR)],
  });
  const raw = Buffer.from(signed.base64, 'base64');
  const tx = raw.subarray(0, raw.length - 65);
  const signature = raw.subarray(raw.length - 64);
  assert.equal(raw[raw.length - 65], 0, 'signature type byte is ed25519');
  assert.equal(signed.hash, b58encode(createHash('sha256').update(tx).digest()));
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(b58decode(key.publicKey.slice(8))).toString('base64url') }, format: 'jwk' });
  assert.ok(verify(null, createHash('sha256').update(tx).digest(), pub, signature));
  // Layout: signer id, key, nonce, receiver id, block hash, actions.
  assert.equal(tx.readUInt32LE(0), 'backer-01.eitherway.testnet'.length);
  assert.ok(tx.includes(Buffer.from('{"campaign_id":0,"amount":"5"}')));
});

test('NEAR amounts parse and print exactly', () => {
  assert.equal(parseNear('1.25'), 1250000000000000000000000n);
  assert.equal(parseNear('0.000000000000000000000001'), 1n);
  assert.equal(formatNear(1250000000000000000000000n), '1.25');
  assert.equal(formatNear(999999999999999999999n, 4), '0.0009');
  assert.equal(formatNear(-5n * NEAR), '-5');
});

test('simulation: the same seed gives the same run, and both regimes face the same campaigns', () => {
  const a = compare(11, { rounds: 10 });
  const b = compare(11, { rounds: 10 });
  assert.deepEqual(a, b);
  a.plain.rounds.forEach((p, i) => {
    const e = a.eitherway.rounds[i];
    assert.equal(p.title, e.title);
    assert.equal(p.goal, e.goal);
    assert.equal(p.demandRatio, e.demandRatio);
    assert.equal(p.underwriter, null, 'ordinary crowdfunding has no guarantor');
    assert.equal(p.bonusPaid, 0);
  });
});

test('simulation: backers of a guaranteed failure are paid, and only then', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const run = runSimulation(seed, { rounds: 20 });
    for (const r of run.rounds) {
      if (r.status === 'Funded') assert.equal(r.bonusPaid, 0);
      if (r.status === 'Failed' && !r.underwriter) assert.equal(r.bonusPaid, 0);
      if (r.status === 'Failed' && r.underwriter) {
        const earliest = Math.min(...r.pledges.map((p) => p.at), 1);
        if (r.pledges.length && earliest < 0.99) assert.ok(r.bonusPaid > 0, 'early pledges to a guaranteed failure earn a bonus');
        assert.ok(r.bonusPaid <= r.bond + 1e-9, 'I3: never more than the bond');
      }
    }
    const paid = run.rounds.reduce((s, r) => s + r.bonusPaid, 0);
    const lost = run.summary.underwriters.reduce((s, u) => s + u.bonuses, 0);
    // Each figure is rounded down to a millionth of a NEAR for display, so allow that much per campaign.
    assert.ok(Math.abs(paid - lost) < run.rounds.length * 1e-6, 'every bonus a backer received was paid by an underwriter');
  }
});

test('agents: an underwriter bids its break-even fee plus margin, and passes on poor odds', () => {
  const u = new Underwriter({ id: 'uw-x', style: 'sharp', rnd: mulberry32(1) });
  const c = { id: 0, phase: 'Commit', bonus_bps: 500, max_fee_bps: 700, bond: '100', hint: 2, organizer_record: { org_created: 1, org_funded: 0, org_failed: 0 } };
  const [bid] = u.decide({ now: 0, me: { id: 'uw-x', balance: 1000n }, campaigns: [c] });
  assert.equal(bid.type, 'commit');
  assert.equal(bid.commitment, commitment(0, 'uw-x', bid.note.feeBps, u.sealed.get(0).salt));
  assert.ok(bid.note.odds > 0.9 && bid.note.feeBps < 100);
  const poor = new Underwriter({ id: 'uw-y', style: 'sharp', rnd: mulberry32(1) });
  assert.deepEqual(poor.decide({ now: 0, me: { id: 'uw-y', balance: 1000n }, campaigns: [{ ...c, hint: 0.7 }] }), []);
  const broke = new Underwriter({ id: 'uw-z', style: 'sharp', rnd: mulberry32(1) });
  assert.deepEqual(broke.decide({ now: 0, me: { id: 'uw-z', balance: 99n }, campaigns: [c] }), []);
});

test('agents: a follower waits for others unless the bonus covers its wait', () => {
  const mk = () => new Backer({ id: 'b', kind: 'follower', cap: 10n * NEAR, interests: { art: 1 }, lockCostBps: 300, joinAt: 0.5, rnd: () => 0.5 });
  const c = { id: 0, phase: 'Funding', topic: 'art', goal: (100n * NEAR).toString(), raised: '0', bonus_bps: 500, clearing_fee_bps: 100, reveal_end: 0, deadline: 1000 };
  const view = (extra, now = 0) => ({ now, minPledge: NEAR / 1000n, me: { id: 'b', balance: 10n * NEAR }, campaigns: [{ ...c, ...extra }] });
  assert.equal(mk().decide(view({ guaranteed: false })).length, 0, 'no guarantor, nobody else in: it waits');
  assert.equal(mk().decide(view({ guaranteed: true })).length, 1, 'guaranteed at 5% against a 3% cost of waiting: it goes first');
  assert.equal(mk().decide(view({ guaranteed: true }, 600)).length, 0, 'late in the window the bonus on offer no longer covers it');
  assert.equal(mk().decide(view({ guaranteed: false, raised: (60n * NEAR).toString() })).length, 1, 'enough others are in: it joins');
});

test('local chain: same calls and error codes as the contract', async () => {
  const chain = new LocalChain();
  chain.fund('org', NEAR); chain.fund('uw', 10n * NEAR); chain.fund('bk', 10n * NEAR);
  const { value: id } = await chain.call('org', 'create_campaign', { title: 't', goal: (10n * NEAR).toString(), bonus_bps: 500, max_fee_bps: 600, commit_secs: 10, reveal_secs: 10, funding_secs: 10 });
  assert.equal(id, 0);
  await chain.call('uw', 'commit_bid', { campaign_id: 0, commitment: commitment(0, 'uw', 100, 's') }, { deposit: NEAR / 2n });
  assert.equal((await chain.view('get_bids', { campaign_id: 0 })).length, 1);
  await assert.rejects(chain.call('bk', 'pledge', { campaign_id: 0, amount: NEAR.toString() }, { deposit: NEAR }), (e) => e instanceof TxError && e.code === 'E_PHASE');
  await assert.rejects(chain.call('bk', 'deposit', {}, { deposit: 11n * NEAR }), (e) => e.code === 'E_WALLET');
  assert.equal((await chain.view('get_campaign', { campaign_id: 0 })).phase, 'Commit');
  assert.equal(await chain.view('get_campaign', { campaign_id: 5 }), null);
  assert.deepEqual(await chain.view('get_totals'), { vault: (NEAR / 2n).toString(), campaigns: 1 });
});

test('near.social records follow the standard', async () => {
  assert.deepEqual(socialArgs.post('1759140000000', 'gm #near'), { 'post/1759140000000': { text: 'gm #near' } });
  assert.deepEqual(socialArgs.reply('1759140000500', 'Agreed!', 'alice.near/1759140000000'), {
    'post/1759140000500': { text: 'Agreed!', reply_to: 'alice.near/1759140000000', root: 'alice.near/1759140000000' },
    'reply/alice.near/1759140000000/1759140000500': {},
  });
  assert.deepEqual(socialArgs.like('alice.near/1759140000000'), { 'like/alice.near/1759140000000': {} });
  assert.deepEqual(splitRef('backer-01.eitherway.testnet/1794000000000'), ['backer-01.eitherway.testnet', '1794000000000']);

  const s = new LocalSocial();
  const { ref } = await s.post('org', 'hello');
  await s.like('a', ref); await s.like('b', ref); await s.like('a', ref);
  await s.reply('uw', 'I guarantee this', ref);
  assert.deepEqual((await s.likers(ref)).sort(), ['a', 'b']);
  assert.equal((await s.replies(ref))[0].text, 'I guarantee this');
  const first = s.nextId();
  assert.ok(Number(s.nextId()) > Number(first), 'post ids only go up');
});

// ---- sending on a busy network ----------------------------------------------------------

const outcome = (value) => ({
  status: { SuccessValue: value === undefined ? '' : Buffer.from(JSON.stringify(value)).toString('base64') },
  transaction_outcome: { outcome: { gas_burnt: 1 } },
  receipts_outcome: [],
});
const fakeRpc = (over) => ({
  accessKey: async () => ({ nonce: 10, block_hash: b58encode(Buffer.alloc(32, 1)) }),
  sendTx: async () => outcome(),
  call: async () => { throw new RpcError('UNKNOWN_TRANSACTION', {}); },
  ...over,
});

test('a send that times out is looked up by its hash instead of failing', async () => {
  const lookups = [];
  const rpc = fakeRpc({
    sendTx: async () => { throw new RpcError('TIMEOUT_ERROR', { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } }); },
    call: async (method, params) => { lookups.push([method, params]); return outcome('7'); },
  });
  const a = new Account(rpc, 'alice.testnet', newKeyPair().secretKey, { lookupDelayMs: 1 });
  const r = await a.call('escrow.testnet', 'pledge', {});
  assert.equal(r.value, '7');
  assert.equal(lookups[0][0], 'tx');
  assert.equal(lookups[0][1].sender_account_id, 'alice.testnet');
  assert.equal(lookups[0][1].tx_hash, r.hash);
});

test('a stale nonce is retried once with the nonce the chain reports', async () => {
  let sends = 0;
  const rpc = fakeRpc({
    sendTx: async () => {
      sends++;
      if (sends === 1) throw new RpcError('INVALID_TRANSACTION', { data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 11, ak_nonce: 15 } } } } });
      return outcome();
    },
  });
  const a = new Account(rpc, 'bob.testnet', newKeyPair().secretKey, { lookupDelayMs: 1 });
  await a.call('escrow.testnet', 'deposit', {});
  assert.equal(sends, 2);
  assert.equal(a.nonce, 16);
});

test('a real rejection is reported at once, and the next send still works', async () => {
  let sends = 0;
  const rpc = fakeRpc({
    sendTx: async () => {
      sends++;
      if (sends === 1) throw new RpcError('INVALID_TRANSACTION', { data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: {} } } } });
      return outcome(3);
    },
  });
  const a = new Account(rpc, 'carol.testnet', newKeyPair().secretKey, { lookupDelayMs: 1 });
  await assert.rejects(a.call('escrow.testnet', 'deposit', {}), (e) => e instanceof TxError && /NotEnoughBalance/.test(e.message));
  assert.equal(sends, 1);
  assert.equal((await a.call('escrow.testnet', 'get', {})).value, 3);
});

test('local chain: wallets are topped up, and deposits spend them', async () => {
  const chain = new LocalChain();
  chain.fund('b', 3n * NEAR);
  assert.equal(await chain.walletBalance('b'), 3n * NEAR);
  await chain.topUp('b', 2n * NEAR);
  assert.equal(await chain.walletBalance('b'), 5n * NEAR);
  assert.equal(chain.toppedUp, 2n * NEAR);
  await chain.call('b', 'deposit', {}, { deposit: 4n * NEAR });
  assert.equal(await chain.walletBalance('b'), NEAR, 'the gas held back comes back once the call has run');
});

test('local chain: like NEAR, a wallet must also cover the gas held back while a call runs', async () => {
  // Measured on testnet: a call with G Tgas attached needs about 0.001 NEAR per Tgas, plus 0.000919 NEAR.
  assert.ok(gasReserve(60n * TGAS) >= parseNear('0.060919'));
  assert.ok(gasReserve(10n * TGAS) >= parseNear('0.010919'));
  const chain = new LocalChain();
  chain.fund('uw', parseNear('0.40'));
  // An underwriter putting in its whole wallet: rejected the way NEAR rejects it, with the cost spelled out.
  await assert.rejects(chain.call('uw', 'deposit', {}, { deposit: parseNear('0.40') }), (e) => e.code === 'E_WALLET' && /"NotEnoughBalance":\{"balance":"\d+","cost":"\d+"/.test(e.message));
  await assert.rejects(chain.call('uw', 'deposit', {}, { deposit: parseNear('0.36'), gas: 60n * TGAS }), (e) => e.code === 'E_WALLET', 'too much gas attached');
  await chain.call('uw', 'deposit', {}, { deposit: parseNear('0.36') }); // the gas a deposit gets by default fits
  assert.equal(await chain.walletBalance('uw'), parseNear('0.04'));
  assert.ok(GAS.deposit <= 10 && GAS.pledge <= 20, 'calls an agent makes often stay cheap to hold back for');
});
