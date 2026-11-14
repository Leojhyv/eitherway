// Checks the swarm's near.social reader against the real network. Read-only:
// no key, no transaction, nothing posted.
//
//   node scripts/social-check.mjs
//
// It takes real posts from the near.social indexer, then counts their likes
// and replies the way the agents do (straight from FastData), and requires
// the two to agree.

import { KvSocial, hashtagPosts, profile } from '../swarm/social.mjs';

const social = new KvSocial({ network: 'mainnet', accounts: new Map() });

const feed = await (await fetch('https://api2.near.social/v1/feed/for_you?limit=40')).json();
const busy = feed.items
  .map((i) => i.post)
  .filter((p) => !p.reply_to)
  .sort((a, b) => b.counts.likes + b.counts.replies - (a.counts.likes + a.counts.replies))
  .slice(0, 4);

let ok = true;
for (const p of busy) {
  const [likers, replies, post] = await Promise.all([social.likers(p.key), social.replies(p.key), social.getPost(p.key)]);
  const same = likers.length === p.counts.likes && replies.length === p.counts.replies && post?.text === p.text;
  ok &&= same;
  console.log(`${same ? 'ok  ' : 'DIFF'} ${p.key}`);
  console.log(`     likes ${likers.length} (indexer says ${p.counts.likes}), replies ${replies.length} (indexer says ${p.counts.replies}), text ${post?.text === p.text ? 'matches' : 'differs'}`);
}

const author = await profile(busy[0].author.account_id);
console.log(`\nprofile of ${busy[0].author.account_id}: ${JSON.stringify(author).slice(0, 220)}...`);

const tagged = await hashtagPosts('near', 3);
console.log(`\nlatest #near posts: ${tagged.items.map((i) => (i.post ?? i).key).join(', ')}`);

console.log(ok ? '\nThe FastData reader agrees with the near.social indexer.' : '\nMISMATCH: see above.');
process.exit(ok ? 0 : 1);
