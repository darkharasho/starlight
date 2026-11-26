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

const SPEED_32: &str = "Game speed doesn't work with 32-bit games yet.";

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

fn alive_with_gold(c: &mut Client, h: &Value, t: &Target) {
    let r = c.call("read", json!({"handle": h, "address": t.addr("gold"), "length": 4})).unwrap();
    assert_eq!(r["bytes"], "d2040000");
}

fn hexv(v: &Value) -> u64 {
    u64::from_str_radix(v.as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
}

#[test]
fn alloc_on_i386_target_works() {
    let t = Target::spawn32(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("alloc", json!({"handle": h, "size": 4096})).unwrap();
    let a = hexv(&r["address"]);
    assert!(a < 0x1_0000_0000, "{a:#x}");
    let at = format!("{a:#x}");
    c.call("write", json!({"handle": h, "address": at, "bytes": "deadbeef"})).unwrap();
    assert_eq!(c.call("read", json!({"handle": h, "address": at, "length": 4})).unwrap()["bytes"], "deadbeef");
    c.call("free", json!({"handle": h, "address": at})).unwrap();
    alive_with_gold(&mut c, &h, &t);
}

#[test]
fn i386_alloc_twice_reuses_cached_site() {
    let t = Target::spawn32(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let a = hexv(&c.call("alloc", json!({"handle": h, "size": 4096})).unwrap()["address"]);
    let near = format!("{:#x}", hexv(&json!(t.addr("gold"))));
    let b = hexv(&c.call("alloc", json!({"handle": h, "size": 8192, "near": near})).unwrap()["address"]);
    assert!(a != b && b < 0x1_0000_0000);
    alive_with_gold(&mut c, &h, &t);
}

#[test]
fn guard_speed_on_i386_target_is_refused() {
    let t = Target::spawn32(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let e = c.call_timeout("speed_set", json!({"handle": h, "speed": 2.0}), std::time::Duration::from_secs(15)).unwrap_err();
    assert_eq!(e, (-32015, SPEED_32.to_string()));
    let e = c.call("speed_get", json!({"handle": h})).unwrap_err();
    assert_eq!(e.0, -32015);
    alive_with_gold(&mut c, &h, &t);
}

#[test]
fn guard_alloc_on_64_bit_target_unchanged() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    c.call("alloc", json!({"handle": h, "size": 4096})).unwrap();
}

#[test]
fn guard_unknown_code_bits_is_not_ready() {
    // A 64-bit process whose named game exe isn't mapped: bitness unknown.
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = c.call("attach", json!({"pid": t.pid, "main_module": "game.exe"})).unwrap()["handle"].clone();
    let not_ready = (-32016, "The game is still starting; try again in a moment.".to_string());
    assert_eq!(c.call("alloc", json!({"handle": h, "size": 4096})).unwrap_err(), not_ready);
    assert_eq!(c.call("speed_get", json!({"handle": h})).unwrap_err(), not_ready);
    // Plain reads keep working.
    c.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap();
}

#[test]
fn i386_pointer_chain() {
    let t = Target::spawn32(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call("resolve_pointer", json!({"handle": h, "base": t.addr("p1"), "offsets": ["0x0", "0x0"]})).unwrap();
    assert_eq!(u64::from_str_radix(r["address"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap(),
               u64::from_str_radix(t.addr("gold").trim_start_matches("0x"), 16).unwrap());
    // An explicit size overrides; anything but 4 or 8 is invalid.
    let e = c.call("resolve_pointer", json!({"handle": h, "base": t.addr("p1"), "offsets": ["0x0"], "pointer_size": 2})).unwrap_err();
    assert_eq!(e.0, -32602);
}
