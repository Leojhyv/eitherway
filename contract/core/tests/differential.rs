//! Replays every scenario in engine/fixtures/scenarios.json through the Rust
//! rules and requires the same answer the JavaScript engine gave: same
//! success or error code for every call, same return value, same vault after
//! every call, and the same final state down to the last yocto.
//!
//! Regenerate the fixture with `node engine/fixtures.mjs`.

mod common;

use common::MemEnv;
use eitherway_core::{self as rules, CreateParams, Env};
use serde_json::{json, Value};

const FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../engine/fixtures/scenarios.json"));

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("missing string field {key} in {v}"))
}
fn amount(v: &Value, key: &str) -> u128 {
    text(v, key).parse().unwrap()
}
fn number(v: &Value, key: &str) -> u32 {
    v[key].as_u64().unwrap_or_else(|| panic!("missing number field {key} in {v}")) as u32
}

/// Runs one recorded call. Returns the value the engine would have returned.
fn apply(env: &mut MemEnv, op: &Value) -> Result<Value, rules::RuleError> {
    match text(op, "op") {
        "deposit" => rules::deposit(env, text(op, "who"), amount(op, "amount")).map(|_| Value::Null),
        "withdraw" => rules::withdraw(env, text(op, "who"), amount(op, "amount")).map(|_| Value::Null),
        "create" => rules::create_campaign(
            env,
            text(op, "who"),
            CreateParams {
                title: text(op, "title").to_string(),
                social_post: text(op, "social_post").to_string(),
                beneficiary: text(op, "beneficiary").to_string(),
                goal: amount(op, "goal"),
                bonus_bps: number(op, "bonus_bps"),
                max_fee_bps: number(op, "max_fee_bps"),
                commit_secs: number(op, "commit_secs"),
                reveal_secs: number(op, "reveal_secs"),
                funding_secs: number(op, "funding_secs"),
            },
        )
        .map(|id| json!(id)),
        "commit" => {
            rules::commit_bid(env, text(op, "who"), number(op, "id"), text(op, "commitment"), amount(op, "attached"))
                .map(|_| Value::Null)
        }
        "reveal" => rules::reveal_bid(env, text(op, "who"), number(op, "id"), number(op, "fee_bps"), text(op, "salt"))
            .map(|_| Value::Null),
        "settle" => rules::settle_auction(env, number(op, "id")).map(|_| Value::Null),
        "pledge" => rules::pledge(env, text(op, "who"), number(op, "id"), amount(op, "amount"), amount(op, "attached"))
            .map(|taken| json!(taken.to_string())),
        "finalize" => rules::finalize(env, number(op, "id"), number(op, "limit"))
            .map(|(closed, refunded)| json!({ "closed": closed, "refunded": refunded })),
        other => panic!("unknown op {other}"),
    }
}

#[test]
fn rust_rules_match_the_javascript_engine() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
    let scenarios = fixture["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 10, "fixture looks truncated");
    let mut calls = 0;
    let mut rejected = 0;

    for scenario in scenarios {
        let name = text(scenario, "name");
        let mut env = MemEnv::default();

        for (i, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            env.now = op["t"].as_u64().unwrap();
            let at = format!("{name} call {i} {op}");
            match apply(&mut env, op) {
                Ok(value) => {
                    assert_eq!(op["ok"], json!(true), "Rust accepted, engine rejected: {at}");
                    let expected = op.get("value").cloned().unwrap_or(Value::Null);
                    assert_eq!(value, expected, "different return value: {at}");
                }
                Err(e) => {
                    assert_eq!(op["ok"], json!(false), "Rust rejected with {}, engine accepted: {at}", e.code);
                    assert_eq!(e.code, text(op, "code"), "different error code: {at}");
                    rejected += 1;
                }
            }
            assert_eq!(env.totals.vault.to_string(), text(op, "vault"), "different vault: {at}");
            assert_eq!(env.held(), env.totals.vault, "I1 broken: {at}");
            calls += 1;
        }

        let last = &scenario["final"];
        env.now = last["t"].as_u64().unwrap();
        assert_eq!(env.totals.vault.to_string(), text(last, "vault"), "{name}: final vault");
        for (id, expected) in last["accounts"].as_object().unwrap() {
            let got = serde_json::to_value(rules::account_view(&env, id)).unwrap();
            assert_eq!(&got, expected, "{name}: account {id}");
        }
        let campaigns = last["campaigns"].as_array().unwrap();
        assert_eq!(env.totals.campaigns as usize, campaigns.len(), "{name}: campaign count");
        for (id, expected) in campaigns.iter().enumerate() {
            let id = id as u32;
            let got = serde_json::to_value(rules::campaign_view(&env, id).unwrap()).unwrap();
            assert_eq!(&got, expected, "{name}: campaign {id}");
            let bids = serde_json::to_value(rules::bids_view(&env, id)).unwrap();
            assert_eq!(bids, last["bids"][id as usize], "{name}: bids of campaign {id}");
            let pledges = serde_json::to_value(rules::pledges_view(&env, id, 0, u32::MAX)).unwrap();
            assert_eq!(pledges, last["pledges"][id as usize], "{name}: pledges of campaign {id}");
        }
    }
    println!("replayed {calls} calls ({rejected} rejected) across {} scenarios", scenarios.len());
    assert!(calls > 1500 && rejected > 300, "fixture should exercise both accepted and rejected calls");
}

#[test]
fn every_closed_campaign_holds_nothing() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    for scenario in fixture["scenarios"].as_array().unwrap() {
        let mut env = MemEnv::default();
        for op in scenario["ops"].as_array().unwrap() {
            env.now = op["t"].as_u64().unwrap();
            let _ = apply(&mut env, op);
        }
        for c in env.campaigns.values() {
            if c.closed && c.status == rules::Status::Failed {
                assert!(c.bonus_paid <= c.bond, "I3: bonuses never exceed the bond");
                assert_eq!(c.refunded_upto, c.backer_count, "I5: every backer was refunded");
            }
        }
        if env.campaigns.values().all(|c| c.closed) {
            let free: u128 = env.accounts.values().map(|a| a.balance).sum();
            assert_eq!(free, env.totals().vault, "I5: with everything closed, all money is free");
        }
    }
}
