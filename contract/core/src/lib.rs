//! EitherWay rules: RULES.md as plain Rust, with no dependency on NEAR.
//!
//! Everything the contract decides lives here, written against the small
//! [`Env`] trait. The NEAR contract (`contract/near`) supplies an `Env` backed
//! by chain storage; the tests supply one backed by hash maps. That keeps the
//! rules testable on any machine, and lets `tests/differential.rs` replay the
//! same scenarios the JavaScript engine ran and compare every balance.
//!
//! Each function checks everything first and writes only after all checks
//! pass, in the same order as `engine/market.mjs`, so both report the same
//! error code for the same bad call.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::Serialize;

pub const BPS: u128 = 10_000;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

pub const MAX_BONUS_BPS: u32 = 2_000;
pub const MAX_FEE_BPS: u32 = 2_000;
pub const MIN_GOAL: u128 = NEAR / 100;
/// Keeps `amount * bonus_bps * PPM` inside 128 bits.
pub const MAX_GOAL: u128 = 100_000 * NEAR;
pub const PPM: u128 = 1_000_000;
pub const MIN_PLEDGE: u128 = NEAR / 1_000;
pub const MAX_BIDS: usize = 16;
pub const MAX_BACKERS: u32 = 200;
pub const MIN_WINDOW: u32 = 10;
pub const MAX_WINDOW: u32 = 30 * 86_400;
pub const REFUND_PAGE: u32 = 100;
pub const MAX_TITLE: usize = 120;
pub const MAX_POST: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuleError {
    pub code: &'static str,
    pub message: &'static str,
}
pub type Res<T> = Result<T, RuleError>;

fn need(ok: bool, code: &'static str, message: &'static str) -> Res<()> {
    if ok {
        Ok(())
    } else {
        Err(RuleError { code, message })
    }
}

// ---- state -------------------------------------------------------------------

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq)]
pub struct Account {
    pub balance: u128,
    pub org_created: u32,
    pub org_funded: u32,
    pub org_failed: u32,
    pub uw_won: u32,
    pub uw_funded: u32,
    pub uw_failed: u32,
    pub uw_fees: u128,
    pub uw_bonus_paid: u128,
    pub bk_pledged: u128,
    pub bk_bonus: u128,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Open,
    Funded,
    Failed,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Campaign {
    pub id: u32,
    pub organizer: String,
    pub beneficiary: String,
    pub title: String,
    pub social_post: String,
    pub goal: u128,
    pub bonus_bps: u32,
    pub max_fee_bps: u32,
    pub bond: u128,
    pub created_at: u64,
    pub commit_end: u64,
    pub reveal_end: u64,
    pub deadline: u64,
    pub auction_settled: bool,
    pub underwriter: Option<String>,
    pub clearing_fee_bps: u32,
    pub raised: u128,
    /// Sum of the bonuses backers have earned so far (R6).
    pub bonus_owed: u128,
    pub backer_count: u32,
    pub status: Status,
    pub refunded_upto: u32,
    pub bonus_paid: u128,
    pub closed: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Bid {
    pub account: String,
    pub commitment: [u8; 32],
    pub revealed: bool,
    pub fee_bps: u32,
}

/// One backer's stake in one campaign.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq)]
pub struct PledgeRec {
    pub amount: u128,
    /// What this backer is paid on top if the campaign falls short.
    pub bonus: u128,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq)]
pub struct Totals {
    /// All NEAR held for users: deposits minus withdrawals (I1).
    pub vault: u128,
    pub campaigns: u32,
}

pub struct CreateParams {
    pub title: String,
    pub social_post: String,
    pub beneficiary: String,
    pub goal: u128,
    pub bonus_bps: u32,
    pub max_fee_bps: u32,
    pub commit_secs: u32,
    pub reveal_secs: u32,
    pub funding_secs: u32,
}

/// What the rules need from the outside world.
pub trait Env {
    fn now_ms(&self) -> u64;
    fn sha256(&self, data: &[u8]) -> [u8; 32];

    fn totals(&self) -> Totals;
    fn set_totals(&mut self, totals: &Totals);

    /// A never-seen account reads as all zeroes.
    fn account(&self, id: &str) -> Account;
    fn set_account(&mut self, id: &str, account: &Account);

    fn campaign(&self, id: u32) -> Option<Campaign>;
    fn set_campaign(&mut self, campaign: &Campaign);

    fn bids(&self, id: u32) -> Vec<Bid>;
    fn set_bids(&mut self, id: u32, bids: &[Bid]);

    fn pledge_of(&self, id: u32, account: &str) -> PledgeRec;
    fn set_pledge(&mut self, id: u32, account: &str, pledge: &PledgeRec);

    fn backer_at(&self, id: u32, index: u32) -> String;
    fn set_backer_at(&mut self, id: u32, index: u32, account: &str);

    /// `data` is the inside of a JSON object, without the braces.
    fn emit(&mut self, event: &str, data: &str);
}

// ---- helpers -----------------------------------------------------------------

fn update<E: Env>(env: &mut E, id: &str, change: impl FnOnce(&mut Account)) {
    let mut account = env.account(id);
    change(&mut account);
    env.set_account(id, &account);
}

fn get_campaign<E: Env>(env: &E, id: u32) -> Res<Campaign> {
    env.campaign(id).ok_or(RuleError { code: "E_NO_CAMPAIGN", message: "campaign does not exist" })
}

pub fn phase(c: &Campaign, now: u64) -> &'static str {
    match c.status {
        Status::Funded => "Funded",
        Status::Failed => "Failed",
        Status::Open => {
            if now < c.commit_end {
                "Commit"
            } else if now < c.reveal_end {
                "Reveal"
            } else if now < c.deadline {
                "Funding"
            } else {
                "Expired"
            }
        }
    }
}

/// R2: the bond every bidder locks.
pub fn bond_for(goal: u128, bonus_bps: u32) -> u128 {
    goal * bonus_bps as u128 / BPS
}

fn opt_json(value: &Option<String>) -> String {
    match value {
        Some(v) => format!("\"{v}\""),
        None => "null".to_string(),
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// Exactly 64 lowercase hex characters, or `None`.
fn parse_commitment(hex: &str) -> Option<[u8; 32]> {
    let bytes = hex.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (nibble(bytes[2 * i])? << 4) | nibble(bytes[2 * i + 1])?;
    }
    Some(out)
}

/// R3: the sealed bid.
pub fn commitment<E: Env>(env: &E, id: u32, account: &str, fee_bps: u32, salt: &str) -> [u8; 32] {
    env.sha256(format!("ew1:{id}:{account}:{fee_bps}:{salt}").as_bytes())
}

// ---- R1 balances -------------------------------------------------------------

pub fn deposit<E: Env>(env: &mut E, who: &str, amount: u128) -> Res<()> {
    need(amount > 0, "E_AMOUNT", "deposit must be positive")?;
    update(env, who, |a| a.balance += amount);
    let mut totals = env.totals();
    totals.vault += amount;
    env.set_totals(&totals);
    env.emit("deposit", &format!("\"account\":\"{who}\",\"amount\":\"{amount}\""));
    Ok(())
}

pub fn withdraw<E: Env>(env: &mut E, who: &str, amount: u128) -> Res<()> {
    need(amount > 0, "E_AMOUNT", "withdrawal must be positive")?;
    need(env.account(who).balance >= amount, "E_BALANCE", "not enough free balance")?;
    update(env, who, |a| a.balance -= amount);
    let mut totals = env.totals();
    totals.vault -= amount;
    env.set_totals(&totals);
    env.emit("withdraw", &format!("\"account\":\"{who}\",\"amount\":\"{amount}\""));
    Ok(())
}

// ---- R2 create ---------------------------------------------------------------

pub fn create_campaign<E: Env>(env: &mut E, organizer: &str, p: CreateParams) -> Res<u32> {
    need(p.goal >= MIN_GOAL && p.goal <= MAX_GOAL, "E_GOAL", "goal out of range")?;
    need(p.bonus_bps >= 1 && p.bonus_bps <= MAX_BONUS_BPS, "E_BONUS", "bonus_bps out of range")?;
    need(p.max_fee_bps <= MAX_FEE_BPS, "E_FEE", "max_fee_bps out of range")?;
    for w in [p.commit_secs, p.reveal_secs, p.funding_secs] {
        need((MIN_WINDOW..=MAX_WINDOW).contains(&w), "E_WINDOW", "window out of range")?;
    }
    need(!p.title.is_empty() && p.title.len() <= MAX_TITLE, "E_TEXT", "title length out of range")?;
    need(p.social_post.len() <= MAX_POST, "E_TEXT", "social_post too long")?;

    let now = env.now_ms();
    let mut totals = env.totals();
    let id = totals.campaigns;
    let commit_end = now + p.commit_secs as u64 * 1000;
    let reveal_end = commit_end + p.reveal_secs as u64 * 1000;
    let campaign = Campaign {
        id,
        organizer: organizer.to_string(),
        beneficiary: p.beneficiary,
        title: p.title,
        social_post: p.social_post,
        goal: p.goal,
        bonus_bps: p.bonus_bps,
        max_fee_bps: p.max_fee_bps,
        bond: bond_for(p.goal, p.bonus_bps),
        created_at: now,
        commit_end,
        reveal_end,
        deadline: reveal_end + p.funding_secs as u64 * 1000,
        auction_settled: false,
        underwriter: None,
        clearing_fee_bps: 0,
        raised: 0,
        bonus_owed: 0,
        backer_count: 0,
        status: Status::Open,
        refunded_upto: 0,
        bonus_paid: 0,
        closed: false,
    };
    env.set_campaign(&campaign);
    totals.campaigns += 1;
    env.set_totals(&totals);
    update(env, organizer, |a| a.org_created += 1);
    env.emit(
        "campaign_created",
        &format!(
            "\"id\":{id},\"organizer\":\"{organizer}\",\"goal\":\"{}\",\"bonus_bps\":{},\"max_fee_bps\":{}",
            campaign.goal, campaign.bonus_bps, campaign.max_fee_bps
        ),
    );
    Ok(id)
}

// ---- R3 commit ---------------------------------------------------------------

pub fn commit_bid<E: Env>(env: &mut E, who: &str, id: u32, commitment_hex: &str, attached: u128) -> Res<()> {
    let c = get_campaign(env, id)?;
    need(phase(&c, env.now_ms()) == "Commit", "E_PHASE", "bids are only accepted in the commit window")?;
    let parsed = parse_commitment(commitment_hex);
    need(parsed.is_some(), "E_COMMITMENT", "commitment must be 64 lowercase hex characters")?;
    let mut bids = env.bids(id);
    need(!bids.iter().any(|b| b.account == who), "E_DUPLICATE", "one bid per account")?;
    need(bids.len() < MAX_BIDS, "E_FULL", "too many bids")?;
    need(env.account(who).balance + attached >= c.bond, "E_BALANCE", "not enough free balance for the bond")?;

    update(env, who, |a| a.balance = a.balance + attached - c.bond);
    if attached > 0 {
        let mut totals = env.totals();
        totals.vault += attached;
        env.set_totals(&totals);
    }
    bids.push(Bid { account: who.to_string(), commitment: parsed.unwrap(), revealed: false, fee_bps: 0 });
    env.set_bids(id, &bids);
    env.emit("bid_committed", &format!("\"id\":{id},\"account\":\"{who}\",\"bond\":\"{}\"", c.bond));
    Ok(())
}

// ---- R4 reveal ---------------------------------------------------------------

pub fn reveal_bid<E: Env>(env: &mut E, who: &str, id: u32, fee_bps: u32, salt: &str) -> Res<()> {
    let c = get_campaign(env, id)?;
    need(phase(&c, env.now_ms()) == "Reveal", "E_PHASE", "bids are only revealed in the reveal window")?;
    let mut bids = env.bids(id);
    let index = bids.iter().position(|b| b.account == who);
    need(index.is_some(), "E_NO_BID", "no bid from this account")?;
    let index = index.unwrap();
    need(!bids[index].revealed, "E_DUPLICATE", "bid already revealed")?;
    need(fee_bps <= 10_000, "E_FEE", "fee_bps out of range")?;
    need(
        commitment(env, id, who, fee_bps, salt) == bids[index].commitment,
        "E_MISMATCH",
        "reveal does not match the commitment",
    )?;

    bids[index].revealed = true;
    bids[index].fee_bps = fee_bps;
    env.set_bids(id, &bids);
    env.emit("bid_revealed", &format!("\"id\":{id},\"account\":\"{who}\",\"fee_bps\":{fee_bps}"));
    Ok(())
}

// ---- R5 settle the auction ------------------------------------------------------

/// Who wins and at what fee. Pure: reads the bids, changes nothing.
pub fn auction_outcome(bids: &[Bid], max_fee_bps: u32) -> (Option<usize>, u32) {
    // Lowest fee first; ties go to the earlier commit.
    let mut revealed: Vec<(u32, usize)> =
        bids.iter().enumerate().filter(|(_, b)| b.revealed).map(|(i, b)| (b.fee_bps, i)).collect();
    revealed.sort();
    match revealed.first() {
        Some(&(fee, index)) if fee <= max_fee_bps => {
            let clearing = match revealed.get(1) {
                Some(&(runner_up, _)) => runner_up.min(max_fee_bps),
                None => max_fee_bps,
            };
            (Some(index), clearing)
        }
        _ => (None, 0),
    }
}

fn settle<E: Env>(env: &mut E, c: &mut Campaign) {
    let bids = env.bids(c.id);
    let (winner, clearing) = auction_outcome(&bids, c.max_fee_bps);
    if let Some(w) = winner {
        c.underwriter = Some(bids[w].account.clone());
        c.clearing_fee_bps = clearing;
        update(env, &bids[w].account, |a| a.uw_won += 1);
    }
    let bond = c.bond;
    for (i, bid) in bids.iter().enumerate() {
        if Some(i) != winner {
            update(env, &bid.account, |a| a.balance += bond);
        }
    }
    c.auction_settled = true;
    env.emit(
        "auction_settled",
        &format!(
            "\"id\":{},\"underwriter\":{},\"clearing_fee_bps\":{}",
            c.id,
            opt_json(&c.underwriter),
            c.clearing_fee_bps
        ),
    );
}

pub fn settle_auction<E: Env>(env: &mut E, id: u32) -> Res<()> {
    let mut c = get_campaign(env, id)?;
    need(!c.auction_settled, "E_SETTLED", "auction already settled")?;
    need(env.now_ms() >= c.reveal_end, "E_PHASE", "the reveal window is still open")?;
    settle(env, &mut c);
    env.set_campaign(&c);
    Ok(())
}

// ---- R6 pledge, R7 funded -------------------------------------------------------

pub fn pledge<E: Env>(env: &mut E, who: &str, id: u32, amount: u128, attached: u128) -> Res<u128> {
    let mut c = get_campaign(env, id)?;
    let now = env.now_ms();
    need(phase(&c, now) == "Funding", "E_PHASE", "pledges are only accepted in the funding window")?;
    need(amount >= MIN_PLEDGE, "E_AMOUNT", "pledge is below the minimum")?;
    let mut record = env.pledge_of(id, who);
    let is_new = record.amount == 0;
    need(!is_new || c.backer_count < MAX_BACKERS, "E_FULL", "too many backers")?;
    let gap = c.goal - c.raised;
    let taken = amount.min(gap);
    // The first pledge settles the auction (R5), which hands a losing bidder
    // its bond back. Count that bond as available.
    let mut unlocked = 0;
    if !c.auction_settled {
        let bids = env.bids(id);
        if let Some(mine) = bids.iter().position(|b| b.account == who) {
            if auction_outcome(&bids, c.max_fee_bps).0 != Some(mine) {
                unlocked = c.bond;
            }
        }
    }
    need(env.account(who).balance + attached + unlocked >= taken, "E_BALANCE", "not enough free balance")?;

    if !c.auction_settled {
        settle(env, &mut c);
    }
    update(env, who, |a| {
        a.balance = a.balance + attached - taken;
        a.bk_pledged += taken;
    });
    if attached > 0 {
        let mut totals = env.totals();
        totals.vault += attached;
        env.set_totals(&totals);
    }
    if is_new {
        env.set_backer_at(id, c.backer_count, who);
        c.backer_count += 1;
    }
    // The bonus is earned by waiting: a pledge made when funding opens earns
    // the full rate, one made halfway earns half, one made at the end nothing.
    let share_ppm = (c.deadline - now) as u128 * PPM / (c.deadline - c.reveal_end) as u128;
    let bonus = taken * c.bonus_bps as u128 * share_ppm / (BPS * PPM);
    record.amount += taken;
    record.bonus += bonus;
    env.set_pledge(id, who, &record);
    c.bonus_owed += bonus;
    c.raised += taken;
    env.emit(
        "pledged",
        &format!(
            "\"id\":{id},\"account\":\"{who}\",\"amount\":\"{taken}\",\"bonus\":\"{bonus}\",\"raised\":\"{}\"",
            c.raised
        ),
    );

    if c.raised == c.goal {
        fund(env, &mut c);
    }
    env.set_campaign(&c);
    Ok(taken)
}

fn fund<E: Env>(env: &mut E, c: &mut Campaign) {
    let fee = if c.underwriter.is_some() { c.goal * c.clearing_fee_bps as u128 / BPS } else { 0 };
    let paid = c.goal - fee;
    update(env, &c.beneficiary, |a| a.balance += paid);
    update(env, &c.organizer, |a| a.org_funded += 1);
    if let Some(underwriter) = &c.underwriter {
        let bond = c.bond;
        update(env, underwriter, |a| {
            a.balance += bond + fee;
            a.uw_funded += 1;
            a.uw_fees += fee;
        });
    }
    c.status = Status::Funded;
    c.closed = true;
    env.emit(
        "funded",
        &format!(
            "\"id\":{},\"beneficiary\":\"{}\",\"paid\":\"{paid}\",\"underwriter\":{},\"fee\":\"{fee}\"",
            c.id,
            c.beneficiary,
            opt_json(&c.underwriter)
        ),
    );
}

// ---- R8 fell short ----------------------------------------------------------------

/// Returns (closed, backers refunded so far).
pub fn finalize<E: Env>(env: &mut E, id: u32, limit: u32) -> Res<(bool, u32)> {
    let mut c = get_campaign(env, id)?;
    need(c.status != Status::Funded, "E_PHASE", "campaign was funded")?;
    need(!c.closed, "E_CLOSED", "campaign is already closed")?;
    need(env.now_ms() >= c.deadline, "E_PHASE", "the deadline has not passed")?;
    need(limit >= 1, "E_AMOUNT", "limit must be at least 1")?;

    if !c.auction_settled {
        settle(env, &mut c);
    }
    if c.status == Status::Open {
        c.status = Status::Failed;
        update(env, &c.organizer, |a| a.org_failed += 1);
        if let Some(underwriter) = &c.underwriter {
            update(env, underwriter, |a| a.uw_failed += 1);
        }
    }

    let end = c.backer_count.min(c.refunded_upto + limit.min(REFUND_PAGE));
    for i in c.refunded_upto..end {
        let backer = env.backer_at(id, i);
        let record = env.pledge_of(id, &backer);
        let pledged = record.amount;
        let bonus = if c.underwriter.is_some() { record.bonus } else { 0 };
        update(env, &backer, |a| {
            a.balance += pledged + bonus;
            a.bk_bonus += bonus;
        });
        c.bonus_paid += bonus;
        env.emit(
            "refunded",
            &format!("\"id\":{id},\"account\":\"{backer}\",\"pledge\":\"{pledged}\",\"bonus\":\"{bonus}\""),
        );
    }
    c.refunded_upto = end;

    if c.refunded_upto == c.backer_count {
        if let Some(underwriter) = &c.underwriter {
            let back = c.bond - c.bonus_paid;
            let bonus_paid = c.bonus_paid;
            update(env, underwriter, |a| {
                a.balance += back;
                a.uw_bonus_paid += bonus_paid;
            });
        }
        c.closed = true;
        env.emit(
            "failed",
            &format!(
                "\"id\":{id},\"raised\":\"{}\",\"bonus_paid\":\"{}\",\"underwriter\":{}",
                c.raised,
                c.bonus_paid,
                opt_json(&c.underwriter)
            ),
        );
    }
    env.set_campaign(&c);
    Ok((c.closed, c.refunded_upto))
}

// ---- views (same JSON shape as engine/market.mjs) -----------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct CampaignView {
    pub id: u32,
    pub organizer: String,
    pub beneficiary: String,
    pub title: String,
    pub social_post: String,
    pub goal: String,
    pub bonus_bps: u32,
    pub max_fee_bps: u32,
    pub bond: String,
    pub created_at: u64,
    pub commit_end: u64,
    pub reveal_end: u64,
    pub deadline: u64,
    pub status: &'static str,
    pub phase: &'static str,
    pub auction_settled: bool,
    pub underwriter: Option<String>,
    pub clearing_fee_bps: u32,
    pub raised: String,
    pub bonus_owed: String,
    pub backer_count: u32,
    pub bid_count: u32,
    pub refunded_upto: u32,
    pub bonus_paid: String,
    pub closed: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct BidView {
    pub account: String,
    pub commitment: String,
    pub revealed: bool,
    pub fee_bps: Option<u32>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PledgeView {
    pub account: String,
    pub amount: String,
    pub bonus: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct AccountView {
    pub balance: String,
    pub org_created: u32,
    pub org_funded: u32,
    pub org_failed: u32,
    pub uw_won: u32,
    pub uw_funded: u32,
    pub uw_failed: u32,
    pub uw_fees: String,
    pub uw_bonus_paid: String,
    pub bk_pledged: String,
    pub bk_bonus: String,
}

pub fn campaign_view<E: Env>(env: &E, id: u32) -> Option<CampaignView> {
    let c = env.campaign(id)?;
    let bonus_owed = if c.underwriter.is_some() { c.bonus_owed } else { 0 };
    Some(CampaignView {
        id: c.id,
        phase: phase(&c, env.now_ms()),
        status: match c.status {
            Status::Open => "Open",
            Status::Funded => "Funded",
            Status::Failed => "Failed",
        },
        organizer: c.organizer,
        beneficiary: c.beneficiary,
        title: c.title,
        social_post: c.social_post,
        goal: c.goal.to_string(),
        bonus_bps: c.bonus_bps,
        max_fee_bps: c.max_fee_bps,
        bond: c.bond.to_string(),
        created_at: c.created_at,
        commit_end: c.commit_end,
        reveal_end: c.reveal_end,
        deadline: c.deadline,
        auction_settled: c.auction_settled,
        underwriter: c.underwriter,
        clearing_fee_bps: c.clearing_fee_bps,
        raised: c.raised.to_string(),
        bonus_owed: bonus_owed.to_string(),
        backer_count: c.backer_count,
        bid_count: env.bids(id).len() as u32,
        refunded_upto: c.refunded_upto,
        bonus_paid: c.bonus_paid.to_string(),
        closed: c.closed,
    })
}

pub fn bids_view<E: Env>(env: &E, id: u32) -> Vec<BidView> {
    env.bids(id)
        .into_iter()
        .map(|b| BidView {
            account: b.account,
            commitment: to_hex(&b.commitment),
            revealed: b.revealed,
            fee_bps: if b.revealed { Some(b.fee_bps) } else { None },
        })
        .collect()
}

pub fn pledges_view<E: Env>(env: &E, id: u32, from: u32, limit: u32) -> Vec<PledgeView> {
    let count = env.campaign(id).map(|c| c.backer_count).unwrap_or(0);
    (from..count.min(from.saturating_add(limit)))
        .map(|i| {
            let account = env.backer_at(id, i);
            let record = env.pledge_of(id, &account);
            PledgeView { account, amount: record.amount.to_string(), bonus: record.bonus.to_string() }
        })
        .collect()
}

pub fn account_view<E: Env>(env: &E, id: &str) -> AccountView {
    let a = env.account(id);
    AccountView {
        balance: a.balance.to_string(),
        org_created: a.org_created,
        org_funded: a.org_funded,
        org_failed: a.org_failed,
        uw_won: a.uw_won,
        uw_funded: a.uw_funded,
        uw_failed: a.uw_failed,
        uw_fees: a.uw_fees.to_string(),
        uw_bonus_paid: a.uw_bonus_paid.to_string(),
        bk_pledged: a.bk_pledged.to_string(),
        bk_bonus: a.bk_bonus.to_string(),
    }
}
