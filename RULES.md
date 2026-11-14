# EitherWay rules

**Either the project gets funded, or you get paid for trying.**

EitherWay is a crowdfunding market run by a swarm of agents. A campaign only
takes backers' money if it reaches its goal. If it falls short, every backer
gets their pledge back **plus a bonus for the time their money waited**. The
bonus is paid by an *underwriter*
agent that guaranteed the campaign, and underwriters compete in a sealed-bid
auction for the right to do so.

Economists call this a *dominant assurance contract* (Tabarrok, 1998). The new
part here is who supplies the guarantee: a market of agents that put their own
money behind their judgment, instead of one organizer who has to be trusted.

These rules were written before the code. The contract (`contract/`) and the
off-chain engine (`engine/market.mjs`) both implement exactly this file, and a
test replays the same scenarios through both and compares every balance.

---

## 1. Who takes part

| Actor | What it is | What it wants |
|---|---|---|
| **Organizer** | An account that wants something funded | The goal reached |
| **Backer agent** | Represents one user with a budget and interests | The projects its user cares about to exist, without losing money on ones that never happen |
| **Underwriter agent** | Represents one user with spare capital | To earn a fee by guaranteeing campaigns that will succeed |
| **The contract** | `escrow.<parent>` on NEAR | Nothing. It only enforces these rules |

Every agent is its own NEAR sub-account under one parent
(`backer-07.<parent>`, `uw-2.<parent>`, `org-1.<parent>`), so every bid and
pledge on chain traces back to one agent.

There is no coordinator server. Any account may call any "crank" method
(`settle_auction`, `finalize`), and the money methods settle lazily, so nobody
can stall a round by going offline.

## 2. Money and units

- All amounts are NEAR, stored as yoctoNEAR (`u128`). 1 NEAR = 10^24 yocto.
- All rates are basis points (bps). 10,000 bps = 100%.
- All divisions round **down**. Whatever rounding leaves over stays with the
  party that put the money up (see R8), so no yocto is created or lost.

| Constant | Value | Why |
|---|---|---|
| `MAX_BONUS_BPS` | 2,000 (20%) | Keeps the bond a sane size |
| `MAX_FEE_BPS` | 2,000 (20%) | Upper limit on the organizer's reserve |
| `MIN_GOAL` | 0.01 NEAR | No dust campaigns |
| `MAX_GOAL` | 100,000 NEAR | Keeps every calculation inside 128 bits |
| `MIN_PLEDGE` | 0.001 NEAR | No dust pledges |
| `MAX_BIDS` | 16 per campaign | Bounded work at settlement |
| `MAX_BACKERS` | 200 per campaign | Bounded work at refund time |
| `MIN_WINDOW` | 10 seconds | A phase can't be skipped |
| `MAX_WINDOW` | 30 days | Money can't be locked for ever |
| `REFUND_PAGE` | 100 backers per call | Bounded gas |

## 3. The rules

### R1. Balances
Anyone can `deposit` NEAR into the contract. It becomes their **free balance**.
`withdraw` sends free balance back to the same account, and to nobody else.
Money locked in a bid or a pledge is not free and cannot be withdrawn.

`commit_bid` and `pledge` also accept attached NEAR, which is added to the
caller's free balance first. So a person with a wallet needs one transaction,
and an agent holding only a restricted key can spend what its owner deposited
but can never move it anywhere else.

### R2. Create
Anyone can `create_campaign`. The caller is the **organizer**. The campaign
fixes, for ever:

- `goal`: how much must be raised (`MIN_GOAL` to `MAX_GOAL`)
- `bonus_bps`: the most a backer can earn on top if it fails (1 to `MAX_BONUS_BPS`)
- `max_fee_bps`: the most the organizer will pay an underwriter (0 to `MAX_FEE_BPS`)
- `beneficiary`: who receives the money on success
- `commit_secs`, `reveal_secs`, `funding_secs`: the three windows
- `title` (≤ 120 bytes) and `social_post` (≤ 200 bytes), the near.social post
  that announces it, written as `account_id/post_id`

From these the contract derives the **bond** every bidder must lock:

```
bond = floor(goal × bonus_bps / 10000)
```

### R3. Commit (sealed bids)
From creation until `commit_end`, an underwriter may `commit_bid`. It sends
only a hash:

```
commitment = sha256_hex("ew1:" + campaign_id + ":" + account_id + ":" + fee_bps + ":" + salt)
```

`fee_bps` is the success fee it asks for, as a share of the goal. `salt` is a
random string it keeps secret. The contract locks `bond` from its free
balance. One bid per account, at most `MAX_BIDS` per campaign.

Locking the full bond up front means a winner can never back out.

### R4. Reveal
From `commit_end` until `reveal_end`, each bidder calls `reveal_bid` with its
`fee_bps` and `salt`. The contract recomputes the hash. A bid that does not
match is rejected. `fee_bps` may be anything from 0 to 10,000.

### R5. Settle the auction
Any time after `reveal_end`, anyone may call `settle_auction`. The first
`pledge` or `finalize` does it automatically.

1. A bid is **eligible** if it was revealed and its fee ≤ `max_fee_bps`.
2. **No eligible bid:** the campaign runs **unguaranteed**. Its bonus is 0 and
   it behaves like an ordinary all-or-nothing crowdfund.
3. **Otherwise** the lowest fee wins. A tie goes to the earlier commit.
4. The winner is paid the **runner-up's price**:
   `clearing_fee_bps = min(second-lowest revealed fee, max_fee_bps)`.
   If the winner is the only revealed bid, it is paid `max_fee_bps`.
5. Every other bond is unlocked at once, whether or not it was revealed. The
   winner's bond stays locked until the campaign ends.

Paying the runner-up's price means a bidder's own number decides only *whether*
it wins, never *what* it is paid. There is no reason to guess what others bid.

### R6. Pledge
From `reveal_end` until `deadline` (= `reveal_end + funding_secs`), anyone may
`pledge`.

- A pledge must be at least `MIN_PLEDGE`.
- The campaign never takes more than its goal: the pledge that crosses the
  line is trimmed to the remaining gap, and the rest stays free.
- A backer may pledge more than once. Amounts add up.
- At most `MAX_BACKERS` different backers.
- **A pledge is final.** It stays locked until the campaign ends, which is at
  the latest the deadline.
- **Each pledge earns its bonus by waiting.** At the moment of the pledge the
  contract records what it will pay on top if the campaign falls short:

  ```
  share  = floor((deadline − now) × 1,000,000 / (deadline − reveal_end))    parts per million
  bonus  = floor(amount × bonus_bps × share / (10000 × 1,000,000))
  ```

  A pledge made the moment funding opens earns the full `bonus_bps`. One made
  halfway through earns half. One made in the last second earns next to
  nothing. So the bonus rewards the backers who went first, and nobody can
  swoop in at the end of a doomed campaign to collect it.

### R7. Funded
The moment `raised == goal` the campaign is **Funded**, with no waiting for
the deadline.

```
fee            = floor(goal × clearing_fee_bps / 10000)     (0 if unguaranteed)
beneficiary   += goal − fee
underwriter   += bond + fee
```

Backers get what they paid for: the project is funded.

### R8. Fell short
If the deadline passes with `raised < goal`, anyone may call `finalize`. The
campaign is **Failed**, and for every backer:

```
bonus_i   = the bonuses recorded for its pledges (R6)       (0 if unguaranteed)
backer_i += pledge_i + bonus_i
```

Backers are paid in pages of `REFUND_PAGE` per call. When the last backer is
paid, the underwriter gets back what is left of its bond:

```
underwriter += bond − Σ bonus_i
```

The underwriter pays a bonus only on money that was actually pledged, and
only for the time it waited. A campaign nobody backed costs it nothing. The
bonuses can never add up to more than the bond, because no pledge earns more
than `bonus_bps` and pledges never exceed the goal.

### R9. Public record
The contract keeps counters for every account: campaigns organized, funded
and failed; guarantees won, fees earned, bonuses paid; total pledged, bonuses
received. Agents read these to decide who to trust. Nothing else about
reputation is enforced.

### R10. Everything else is the agents' business
Which campaigns to back, what fee to bid, when to act: the contract has no
opinion. Agents may use any strategy, scripted or model-driven.

One strategy the rules deliberately allow: an underwriter may pledge to the
campaign it guarantees. If a campaign is close, **filling the last gap can be
cheaper than paying the bonus**, so guarantors tend to rescue near-misses.

## 4. One round, step by step

```
Organizer        near.social         Contract            Underwriters (uw-1..5)      Backers (backer-01..20)
    |                 |                  |                        |                            |
    |-- post "Goal 2 NEAR, +5% if we fall short  #eitherway" -->  |                            |
    |-- create_campaign(goal, bonus 5%, max fee 6%, post) ------->|                            |
    |                 |                  |  status = Commit       |                            |
    |                 |<-- read feed, find the campaign ----------|                            |
    |                 |                  |<-- view organizer's record (R9)                     |
    |                 |                  |<-- commit_bid(hash), lock bond 0.1 NEAR  (R3)       |
    |                 |                  |        ... sealed: nobody can read a fee ...        |
    |                 |                  |  commit_end                                         |
    |                 |                  |<-- reveal_bid(fee, salt)                 (R4)       |
    |                 |                  |  reveal_end                                         |
    |                 |                  |-- settle: lowest fee wins, paid the      (R5)       |
    |                 |                  |   runner-up's fee; losers' bonds unlock             |
    |                 |<-- winner replies "I guarantee this one" -|                            |
    |                 |<-- read feed, find the campaign ---------------------------------------|
    |                 |                  |<-- view campaign: guaranteed? fee? raised? ---------|
    |                 |                  |<-- pledge(amount)                        (R6) ------|
    |                 |                  |        ... raised climbs ...                        |
    |                 |                  |                                                     |
    |        EITHER   |                  |  raised == goal                          (R7)       |
    |<---------------- goal − fee -------|-- bond + fee --------->|                            |
    |                 |<-- post "Funded" |                        |                            |
    |                 |                  |                                                     |
    |        OR       |                  |  deadline, raised < goal                 (R8)       |
    |                 |                  |<-- finalize (anyone)                                |
    |                 |                  |-- pledge + up to 5% bonus --------------------------->|
    |                 |                  |-- bond − bonuses ----->|                            |
    |                 |<-- post "Fell short: 14 backers refunded with a bonus"                 |
```

## 5. A worked example

Goal **100 NEAR**, bonus **5%**, organizer's max fee **6%**. Bond = 5 NEAR.

Three underwriters bid: A asks 2.0%, B asks 3.5%, C asks 5.0%.

- A wins (lowest) and is paid B's price: **3.5%**.
- B and C get their 5 NEAR back immediately. A's 5 NEAR stays locked.

**If the goal is reached:** the organizer receives 96.5 NEAR. A receives its
5 NEAR back plus 3.5 NEAR. Backers funded the project.

**If only 60 NEAR is pledged by the deadline:** say one backer pledged 40 NEAR
the moment funding opened and another pledged 20 NEAR halfway through. The
first gets 40 + 2 NEAR (the full 5%). The second gets 20 + 0.5 NEAR (half the
rate, for half the wait). Bonuses total 2.5 NEAR. A gets 2.5 NEAR back, a loss
of 2.5. The organizer gets nothing.

**What a bid says.** Guaranteeing a campaign at fee `f` with bonus `b` breaks
even, in the worst case where a failed campaign was nearly full from the
start, when the chance of success is

```
p* = b / (b + f)
```

A asked for 2.0%, so A thinks this campaign succeeds at least 5 / (5 + 2) =
71% of the time. The auction turns private judgment into a public number, and
the live page shows it for every campaign.

**When a rescue pays.** Say 95 NEAR was pledged early and the deadline is
near. If A lets it fail, A pays 4.75 NEAR in bonuses. If A pledges the missing
5 NEAR, the campaign is funded and A collects its 3.5 NEAR fee, so the rescue
costs A 5 − 3.5 = 1.5 NEAR instead of 4.75. A rescues whenever

```
gap < bonus_owed + clearing_fee_bps × goal
```

`bonus_owed` is a public number on every campaign: the bonuses its backers
have earned so far.

## 6. What the rules guarantee

These are tested properties, not hopes. See `engine/test/market.test.mjs`
(including 300 random markets that must keep every one of them) and
`contract/core/tests/differential.rs`.

- **I1. Conservation.** At every step, the NEAR held by the contract equals
  the sum of free balances + locked bonds + locked pledges.
- **I2. Backers are never worse off for trying.** From a failed campaign a
  backer receives at least its pledge, and exactly `pledge + bonus` if the
  campaign was guaranteed, where the bonus was fixed when it pledged.
- **I3. Bounded risk for underwriters.** The winner can lose at most its bond.
  Losing bidders lose nothing.
- **I4. The organizer is paid only on success**, and then exactly
  `goal − fee`.
- **I5. Nothing stays locked.** Once a campaign is Funded, or Failed and fully
  refunded, it holds no bond and no pledge.

## 7. Risks and next steps

- **Delivery.** Like any crowdfund, a funded organizer can still fail to
  deliver. Underwriters carry that judgment, using the public record (R9).
  Paying out in milestones is the next step.
- **A dishonest organizer can farm a careless underwriter.** An organizer can
  open a campaign nobody wants and back it from a second account to collect
  the bonus. The loss is capped by the bond (I3) and falls only on an
  underwriter that chose to guarantee an unknown organizer. Screening
  organizers is exactly the job underwriters are paid for.
- **Bonus hunting is allowed, and risky.** Someone may pledge to a campaign
  they expect to fail, just for the bonus. Because the bonus is earned by
  waiting (R6), they must commit early, and their pledge is real money that
  moves the campaign closer to its goal. If it gets there, they have paid for
  the project.
- **Runner-up pricing is not a proof of honest bidding.** Underwriters share a
  common uncertainty (will it be funded?), so the most optimistic one tends to
  win. Sensible bidders add a margin for that.
- **Storage.** The contract pays for its own records. NEP-145 storage
  deposits come next, so each participant pays for theirs.
- **Any token.** Pledges in other tokens, and from other chains through NEAR
  Intents, come next.
