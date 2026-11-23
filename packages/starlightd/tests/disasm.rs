mod common;
use common::*;
use serde_json::{json, Value};

fn hex(s: &str) -> u64 {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

#[test]
fn disassembles_bump_counter_with_symbol() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("disassemble", json!({"handle": h, "address": t.addr("bump_counter"), "count": 8})).unwrap();
    let ins = r["instructions"].as_array().unwrap();
    assert_eq!(ins.len(), 8);
    assert_eq!(ins[0]["address"], t.addr("bump_counter"));
    let sym = ins[0]["symbol"].as_str().expect("first instruction has a symbol");
    assert!(sym.starts_with("target+0x"), "symbol {sym}");
    let want = hex(&t.addr("g_counter"));
    let hit = ins
        .iter()
        .find(|i| i["text"].as_str().unwrap().contains('[') && i["target"]["address"].as_str().map(hex) == Some(want))
        .unwrap_or_else(|| panic!("no instruction references g_counter: {ins:?}"));
    assert!(hit["target"]["symbol"].as_str().unwrap().starts_with("target+0x"));
    // Lengths chain: each instruction starts where the previous one ended.
    for w in ins.windows(2) {
        assert_eq!(hex(w[0]["address"].as_str().unwrap()) + w[0]["length"].as_u64().unwrap(), hex(w[1]["address"].as_str().unwrap()));
    }
}

#[test]
fn count_over_500_is_32602() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let err = c.call("disassemble", json!({"handle": h, "address": t.addr("bump_counter"), "count": 501})).unwrap_err();
    assert_eq!(err.0, -32602);
}

#[test]
fn hello_lists_disasm_capability() {
    let d = Daemon::start();
    let mut c = d.client();
    let r = c.call("hello", json!({})).unwrap();
    assert!(r["capabilities"].as_array().unwrap().iter().any(|v| v == "disasm"));
}
