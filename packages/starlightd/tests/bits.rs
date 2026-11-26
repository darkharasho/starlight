mod common;
use common::*;
use serde_json::{json, Value};

fn facts(v: &Value) -> (Value, Value) {
    (v["process_bits"].clone(), v["code_bits"].clone())
}

#[test]
fn attach_64_bit_target() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let r = c.call("attach", json!({"pid": t.pid})).unwrap();
    assert_eq!(facts(&r), (json!(64), json!(64)));
}

#[test]
fn attach_i386_target() {
    let t = Target::spawn32(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let r = c.call("attach", json!({"pid": t.pid})).unwrap();
    // No PE module: code_bits falls back to process_bits.
    assert_eq!(facts(&r), (json!(32), json!(32)));
}

#[test]
fn attach_waits_for_a_named_main_module() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let r = c.call("attach", json!({"pid": t.pid, "main_module": "game.exe"})).unwrap();
    assert_eq!(facts(&r), (json!(64), Value::Null));
}

#[test]
fn process_info_matches_attach() {
    let d = Daemon::start();
    let mut c = d.client();
    for t in [Target::spawn(&[]), Target::spawn32(&[])] {
        let a = c.call("attach", json!({"pid": t.pid})).unwrap();
        let p = c.call("process_info", json!({"pid": t.pid})).unwrap();
        assert_eq!(facts(&a), facts(&p));
    }
}

#[test]
fn target_info_after_attach() {
    let t = Target::spawn32(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let a = c.call("attach", json!({"pid": t.pid})).unwrap();
    let i = c.call("target_info", json!({"handle": a["handle"]})).unwrap();
    assert_eq!(facts(&i), (json!(32), json!(32)));
}

#[test]
fn capabilities_include_bits() {
    let d = Daemon::start();
    let mut c = d.client();
    let h = c.call("hello", json!({})).unwrap();
    assert!(h["capabilities"].as_array().unwrap().iter().any(|v| v == "bits"));
}
