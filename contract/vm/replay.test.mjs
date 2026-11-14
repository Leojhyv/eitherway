// Runs the built contract itself (contract/res/eitherway.wasm) through every
// recorded scenario and requires the same answers the rules engine gave.
//
//   node --test contract/vm/replay.test.mjs
//
// The Rust test in contract/core checks the rules. This checks the thing that
// actually gets deployed: argument parsing, storage layout, views, return
// values, error messages and outgoing transfers, all inside the compiled wasm.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractPanic, MiniNear } from './mini-near.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(here, '..', 'res', 'eitherway.wasm'));
const fixture = JSON.parse(readFileSync(join(here, '..', '..', 'engine', 'fixtures', 'scenarios.json'), 'utf8'));

/** Sends one recorded call to the contract. Returns what the contract returned. */
function apply(vm, op) {
  const at = { nowMs: op.t };
  switch (op.op) {
    case 'deposit': return vm.call('deposit', {}, { ...at, predecessor: op.who, deposit: BigInt(op.amount) });
    case 'withdraw': return vm.call('withdraw', { amount: op.amount }, { ...at, predecessor: op.who });
    case 'create':
      return vm.call('create_campaign', {
        title: op.title, goal: op.goal, bonus_bps: op.bonus_bps, max_fee_bps: op.max_fee_bps,
        commit_secs: op.commit_secs, reveal_secs: op.reveal_secs, funding_secs: op.funding_secs,
        beneficiary: op.beneficiary, social_post: op.social_post,
      }, { ...at, predecessor: op.who });
    case 'commit': return vm.call('commit_bid', { campaign_id: op.id, commitment: op.commitment }, { ...at, predecessor: op.who, deposit: BigInt(op.attached) });
    case 'reveal': return vm.call('reveal_bid', { campaign_id: op.id, fee_bps: op.fee_bps, salt: op.salt }, { ...at, predecessor: op.who });
    case 'settle': return vm.call('settle_auction', { campaign_id: op.id }, { ...at, predecessor: 'crank.test' });
    case 'pledge': return vm.call('pledge', { campaign_id: op.id, amount: op.amount }, { ...at, predecessor: op.who, deposit: BigInt(op.attached) });
    case 'finalize': return vm.call('finalize', { campaign_id: op.id, limit: op.limit }, { ...at, predecessor: 'crank.test' });
    default: throw new Error(`unknown op ${op.op}`);
  }
}

test('the built contract answers every recorded call like the rules engine', () => {
  let calls = 0;
  let rejected = 0;
  let withdrawn = 0;
  for (const scenario of fixture.scenarios) {
    const vm = new MiniNear(wasm);
    scenario.ops.forEach((op, i) => {
      const where = `${scenario.name} call ${i} ${JSON.stringify(op).slice(0, 160)}`;
      let result;
      try {
        result = apply(vm, op);
      } catch (e) {
        if (!(e instanceof ContractPanic)) throw e;
        assert.equal(op.ok, false, `the contract rejected (${e.message}) what the engine accepted: ${where}`);
        assert.equal(e.code, op.code, `different error code (${e.message}): ${where}`);
        rejected++;
      }
      if (result) {
        assert.equal(op.ok, true, `the contract accepted what the engine rejected with ${op.code}: ${where}`);
        if (op.op === 'withdraw') {
          // The NEAR leaves the contract, and goes to the caller and nobody else.
          assert.deepEqual(result.transfers, [{ to: op.who, amount: BigInt(op.amount) }], `wrong transfer: ${where}`);
          withdrawn++;
        } else {
          assert.deepEqual(result.transfers, [], `unexpected transfer: ${where}`);
          assert.deepEqual(result.value, op.value, `different return value: ${where}`);
        }
      }
      assert.equal(vm.view('get_totals', {}, op.t).vault, op.vault, `different vault: ${where}`);
      calls++;
    });

    const last = scenario.final;
    assert.equal(vm.view('get_totals', {}, last.t).campaigns, last.campaigns.length, `${scenario.name}: campaign count`);
    for (const [id, expected] of Object.entries(last.accounts)) {
      assert.deepEqual(vm.view('get_account', { account_id: id }, last.t), expected, `${scenario.name}: account ${id}`);
    }
    last.campaigns.forEach((expected, id) => {
      assert.deepEqual(vm.view('get_campaign', { campaign_id: id }, last.t), expected, `${scenario.name}: campaign ${id}`);
      assert.deepEqual(vm.view('get_bids', { campaign_id: id }, last.t), last.bids[id], `${scenario.name}: bids of campaign ${id}`);
      assert.deepEqual(vm.view('get_pledges', { campaign_id: id, from_index: 0, limit: 200 }, last.t), last.pledges[id], `${scenario.name}: pledges of campaign ${id}`);
    });
    assert.equal(vm.view('get_campaign', { campaign_id: last.campaigns.length }, last.t), null);
    assert.deepEqual(vm.view('get_campaigns', { from_index: 0, limit: 100 }, last.t), last.campaigns.slice(0, 100), `${scenario.name}: campaign list`);
  }
  console.log(`replayed ${calls} calls (${rejected} rejected, ${withdrawn} withdrawals) through the wasm across ${fixture.scenarios.length} scenarios`);
  assert.ok(calls > 2000 && rejected > 1000);
});

test('a rejected call changes nothing, and attached NEAR is not kept', () => {
  const vm = new MiniNear(wasm);
  vm.call('deposit', {}, { predecessor: 'alice.test', deposit: 5n * 10n ** 24n });
  const before = new Map(vm.storage);
  assert.throws(() => vm.call('pledge', { campaign_id: 0, amount: '1000000000000000000000000' }, { predecessor: 'alice.test', deposit: 10n ** 24n }),
    (e) => e instanceof ContractPanic && e.code === 'E_NO_CAMPAIGN');
  assert.deepEqual([...vm.storage.keys()].sort(), [...before.keys()].sort());
  assert.equal(vm.view('get_totals').vault, (5n * 10n ** 24n).toString());
});

test('methods that take no NEAR refuse it, and views cannot write', () => {
  const vm = new MiniNear(wasm);
  assert.throws(() => vm.call('settle_auction', { campaign_id: 0 }, { predecessor: 'alice.test', deposit: 1n }), ContractPanic);
  assert.throws(() => vm.call('deposit', {}, { predecessor: 'alice.test', deposit: 1n, view: true }), ContractPanic);
  assert.deepEqual(vm.view('get_rules').max_bids, 16);
});

test('every state change is logged as an event', () => {
  const vm = new MiniNear(wasm);
  const { logs } = vm.call('deposit', {}, { predecessor: 'alice.test', deposit: 7n });
  assert.equal(logs.length, 1);
  const event = JSON.parse(logs[0].replace(/^EVENT_JSON:/, ''));
  assert.deepEqual(event, { standard: 'eitherway', version: '1.0.0', event: 'deposit', data: [{ account: 'alice.test', amount: '7' }] });
});
