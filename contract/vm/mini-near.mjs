// A very small stand-in for the NEAR runtime, enough to run the built contract
// (contract/res/eitherway.wasm) on any machine with Node.
//
// It provides the host functions the contract actually calls: input, registers,
// storage, caller, attached deposit, block time, sha256, logs, panics, return
// values and outgoing transfers. Like the chain, it runs every call in a fresh
// instance and keeps storage changes only if the call succeeds.
//
// What it does not do: meter gas, charge for storage, or check signatures. It
// answers one question: does the compiled contract behave like the rules?

import { createHash } from 'node:crypto';

const U64_MAX = 0xffffffffffffffffn;

export class ContractPanic extends Error {
  constructor(message, logs) {
    super(message);
    this.logs = logs;
    this.code = message.match(/^(E_[A-Z_]+)/)?.[1];
  }
}

export class MiniNear {
  constructor(wasmBytes, contractId = 'escrow.test') {
    this.module = new WebAssembly.Module(wasmBytes);
    this.contractId = contractId;
    this.storage = new Map(); // hex key -> Uint8Array
    this.calls = 0;
  }

  /**
   * Runs one method. Returns { value, logs, transfers }.
   * Throws ContractPanic if the contract aborts; storage is then left untouched.
   * `view: true` forbids what the chain forbids in a view call.
   */
  call(method, args = {}, { predecessor = 'someone.test', deposit = 0n, nowMs = 0, view = false } = {}) {
    this.calls++;
    const registers = new Map();
    const pending = new Map(); // writes made by this call
    const logs = [];
    const transfers = [];
    const promises = [];
    let returned;
    let memory;

    const bytes = (ptr, len) => new Uint8Array(memory.buffer, Number(ptr), Number(len)).slice();
    const text = (len, ptr) => {
      if (len === U64_MAX) {
        const all = new Uint8Array(memory.buffer, Number(ptr));
        return Buffer.from(all.subarray(0, all.indexOf(0))).toString('utf8');
      }
      return Buffer.from(bytes(ptr, len)).toString('utf8');
    };
    const u128At = (ptr) => {
      const b = bytes(ptr, 16n);
      let v = 0n;
      for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
      return v;
    };
    const hex = (key) => Buffer.from(key).toString('hex');
    const stored = (k) => (pending.has(k) ? pending.get(k) : this.storage.get(k));
    const notInView = (name) => { if (view) throw new ContractPanic(`${name} is not allowed in a view call`, logs); };
    const unsupported = (name) => () => { throw new Error(`the contract called ${name}, which this runner does not provide`); };

    const env = {
      input: (register) => { registers.set(register, Buffer.from(JSON.stringify(args))); },
      register_len: (register) => (registers.has(register) ? BigInt(registers.get(register).length) : U64_MAX),
      read_register: (register, ptr) => { new Uint8Array(memory.buffer).set(registers.get(register), Number(ptr)); },
      value_return: (len, ptr) => { returned = bytes(ptr, len); },
      log_utf8: (len, ptr) => { logs.push(text(len, ptr)); },
      panic_utf8: (len, ptr) => { throw new ContractPanic(text(len, ptr), logs); },
      block_timestamp: () => BigInt(nowMs) * 1000000n,
      predecessor_account_id: (register) => { notInView('predecessor_account_id'); registers.set(register, Buffer.from(predecessor)); },
      attached_deposit: (ptr) => {
        notInView('attached_deposit');
        const out = new Uint8Array(memory.buffer, Number(ptr), 16);
        let v = BigInt(deposit);
        for (let i = 0; i < 16; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
      },
      sha256: (len, ptr, register) => { registers.set(register, createHash('sha256').update(bytes(ptr, len)).digest()); },
      storage_read: (keyLen, keyPtr, register) => {
        const value = stored(hex(bytes(keyPtr, keyLen)));
        if (value === undefined) return 0n;
        registers.set(register, value);
        return 1n;
      },
      storage_write: (keyLen, keyPtr, valueLen, valuePtr, register) => {
        notInView('storage_write');
        const k = hex(bytes(keyPtr, keyLen));
        const old = stored(k);
        pending.set(k, bytes(valuePtr, valueLen));
        if (old === undefined) return 0n;
        registers.set(register, old);
        return 1n;
      },
      promise_batch_create: (len, ptr) => { notInView('promise_batch_create'); promises.push({ to: text(len, ptr), actions: [] }); return BigInt(promises.length - 1); },
      promise_batch_action_transfer: (index, amountPtr) => { transfers.push({ to: promises[Number(index)].to, amount: u128At(amountPtr) }); },
      promise_return: () => {},
    };
    // Imported by near-sdk for promise kinds this contract never creates.
    for (const imp of WebAssembly.Module.imports(this.module)) {
      if (imp.module === 'env' && !(imp.name in env)) env[imp.name] = unsupported(imp.name);
    }

    const instance = new WebAssembly.Instance(this.module, { env });
    memory = instance.exports.memory;
    if (typeof instance.exports[method] !== 'function') throw new Error(`the contract has no method ${method}`);
    try {
      instance.exports[method]();
    } catch (e) {
      if (e instanceof ContractPanic) throw e;
      if (e instanceof WebAssembly.RuntimeError) throw new ContractPanic(`trap: ${e.message}`, logs);
      throw e;
    }
    for (const [k, v] of pending) this.storage.set(k, v);
    const value = returned && returned.length ? JSON.parse(Buffer.from(returned).toString('utf8')) : undefined;
    return { value, logs, transfers };
  }

  view(method, args = {}, nowMs = 0) {
    return this.call(method, args, { nowMs, view: true }).value;
  }
}
