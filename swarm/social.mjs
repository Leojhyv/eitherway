// near.social for agents.
//
// near.social stores every post, reply and like as a NEAR transaction: a
// function call named __fastdata_kv on the account `social`, with the data in
// the arguments. Nothing runs there (the call "fails" by design); an indexer
// reads the arguments. See https://near.social/skill.md.
//
// That makes it a public, signed message bus that costs almost nothing, which
// is what a swarm needs to find each other:
//
//   - an organizer announces a campaign as a post
//   - backer agents "like" it to say their user is interested
//   - underwriter agents read that interest before they price the guarantee
//   - the guarantor and the outcome are posted as replies in the same thread
//
// KvSocial speaks the real format through FastData. On mainnet the posts
// appear on near.social itself. On testnet the same writes are indexed by
// FastData's testnet endpoint, so the whole loop runs without real money and
// without putting test chatter in front of real people.
// LocalSocial keeps the same records in memory for local runs.

import { actions } from './near.mjs';

const KEYS_PER_CALL = 256;

export const SOCIAL_NETWORKS = {
  testnet: { receiver: 'social', kv: 'https://kv.test.fastnear.com', web: null },
  mainnet: { receiver: 'social', kv: 'https://kv.main.fastnear.com', web: 'https://near.social', api: 'https://api2.near.social' },
};

/** The arguments for one write, following the near.social standard. */
export const socialArgs = {
  post: (id, text) => ({ [`post/${id}`]: { text } }),
  reply: (id, text, parentRef, rootRef) => ({
    [`post/${id}`]: { text, reply_to: parentRef, root: rootRef ?? parentRef },
    [`reply/${parentRef}/${id}`]: {},
  }),
  like: (ref) => ({ [`like/${ref}`]: {} }),
  profile: ({ name, about, website }) => ({
    'profile/name': name,
    'profile/about': about,
    ...(website ? { 'profile/links/website': website } : {}),
  }),
};

export class KvSocial {
  /** accounts: Map of accountId -> Account (from swarm/near.mjs). */
  constructor({ network = 'testnet', accounts, log = () => {} }) {
    this.kind = network;
    this.net = SOCIAL_NETWORKS[network];
    this.accounts = accounts;
    this.log = log;
    this.lastId = 0;
  }

  /** Post ids are Unix milliseconds and must be unique per author. */
  nextId() {
    this.lastId = Math.max(this.lastId + 1, Date.now());
    return String(this.lastId);
  }

  async #write(who, args) {
    if (Object.keys(args).length > KEYS_PER_CALL) throw new Error('too many keys in one call');
    const account = this.accounts.get(who);
    if (!account) throw new Error(`no key loaded for ${who}`);
    // The receipt fails by design (no contract on `social`); the data is still indexed.
    const r = await account.send(this.net.receiver, [actions.functionCall('__fastdata_kv', args, 1_000_000_000n, 0n)], { allowFailure: true });
    return r.hash;
  }

  async post(who, text, id = this.nextId()) {
    const hash = await this.#write(who, socialArgs.post(id, text));
    return { ref: `${who}/${id}`, hash };
  }
  async reply(who, text, parentRef, rootRef) {
    const id = this.nextId();
    const hash = await this.#write(who, socialArgs.reply(id, text, parentRef, rootRef));
    return { ref: `${who}/${id}`, hash };
  }
  async like(who, ref) {
    return { hash: await this.#write(who, socialArgs.like(ref)) };
  }
  async setProfile(who, profile) {
    return { hash: await this.#write(who, socialArgs.profile(profile)) };
  }

  async #query(path, body) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 5; page++) {
      const res = await fetch(`${this.net.kv}/v0/latest/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, limit: 200, ...(pageToken ? { page_token: pageToken } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`fastdata ${res.status}`);
      const data = await res.json();
      out.push(...(data.entries ?? []));
      pageToken = data.page_token;
      if (!pageToken || (data.entries ?? []).length === 0) break;
    }
    return out;
  }

  /** One post, or null if it is not indexed yet. */
  async getPost(ref) {
    const [author, id] = splitRef(ref);
    const entries = await this.#query(`${this.net.receiver}/${author}`, { key: `post/${id}` });
    const e = entries.find((x) => x.value && typeof x.value === 'object');
    return e ? { ref, author, id, text: e.value.text ?? '', at: Number(BigInt(e.block_timestamp) / 1000000n) } : null;
  }

  /** Accounts that liked a post. */
  async likers(ref) {
    const entries = await this.#query(this.net.receiver, { key: `like/${ref}` });
    return [...new Set(entries.filter((e) => e.value !== null).map((e) => e.predecessor_id))];
  }

  /** Replies to a post, oldest first. */
  async replies(ref) {
    const marks = await this.#query(this.net.receiver, { key_prefix: `reply/${ref}/` });
    const out = [];
    for (const mark of marks) {
      if (mark.value === null) continue;
      const id = mark.key.split('/').pop();
      const post = await this.getPost(`${mark.predecessor_id}/${id}`);
      if (post) out.push(post);
    }
    return out.sort((a, b) => Number(a.id) - Number(b.id));
  }
}

export class LocalSocial {
  constructor() {
    this.kind = 'local';
    this.posts = new Map();   // ref -> { ref, author, id, text, at, replyTo }
    this.likes = new Map();   // ref -> Set of accounts
    this.profiles = new Map();
    this.lastId = 0;
    this.count = 0;
  }
  nextId() {
    this.lastId = Math.max(this.lastId + 1, Date.now());
    return String(this.lastId);
  }
  async post(who, text, id = this.nextId()) {
    const ref = `${who}/${id}`;
    this.posts.set(ref, { ref, author: who, id, text, at: Date.now(), replyTo: null });
    return { ref, hash: `local-social-${++this.count}` };
  }
  async reply(who, text, parentRef) {
    const id = this.nextId();
    const ref = `${who}/${id}`;
    this.posts.set(ref, { ref, author: who, id, text, at: Date.now(), replyTo: parentRef });
    return { ref, hash: `local-social-${++this.count}` };
  }
  async like(who, ref) {
    if (!this.likes.has(ref)) this.likes.set(ref, new Set());
    this.likes.get(ref).add(who);
    return { hash: `local-social-${++this.count}` };
  }
  async setProfile(who, profile) {
    this.profiles.set(who, profile);
    return { hash: `local-social-${++this.count}` };
  }
  async getPost(ref) {
    return this.posts.get(ref) ?? null;
  }
  async likers(ref) {
    return [...(this.likes.get(ref) ?? [])];
  }
  async replies(ref) {
    return [...this.posts.values()].filter((p) => p.replyTo === ref).sort((a, b) => Number(a.id) - Number(b.id));
  }
}

export function splitRef(ref) {
  const i = ref.lastIndexOf('/');
  return [ref.slice(0, i), ref.slice(i + 1)];
}

// ---- reading the real near.social (mainnet indexer, no key needed) -----------------

const API = 'https://api2.near.social';

async function api(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`near.social ${res.status} for ${path}`);
  return res.json();
}

/** Posts carrying a hashtag, newest first. */
export const hashtagPosts = (tag, limit = 20) => api(`/v1/hashtags/${encodeURIComponent(tag)}?limit=${limit}`);

/** A profile with follower and post counts: what an underwriter checks about an organizer. */
export const profile = (accountId) => api(`/v1/accounts/${encodeURIComponent(accountId)}`);

export const searchPosts = (q, limit = 20) => api(`/v1/search/posts?q=${encodeURIComponent(q)}&limit=${limit}`);
