//! EitherWay on NEAR.
//!
//! This file is deliberately thin. Every rule lives in `eitherway-core`
//! (RULES.md as plain Rust). Here we only connect those rules to the chain:
//! who is calling, what time it is, where state is stored, and moving NEAR in
//! and out.
//!
//! The contract has no owner and no admin method. Nobody can pause it, change
//! a campaign, or move anyone else's money.

use eitherway_core::{self as rules, Account, Bid, Campaign, CreateParams, Env, PledgeRec, RuleError, Totals};
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, AccountId, NearToken, Promise};

// ---- storage -------------------------------------------------------------------
//
// Raw keys, one record each, so a call touches only what it needs:
//   t                          Totals
//   a <account>                Account
//   c <id>                     Campaign
//   b <id>                     Vec<Bid>            (at most MAX_BIDS)
//   p <id> <account>           PledgeRec           (one backer's pledge and earned bonus)
//   k <id> <index>             String              (backers in pledge order)

fn key(prefix: u8, id: u32, tail: &[u8]) -> Vec<u8> {
    let mut k = Vec::with_capacity(5 + tail.len());
    k.push(prefix);
    k.extend_from_slice(&id.to_be_bytes());
    k.extend_from_slice(tail);
    k
}

fn account_key(id: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(1 + id.len());
    k.push(b'a');
    k.extend_from_slice(id.as_bytes());
    k
}

fn read<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key)
        .map(|bytes| T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("E_STATE: unreadable record")))
}

fn write<T: BorshSerialize>(key: &[u8], value: &T) {
    let bytes = borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("E_STATE: unwritable record"));
    env::storage_write(key, &bytes);
}

struct Chain;

impl Env for Chain {
    fn now_ms(&self) -> u64 {
        env::block_timestamp_ms()
    }
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        env::sha256_array(data)
    }
    fn totals(&self) -> Totals {
        read(b"t").unwrap_or_default()
    }
    fn set_totals(&mut self, totals: &Totals) {
        write(b"t", totals)
    }
    fn account(&self, id: &str) -> Account {
        read(&account_key(id)).unwrap_or_default()
    }
    fn set_account(&mut self, id: &str, account: &Account) {
        write(&account_key(id), account)
    }
    fn campaign(&self, id: u32) -> Option<Campaign> {
        read(&key(b'c', id, &[]))
    }
    fn set_campaign(&mut self, campaign: &Campaign) {
        write(&key(b'c', campaign.id, &[]), campaign)
    }
    fn bids(&self, id: u32) -> Vec<Bid> {
        read(&key(b'b', id, &[])).unwrap_or_default()
    }
    fn set_bids(&mut self, id: u32, bids: &[Bid]) {
        write(&key(b'b', id, &[]), &bids.to_vec())
    }
    fn pledge_of(&self, id: u32, account: &str) -> PledgeRec {
        read(&key(b'p', id, account.as_bytes())).unwrap_or_default()
    }
    fn set_pledge(&mut self, id: u32, account: &str, pledge: &PledgeRec) {
        write(&key(b'p', id, account.as_bytes()), pledge)
    }
    fn backer_at(&self, id: u32, index: u32) -> String {
        read(&key(b'k', id, &index.to_be_bytes())).unwrap_or_else(|| env::panic_str("E_STATE: missing backer"))
    }
    fn set_backer_at(&mut self, id: u32, index: u32, account: &str) {
        write(&key(b'k', id, &index.to_be_bytes()), &account.to_string())
    }
    fn emit(&mut self, event: &str, data: &str) {
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"eitherway\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{{{data}}}]}}"
        ));
    }
}

/// A broken rule aborts the transaction, which also returns any attached NEAR.
fn check<T>(result: Result<T, RuleError>) -> T {
    result.unwrap_or_else(|e| env::panic_str(&format!("{}: {}", e.code, e.message)))
}

fn caller() -> String {
    env::predecessor_account_id().to_string()
}

fn attached() -> u128 {
    env::attached_deposit().as_yoctonear()
}

// ---- the contract ----------------------------------------------------------------

#[near(contract_state)]
#[derive(Default)]
pub struct Contract {}

#[near]
impl Contract {
    /// R1. Add the attached NEAR to the caller's free balance.
    #[payable]
    pub fn deposit(&mut self) {
        check(rules::deposit(&mut Chain, &caller(), attached()));
    }

    /// R1. Send free balance back to the caller, and to nobody else.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        check(rules::withdraw(&mut Chain, &caller(), amount.0));
        Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// R2. Open a campaign. Returns its id.
    #[allow(clippy::too_many_arguments)]
    pub fn create_campaign(
        &mut self,
        title: String,
        goal: U128,
        bonus_bps: u32,
        max_fee_bps: u32,
        commit_secs: u32,
        reveal_secs: u32,
        funding_secs: u32,
        beneficiary: Option<AccountId>,
        social_post: Option<String>,
    ) -> u32 {
        let organizer = caller();
        check(rules::create_campaign(
            &mut Chain,
            &organizer,
            CreateParams {
                title,
                social_post: social_post.unwrap_or_default(),
                beneficiary: beneficiary.map(|b| b.to_string()).unwrap_or_else(|| organizer.clone()),
                goal: goal.0,
                bonus_bps,
                max_fee_bps,
                commit_secs,
                reveal_secs,
                funding_secs,
            },
        ))
    }

    /// R3. Send a sealed bid and lock the bond. Attached NEAR counts towards it.
    #[payable]
    pub fn commit_bid(&mut self, campaign_id: u32, commitment: String) {
        check(rules::commit_bid(&mut Chain, &caller(), campaign_id, &commitment, attached()));
    }

    /// R4. Open a sealed bid.
    pub fn reveal_bid(&mut self, campaign_id: u32, fee_bps: u32, salt: String) {
        check(rules::reveal_bid(&mut Chain, &caller(), campaign_id, fee_bps, &salt));
    }

    /// R5. Pick the winner. Anyone may call this once the reveal window closes.
    pub fn settle_auction(&mut self, campaign_id: u32) {
        check(rules::settle_auction(&mut Chain, campaign_id));
    }

    /// R6, R7. Pledge to a campaign. Returns how much was actually taken,
    /// which is less than `amount` only for the pledge that reaches the goal.
    #[payable]
    pub fn pledge(&mut self, campaign_id: u32, amount: U128) -> U128 {
        U128(check(rules::pledge(&mut Chain, &caller(), campaign_id, amount.0, attached())))
    }

    /// R8. After the deadline, refund backers with their bonus, one page per
    /// call. Anyone may call this.
    pub fn finalize(&mut self, campaign_id: u32, limit: Option<u32>) -> Value {
        let (closed, refunded) =
            check(rules::finalize(&mut Chain, campaign_id, limit.unwrap_or(rules::REFUND_PAGE)));
        json!({ "closed": closed, "refunded": refunded })
    }

    // ---- views ---------------------------------------------------------------

    pub fn get_campaign(&self, campaign_id: u32) -> Option<rules::CampaignView> {
        rules::campaign_view(&Chain, campaign_id)
    }

    pub fn get_campaigns(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<rules::CampaignView> {
        let from = from_index.unwrap_or(0);
        let count = Chain.totals().campaigns;
        (from..count.min(from.saturating_add(limit.unwrap_or(50).min(100))))
            .filter_map(|id| rules::campaign_view(&Chain, id))
            .collect()
    }

    pub fn get_bids(&self, campaign_id: u32) -> Vec<rules::BidView> {
        rules::bids_view(&Chain, campaign_id)
    }

    pub fn get_pledges(&self, campaign_id: u32, from_index: Option<u32>, limit: Option<u32>) -> Vec<rules::PledgeView> {
        rules::pledges_view(&Chain, campaign_id, from_index.unwrap_or(0), limit.unwrap_or(100).min(200))
    }

    /// R9. An account's free balance and public record.
    pub fn get_account(&self, account_id: AccountId) -> rules::AccountView {
        rules::account_view(&Chain, account_id.as_str())
    }

    /// I1. All NEAR held for users, and how many campaigns exist.
    pub fn get_totals(&self) -> Value {
        let totals = Chain.totals();
        json!({ "vault": totals.vault.to_string(), "campaigns": totals.campaigns })
    }

    /// The constants from RULES.md section 2.
    pub fn get_rules(&self) -> Value {
        json!({
            "max_bonus_bps": rules::MAX_BONUS_BPS,
            "max_fee_bps": rules::MAX_FEE_BPS,
            "min_goal": rules::MIN_GOAL.to_string(),
            "max_goal": rules::MAX_GOAL.to_string(),
            "min_pledge": rules::MIN_PLEDGE.to_string(),
            "max_bids": rules::MAX_BIDS,
            "max_backers": rules::MAX_BACKERS,
            "min_window_secs": rules::MIN_WINDOW,
            "max_window_secs": rules::MAX_WINDOW,
            "refund_page": rules::REFUND_PAGE,
        })
    }
}
