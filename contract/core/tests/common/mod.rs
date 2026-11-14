//! An in-memory `Env` for tests: the chain replaced by hash maps and a clock
//! the test moves by hand.

use eitherway_core::{Account, Bid, Campaign, Env, PledgeRec, Totals};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Default)]
pub struct MemEnv {
    pub now: u64,
    pub totals: Totals,
    pub accounts: HashMap<String, Account>,
    pub campaigns: HashMap<u32, Campaign>,
    pub bids: HashMap<u32, Vec<Bid>>,
    pub pledges: HashMap<(u32, String), PledgeRec>,
    pub backers: HashMap<(u32, u32), String>,
    pub events: Vec<String>,
}

impl Env for MemEnv {
    fn now_ms(&self) -> u64 {
        self.now
    }
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        Sha256::digest(data).into()
    }
    fn totals(&self) -> Totals {
        self.totals.clone()
    }
    fn set_totals(&mut self, totals: &Totals) {
        self.totals = totals.clone();
    }
    fn account(&self, id: &str) -> Account {
        self.accounts.get(id).cloned().unwrap_or_default()
    }
    fn set_account(&mut self, id: &str, account: &Account) {
        self.accounts.insert(id.to_string(), account.clone());
    }
    fn campaign(&self, id: u32) -> Option<Campaign> {
        self.campaigns.get(&id).cloned()
    }
    fn set_campaign(&mut self, campaign: &Campaign) {
        self.campaigns.insert(campaign.id, campaign.clone());
    }
    fn bids(&self, id: u32) -> Vec<Bid> {
        self.bids.get(&id).cloned().unwrap_or_default()
    }
    fn set_bids(&mut self, id: u32, bids: &[Bid]) {
        self.bids.insert(id, bids.to_vec());
    }
    fn pledge_of(&self, id: u32, account: &str) -> PledgeRec {
        self.pledges.get(&(id, account.to_string())).cloned().unwrap_or_default()
    }
    fn set_pledge(&mut self, id: u32, account: &str, pledge: &PledgeRec) {
        self.pledges.insert((id, account.to_string()), pledge.clone());
    }
    fn backer_at(&self, id: u32, index: u32) -> String {
        self.backers.get(&(id, index)).cloned().expect("missing backer")
    }
    fn set_backer_at(&mut self, id: u32, index: u32, account: &str) {
        self.backers.insert((id, index), account.to_string());
    }
    fn emit(&mut self, event: &str, data: &str) {
        self.events.push(format!("{{\"event\":\"{event}\",{data}}}"));
    }
}

impl MemEnv {
    /// I1: free balances + locked bonds + locked pledges, to compare with the vault.
    pub fn held(&self) -> u128 {
        let mut total: u128 = self.accounts.values().map(|a| a.balance).sum();
        for c in self.campaigns.values() {
            if c.closed {
                continue;
            }
            let bids = self.bids(c.id).len() as u128;
            if !c.auction_settled {
                total += c.bond * bids;
            } else if c.underwriter.is_some() {
                total += c.bond - c.bonus_paid;
            }
            for i in c.refunded_upto..c.backer_count {
                total += self.pledge_of(c.id, &self.backer_at(c.id, i)).amount;
            }
        }
        total
    }
}
