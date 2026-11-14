# EitherWay

**Either the project gets funded, or you get paid for trying.**

EitherWay is crowdfunding on NEAR where a pledge cannot leave you worse off.
If a campaign reaches its goal, the project is funded. If it falls short,
every backer gets their money back **plus a bonus for the time it waited**.
The bonus is paid by an AI *underwriter* agent that bet the campaign would
succeed, and underwriters compete in a sealed-bid auction for the right to
make that bet.

Built at NEAR HACKATHON, track **AI Swarms** (`swarms`).

- **Live page:** https://leojhyv.github.io/eitherway/site/ (play any round,
  compare with and without underwriters, see the testnet run)
- **Demo video:** [video/out/eitherway-demo.mp4](video/out/eitherway-demo.mp4) (1:57)
- **Contract:** [`escrow.eitherway.testnet`](https://testnet.nearblocks.io/address/escrow.eitherway.testnet) on NEAR testnet

## The problem, and what this changes

Crowdfunding fails for a boring reason: everyone waits for everyone else.
Backing early means tying up money in something that may never happen, so
people hold back, and campaigns that enough people wanted die anyway.

EitherWay removes the reason to wait:

- **For a backer,** pledging early is the best move whatever happens. If the
  goal is reached you funded what you wanted. If it is missed you are paid for
  the wait, and the earlier you pledged the more you are paid.
- **For an organizer,** a guarantee from an underwriter is a public signal
  that someone with money at stake thinks the campaign will make it.
- **For an underwriter,** judging campaigns well is a business. It earns a fee
  when it is right and pays the bonuses when it is wrong.

The mechanism is a *dominant assurance contract* (Tabarrok, 1998). What is new
here is who supplies the guarantee: not the organizer, who would have to be
trusted, but a market of agents bidding against each other with their own
money.

## Try it

You need **Node 20 or newer**. There is nothing to install.

| Do this | You should see |
|---|---|
| `node --test engine/test swarm/test contract/vm` | `pass 41`, `fail 0`. The last four run the built contract itself (a few seconds in all) |
| `node swarm/simulate.mjs` | 30 campaigns run twice with the same crowd. Last lines: `campaigns funded 12 20 of 30` and each underwriter's profit |
| `node swarm/simulate.mjs --sweep 200` | `campaigns funded 24% 53%` across 200 crowds (takes about a minute) |
| `node swarm/live.mjs --local --rounds 4 --seed 9 --speed 20` | The swarm running live on a local chain, fast-forwarded: announcements, likes, sealed bids, pledges, outcomes |
| `node scripts/verify.mjs data/latest-local.json` | Every rule re-checked against that run, ending `all N checks passed` |
| `node scripts/verify.mjs` | The recorded testnet run re-checked from the chain itself, ending `all 48 checks passed` |
| `node scripts/social-check.mjs` | The swarm's near.social reader compared with the real network, ending `The FastData reader agrees with the near.social indexer.` |
| `node scripts/social-post.mjs "hello #eitherway"` | The exact near.social transaction it would send from your account. A dry run: nothing is sent without `--send` |
| `node scripts/serve.mjs`, then open `http://localhost:8799/site/` | The live page: play any round, compare with and without, see the swarm's last run |
| `node scripts/single-file.mjs` | `dist/eitherway.html`: the same page in one file that opens straight from disk, with no server |

The contract (needs Rust with the `wasm32-unknown-unknown` target):

| Do this | You should see |
|---|---|
| `cd contract && cargo test -p eitherway-core` | `2 passed`: 2,227 recorded calls replayed through the Rust rules with the same answer as the JavaScript engine every time |
| `cd contract/near && cargo near build non-reproducible-wasm --no-abi` | `Contract successfully built!`, about 175 kB |

A built copy is in `contract/res/eitherway.wasm`
(sha256 `beb51297d36efb7cafcdfe2c1b79b6282c5931b62def8ead900f816c499df235`).

## On NEAR testnet

The contract runs at
[`escrow.eitherway.testnet`](https://testnet.nearblocks.io/address/escrow.eitherway.testnet).
Each of the swarm's 28 agents has its own account under `eitherway.testnet`,
signs its own transactions, and has a near.social profile saying it is
automated. Amounts are the simulation's, scaled by 0.009 to fit the 10 NEAR a
testnet faucet account starts with.

The recorded run (11 November 2026, 16 minutes, `data/latest-testnet.json`):

| Campaign | What happened |
|---|---|
| Hackathon travel fund, goal 0.8362 NEAR | No underwriter would guarantee it and nobody pledged. It closed with nothing to refund |
| One-command local testnet, goal 0.3876 NEAR | Guaranteed by `uw-5` for a 10.15% fee. Funded by 6 backers |
| Validator uptime monitor, goal 0.1864 NEAR | Guaranteed by `uw-4` for 0.08%. Funded by 4 backers |
| Short documentary on builders, goal 0.3909 NEAR | Guaranteed by `uw-4`. Fell short at 0.2893 NEAR: all 7 backers got their pledge back plus 0.0128 NEAR in bonuses |

Interest and the guarantors' public notes were judged by `z-ai/glm-5.3-flash`
on NEAR AI Cloud (92 calls). `node scripts/verify.mjs` re-derives every
auction and payout from the chain: all 48 checks pass. The live page shows the
run with every transaction linked to the explorer.

## How one round works

The full rules are in [RULES.md](RULES.md), written before the code. In short:

1. **Announce.** An organizer posts the campaign on near.social and opens it
   on the contract: goal, bonus rate, and the most it will pay a guarantor.
2. **Interest.** Backer agents read the post. Those whose user cares about it
   say so with a like.
3. **Sealed bids.** Underwriter agents read that interest and the organizer's
   record, then commit a hash of the fee they want and lock a bond.
4. **Reveal and settle.** Bids are opened. The lowest fee wins and is paid the
   runner-up's price. Everyone else's bond is returned at once.
5. **Pledge.** Backer agents pledge. Each pledge records the bonus it will earn
   if the campaign fails: the full rate when funding opens, falling to nothing
   by the deadline.
6. **Either** the goal is reached: the organizer is paid, the underwriter gets
   its bond back plus its fee. **Or** the deadline passes: every backer is
   refunded with their bonus out of the bond, and the underwriter gets what is
   left.

There is no operator. Anyone can trigger settlement and refunds, and the
contract has no owner and no admin method.

## The swarm

Every participant is an agent acting for one user from its own NEAR
sub-account (`backer-07.<parent>`, `uw-2.<parent>`, `org-1.<parent>`), so every
bid and pledge on chain traces back to one agent.

| | Count | What it decides |
|---|---|---|
| Backer agents | 20 | Whether its user cares about a campaign, and when to pledge. Four kinds: believers, followers, holdouts and bonus hunters |
| Underwriter agents | 5 | How likely a campaign is to be funded, what fee makes the risk worth taking, and whether to fill a last gap itself |
| Organizers | 3 | They differ in how well they size a goal |

The same agent code (`swarm/agents.mjs`) runs in three places:

- **Simulation** (`swarm/simulate.mjs`, and in the page): scripted strategies
  against the rules engine, with no model calls. Fully repeatable.
- **Local** (`swarm/live.mjs --local`): the real-time runner against the rules
  engine in memory.
- **Testnet** (`swarm/live.mjs`): the same runner, each agent signing its own
  transactions.

### near.social is the swarm's meeting place

near.social stores every post, reply and like as a NEAR transaction
([skill](https://near.social/skill.md)). That makes it a public, signed
message bus, which is exactly what agents need to find each other:

- the organizer's announcement is a post, and the campaign on chain points to
  it for ever (`social_post`);
- a backer agent's like says "my user wants this";
- underwriters price the guarantee from that interest;
- the guarantor's commitment and the final outcome are replies in the thread,
  so any person on near.social can follow a campaign, and reply to it.

`swarm/social.mjs` writes the standard records (`post/…`, `reply/…`, `like/…`,
`profile/…`) and reads them back through FastData. On mainnet the posts appear
on near.social itself. On testnet the same writes are indexed by FastData's
testnet endpoint, so the whole loop runs without real money and without
putting test chatter in front of real people. Every agent's profile says it
is automated.

To reach real people, `scripts/social-post.mjs` posts to the real near.social
from your own mainnet account, with a key that can only write to `social` and
cannot move funds. It shows the transaction and sends nothing unless you add
`--send`.

### Optional: a model for the two judgment calls

With `--llm` (and `NEARAI_API_KEY` set), two decisions go to a model on NEAR AI
Cloud instead of a script: a backer agent reads the announcement and judges how
well it fits what its user said they care about, and an underwriter writes one
public sentence on why it would or would not guarantee it. Everything about
money stays in the scripted, tested strategies. The four-campaign run
recorded in `data/latest.json` made 92 calls (about 19,000 tokens on
`z-ai/glm-5.3-flash`), a fraction of a cent.

## What the simulation shows

The same crowd, the same projects, the same wishes, run twice: once as
ordinary all-or-nothing crowdfunding, once with underwriters.

Across 200 different crowds (6,000 campaigns each way,
`node swarm/simulate.mjs --sweep 200`):

| | Ordinary | EitherWay |
|---|---|---|
| Campaigns funded | 24% | **53%** |
| Of the campaigns enough people wanted | 38% | **82%** |
| NEAR that reached projects | 44,593 | 102,947 |
| NEAR pledged to failed campaigns and returned with nothing | 37,841 | 14,412 |
| Bonuses paid to backers of failed campaigns | none | 2,087 |

EitherWay funded more campaigns in 199 of the 200 crowds and fewer in none.

**Who pays for the bonuses?** Underwriters that judged badly:

| Underwriter | How it thinks | Mean profit per crowd (NEAR) | Crowds where it lost money |
|---|---|---|---|
| sharp | reads demand well and knows it | +1.58 | 19% |
| steady | a decent read, a fair margin | +0.36 | 31% |
| careful | only sure things, fat margin | +0.23 | 14% |
| bold | overconfident, bids low to win | −1.95 | 73% |
| rookie | reads demand badly, learns fast | −2.96 | 85% |

### How the simulation works

- **The backers are scripted.** Of twenty, three pledge as soon as funding
  opens, nine join once enough others have, six hold back and hope others pay,
  and two only chase bonuses.
- **The guarantee changes one thing in a backer's rule.** When the bonus on
  offer covers what tying up their money costs them, they stop waiting for
  others. The result follows from that.
- **About four campaigns in ten ask for more than the crowd wants to give.**
  Those should fail, and they do, in both columns.
- **The underwriters' pricing model was fitted to this simulated crowd,** the
  way a working underwriter would learn their market.

The result holds when the assumptions change:

| Change | Ordinary | EitherWay |
|---|---|---|
| As above | 24% | 53% |
| Only one backer in twenty goes first (`--believers 1`) | 7% | 51% |
| Five in twenty go first (`--believers 5`) | 37% | 54% |
| Five competent underwriters, no amateurs (`--pros`) | 24% | 52%, and the underwriters as a group earn +2.86 NEAR per crowd |
| Two careless underwriters swapped in (`--careless`) | 24% | 54%, and the careless pair loses 17.7 NEAR per crowd |

So the gain does not rest on careless underwriters subsidising backers: with
only competent ones it is the same, and they make money.

## On chain

- `contract/core`: the rules as plain Rust with no NEAR dependency, so they
  test on any machine.
- `contract/near`: a thin `near-sdk` wrapper (storage, caller, time, moving
  NEAR). No owner, no admin method, no upgrade path in the code.
- `engine/market.mjs`: the same rules in JavaScript, used by the simulation,
  the page and local runs.
- `contract/core/tests/differential.rs` replays `engine/fixtures/scenarios.json`
  (18 scenarios, 2,227 calls, 1,293 of them rejected, 16 error codes) through
  the Rust rules and requires the same result, error code, return value and
  balances as the JavaScript engine after every call.
- `contract/vm/replay.test.mjs` does the same with **the built contract
  itself**. `contract/vm/mini-near.mjs` is a small stand-in for the NEAR
  runtime (registers, storage, caller, deposit, block time, sha256, logs,
  panics, transfers) that runs `contract/res/eitherway.wasm` in Node. All
  2,227 calls go through the compiled wasm and must match the engine, down to
  every view. (Gas and storage costs are measured on chain, not here.)

### Deploying the swarm to testnet

```
node scripts/faucet.mjs <yourname>.testnet     # then put that name in swarm.config.json as "parent"
                                               # (or: node scripts/fund.mjs, send testnet NEAR to the
                                               #  address it prints, then node scripts/fund.mjs --create)
node scripts/setup.mjs --plan                  # the 29 accounts, and the scale that fits the parent's balance
node scripts/setup.mjs                         # creates them, deploys the contract, sets near.social profiles
node swarm/live.mjs --rounds 4 --llm           # four campaigns, about 25 minutes, with the seed and scale setup recorded
node scripts/verify.mjs                        # re-checks every rule from the chain
```

Each call attaches only the gas it needs, with room to spare (`GAS` in
`swarm/chain.mjs`). While a call runs, NEAR holds back about 0.001 NEAR for
every Tgas attached, which matters for agents with small wallets. The run
record lists the most gas each kind of call burnt (`gas`); on testnet a
pledge burnt 3.3 Tgas and a finalize 5.7.

## Map of the repository

```
RULES.md                 the rules, written first
engine/                  rules engine (JavaScript), seeded random helpers, tests, fixtures
contract/core/           rules (Rust) and the differential test
contract/near/           the NEAR contract
contract/vm/             runs the built contract locally and replays every scenario through it
contract/res/            built contract
swarm/agents.mjs         backer and underwriter agents
swarm/sim.mjs            simulation (Node and browser)
swarm/live.mjs           real-time runner: local or testnet
swarm/chain.mjs          the two places a run can happen, behind one interface
swarm/social.mjs         near.social through FastData
swarm/near.mjs           NEAR client with no dependencies: keys, transactions, RPC
swarm/llm.mjs            optional model calls through NEAR AI Cloud
scripts/                 setup, faucet and funding, verify, near.social check and post, page server and single-file build
site/                    the live page
data/                    recorded runs and the 200-crowd summaries the page shows
video/                   the scripts that make the demo video; the video is video/out/eitherway-demo.mp4
docs/                    how the demo video is made
```

## Demo video

[video/out/eitherway-demo.mp4](video/out/eitherway-demo.mp4) (1:57): the
problem, the one change, who pays, one campaign of each outcome, the number,
and the swarm's testnet run. The script and how it is produced are in
[docs/VIDEO.md](docs/VIDEO.md).

## What's next

- **Milestone payouts.** A funded organizer is paid as it delivers, so
  underwriters can guarantee delivery as well as the goal.
- **Any token, any chain.** Pledges and bonds in any token, including from
  other chains, settled through NEAR Intents.
- **Storage deposits** (NEP-145), so each participant pays for its own records.
- **Reputation from near.social.** Underwriters weigh an organizer's posts,
  followers and past campaigns before they bid.

The risks the rules leave to underwriters, such as an organizer backing its
own campaign to collect the bonus, are set out in
[RULES.md, section 7](RULES.md#7-risks-and-next-steps).

## Credits

- Written with Claude Code (Anthropic). All code in this repository was
  written during the hackathon period.
- Runtime dependencies: none for the JavaScript. The contract uses `near-sdk`,
  `borsh` and `serde`; its tests also use `serde_json` and `sha2`. It is built
  with `cargo-near`.
- Services the testnet run uses: public NEAR testnet RPC (FastNEAR, dRPC,
  NEAR), FastData KV for near.social records, NEAR AI Cloud
  (`z-ai/glm-5.3-flash`) for the optional model calls, and NearBlocks for
  explorer links.
- The demo video is made by the scripts in `video/`: `playwright-core` films
  the real page, `edge-tts` reads the narration (an AI voice), `faster-whisper`
  checks that every line is heard as written, and ffmpeg (through
  `imageio-ffmpeg`), `numpy`, `soundfile` and Pillow mix it and make check
  images.
- The page's chart colours follow a colour-blind-safe reference palette.
- Licence: MIT, see [LICENSE](LICENSE).
