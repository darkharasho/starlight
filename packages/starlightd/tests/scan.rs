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

#[test]
fn aob_scan_without_module_finds_code_in_executable_memory() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let sig = c.call("make_signature", json!({"handle": h, "address": t.addr("bump_counter")})).unwrap();
    assert_eq!(sig["unique"], true);
    let r = c.call("aob_scan", json!({"handle": h, "pattern": sig["pattern"]})).unwrap();
    assert_eq!(r["matches"][0], t.addr("bump_counter").as_str());
    // Address order across every executable region.
    let all: Vec<u64> = r["matches"].as_array().unwrap().iter()
        .map(|m| u64::from_str_radix(m.as_str().unwrap().trim_start_matches("0x"), 16).unwrap()).collect();
    assert!(all.windows(2).all(|w| w[0] < w[1]), "{all:x?}");
}

#[test]
fn aob_scan_without_module_skips_data() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("aob_scan", json!({"handle": h, "pattern": "DE AD BE EF CA FE BA BE 12 34 56 78"})).unwrap();
    assert_eq!(r["matches"], json!([]));
    // The same pattern is found in the module (data included).
    let r = c.call("aob_scan", json!({"handle": h, "module": "target", "pattern": "DE AD BE EF CA FE BA BE 12 34 56 78"})).unwrap();
    assert_eq!(r["matches"][0], t.addr("g_aob_marker").as_str());
}

#[test]
fn aob_scan_without_module_skips_the_daemons_hook_pages() {
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let func = t.addr("clock_wrapper");
    let targets = json!([{"name": "clock_wrapper", "address": func, "abi": "sysv", "kind": "clock_gettime"}]);
    c.call_timeout("speed_set", json!({"handle": h, "speed": 2.0, "targets": targets}), std::time::Duration::from_secs(15)).unwrap();
    // The hooked entry is `jmp <hook page>`; a pattern of the page's own bytes must not match there.
    let ins = c.call("disassemble", json!({"handle": h, "address": func, "count": 1})).unwrap();
    let page = ins["instructions"][0]["target"]["address"].as_str().expect("entry jmp target").to_string();
    let hex = |s: &str| u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap();
    let bytes = c.call("read", json!({"handle": h, "address": page, "length": 24})).unwrap()["bytes"].as_str().unwrap().to_string();
    let pattern: Vec<String> = (0..bytes.len()).step_by(2).map(|i| bytes[i..i + 2].to_string()).collect();
    let r = c.call("aob_scan", json!({"handle": h, "pattern": pattern.join(" ")})).unwrap();
    let p = hex(&page);
    for m in r["matches"].as_array().unwrap() {
        let a = hex(m.as_str().unwrap());
        assert!(!(p..p + 0x1000).contains(&a), "matched inside the daemon's hook page at {a:#x}");
    }
}

#[test]
fn hello_reports_protocol_3_and_aob_exec() {
    let d = Daemon::start();
    let mut c = d.client();
    let v = c.call("hello", json!({})).unwrap();
    assert_eq!(v["protocol"], 3);
    assert!(v["capabilities"].as_array().unwrap().iter().any(|x| x == "aob_exec"), "{v}");
}
