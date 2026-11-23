mod common;
use common::*;
use serde_json::{json, Value};

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

#[test]
fn finds_marker_in_target_module() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("aob_scan", json!({"handle": h, "module": "target", "pattern": "DE AD BE EF CA FE BA BE 12 34 56 78"})).unwrap();
    assert_eq!(r["matches"][0], t.addr("g_aob_marker").as_str());
}

#[test]
fn wildcards_match() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("aob_scan", json!({"handle": h, "module": "TARGET", "pattern": "DE AD BE EF ?? ?? BA BE"})).unwrap();
    assert!(!r["matches"].as_array().unwrap().is_empty());
}

#[test]
fn max_limits_results() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("aob_scan", json!({"handle": h, "module": "target", "pattern": "?? 00", "max": 3})).unwrap();
    assert_eq!(r["matches"].as_array().unwrap().len(), 3);
}

#[test]
fn unknown_module_is_32005() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let e = c.call("aob_scan", json!({"handle": h, "module": "nope.dll", "pattern": "DE AD"})).unwrap_err();
    assert_eq!(e.0, -32005);
}

#[test]
fn bad_pattern_is_32006() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let e = c.call("aob_scan", json!({"handle": h, "module": "target", "pattern": "DE ZZ"})).unwrap_err();
    assert_eq!(e.0, -32006);
}

#[test]
fn resolves_player_stats_hp_chain() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("resolve_pointer", json!({"handle": h, "base": t.addr("g_player_ptr"), "offsets": ["0x0", "0x0"]})).unwrap();
    let hp = c.call("read", json!({"handle": h, "address": r["address"], "length": 4})).unwrap();
    assert_eq!(hp["bytes"], "fa000000");
}

#[test]
fn module_relative_base_with_no_offsets_returns_base() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let mods = c.call("modules", json!({"handle": h})).unwrap();
    let m = mods["modules"].as_array().unwrap().iter().find(|m| m["name"] == "target").unwrap().clone();
    let base = u64::from_str_radix(m["base"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
    let r = c.call("resolve_pointer", json!({"handle": h, "module": "target", "base": "0x10", "offsets": []})).unwrap();
    assert_eq!(r["address"], format!("{:#x}", base + 0x10).as_str());
}

#[test]
fn unreadable_chain_step_is_32003() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let e = c.call("resolve_pointer", json!({"handle": h, "base": "0x8", "offsets": ["0x0"]})).unwrap_err();
    assert_eq!(e.0, -32003);
    assert!(e.1.contains("step 0"), "{}", e.1);
}
