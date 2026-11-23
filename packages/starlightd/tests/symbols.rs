mod common;
use common::*;
use serde_json::{json, Value};

fn hex(s: &str) -> u64 {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

fn exports(c: &mut Client, h: &Value, module: &str) -> Vec<Value> {
    c.call("module_exports", json!({"handle": h, "module": module})).unwrap()["exports"].as_array().unwrap().clone()
}

#[test]
fn libc_exports_clock_gettime() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let list = exports(&mut c, &h, "libc.so.6");
    let e = list.iter().find(|e| e["name"] == "clock_gettime").expect("clock_gettime exported");
    assert_eq!(e["kind"], "func");
    assert!(hex(e["address"].as_str().unwrap()) > 0);
    assert!(e.get("forwarder").is_none());
}

#[test]
fn libc_gettimeofday_kind_is_ifunc_or_func() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let list = exports(&mut c, &h, "libc.so.6");
    let e = list.iter().find(|e| e["name"] == "gettimeofday").expect("gettimeofday exported");
    let kind = e["kind"].as_str().unwrap();
    assert!(kind == "ifunc" || kind == "func", "kind {kind}");
}

#[test]
fn resolve_symbol_matches_dlsym() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("resolve_symbol", json!({"handle": h, "module": "libc.so.6", "name": "clock_gettime"})).unwrap();
    assert_eq!(r["address"], t.addr("libc_clock_gettime"));
}

#[test]
fn unknown_symbol_is_32008() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let err = c.call("resolve_symbol", json!({"handle": h, "module": "libc.so.6", "name": "no_such_symbol_xyz"})).unwrap_err();
    assert_eq!(err.0, -32008);
    let err = c.call("resolve_symbol", json!({"handle": h, "module": "nope.dll", "name": "x"})).unwrap_err();
    assert_eq!(err.0, -32005);
}

#[test]
fn symbols_capability_is_advertised() {
    let d = Daemon::start();
    let mut c = d.client();
    let caps = c.call("hello", json!({})).unwrap()["capabilities"].clone();
    assert!(caps.as_array().unwrap().iter().any(|v| v == "symbols"), "{caps}");
}

#[test]
fn pe_export_from_mapped_file() {
    let dir = std::env::temp_dir().join(format!("starlightd-sym-{}/dir with space", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("Game.dll");
    let mut bytes = minimal_pe_with_exports(0x3000, &[("Foo", 0x1000), ("Bar", 0x1008)]);
    bytes.resize(0x3000, 0);
    std::fs::write(&path, bytes).unwrap();

    let t = Target::spawn(&["--map", path.to_str().unwrap()]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("resolve_symbol", json!({"handle": h, "module": "game.dll", "name": "Foo"})).unwrap();
    assert_eq!(hex(r["address"].as_str().unwrap()), hex(&t.addr("mapped")) + 0x1000);
    let list = exports(&mut c, &h, "Game.dll");
    let names: Vec<_> = list.iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Foo", "Bar"]);
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}
