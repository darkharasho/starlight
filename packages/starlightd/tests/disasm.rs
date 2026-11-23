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

#[test]
fn signature_for_bump_counter_is_unique_and_scans_back() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("make_signature", json!({"handle": h, "address": t.addr("bump_counter")})).unwrap();
    assert_eq!(r["unique"], true);
    assert_eq!(r["matches"], 1);
    assert_eq!(r["offset"], 0);
    let pattern = r["pattern"].as_str().unwrap();
    assert_eq!(pattern.split_whitespace().count() as u64, r["length"].as_u64().unwrap());
    let s = c.call("aob_scan", json!({"handle": h, "module": r["module"], "pattern": pattern})).unwrap();
    assert_eq!(s["matches"], json!([t.addr("bump_counter")]));
}

#[test]
fn signature_wildcards_the_g_counter_displacement() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("make_signature", json!({"handle": h, "address": t.addr("bump_counter"), "max_length": 64})).unwrap();
    assert!(r["pattern"].as_str().unwrap().contains("??"), "pattern {}", r["pattern"]);
}

#[test]
fn signature_outside_modules_is_32005() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let err = c.call("make_signature", json!({"handle": h, "address": "0x1000"})).unwrap_err();
    assert_eq!(err.0, -32005);
}

#[test]
fn hello_lists_signature_capability() {
    let d = Daemon::start();
    let mut c = d.client();
    let r = c.call("hello", json!({})).unwrap();
    assert!(r["capabilities"].as_array().unwrap().iter().any(|v| v == "signature"));
}

#[test]
fn signature_too_short_to_be_unique_reports_matches() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("make_signature", json!({"handle": h, "address": t.addr("bump_counter"), "max_length": 1})).unwrap();
    assert_eq!(r["unique"], false);
    assert!(r["matches"].as_u64().unwrap() > 1, "matches {}", r["matches"]);
    // The non-unique pattern still matches at the requested address.
    let s = c.call("aob_scan", json!({"handle": h, "module": r["module"], "pattern": r["pattern"]})).unwrap();
    assert!(s["matches"].as_array().unwrap().iter().any(|a| *a == t.addr("bump_counter")));
}

#[test]
fn signature_max_length_out_of_range_is_32602() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    for bad in [0, 4097] {
        let err = c.call("make_signature", json!({"handle": h, "address": t.addr("bump_counter"), "max_length": bad})).unwrap_err();
        assert_eq!(err.0, -32602, "max_length {bad}");
    }
}

#[test]
fn round_trips_live_bump_counter() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("disassemble", json!({"handle": h, "address": t.addr("bump_counter"), "count": 8})).unwrap();
    let ins = r["instructions"].as_array().unwrap();
    assert_eq!(ins.len(), 8);
    for i in ins {
        let a = c
            .call("assemble", json!({"handle": h, "address": i["address"], "source": i["text"]}))
            .unwrap_or_else(|e| panic!("assemble {}: {e:?}", i["text"]));
        assert_eq!(a["bytes"], i["bytes"], "{}", i["text"]);
        assert_eq!(a["length"], i["length"], "{}", i["text"]);
    }
}

#[test]
fn assemble_resolves_module_symbols() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let mods = c.call("modules", json!({"handle": h})).unwrap();
    let base = mods["modules"].as_array().unwrap().iter().find(|m| m["name"] == "target").expect("target module")["base"].clone();
    let r = c.call("assemble", json!({"handle": h, "address": base, "source": "jmp target+10"})).unwrap();
    // Short jump from base to base+0x10.
    assert_eq!(r["bytes"], "eb0e");
    assert_eq!(r["length"], 2);
    // Supplied symbols, labels in the result, and no handle needed.
    let r = c
        .call("assemble", json!({"address": "0x1000", "source": "top:\nmov eax,[thing]\njmp top", "symbols": {"thing": "0x1100"}}))
        .unwrap();
    assert_eq!(r["bytes"], "8b05fa000000ebf8");
    assert_eq!(r["labels"], json!({"top": "0x1000"}));
    // Without a handle, module names don't resolve.
    let err = c.call("assemble", json!({"address": base, "source": "jmp target+10"})).unwrap_err();
    assert_eq!(err.0, -32010);
    assert!(err.1.starts_with("line 1:"), "{}", err.1);
}

#[test]
fn hello_lists_assemble_capability() {
    let d = Daemon::start();
    let mut c = d.client();
    let r = c.call("hello", json!({})).unwrap();
    assert!(r["capabilities"].as_array().unwrap().iter().any(|v| v == "assemble"));
}
