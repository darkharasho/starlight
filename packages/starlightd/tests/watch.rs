mod common;
use common::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn hex(s: &str) -> u64 {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

fn watch_start(c: &mut Client, params: Value) -> Result<Value, (i64, String)> {
    c.call_timeout("watch_start", params, Duration::from_secs(10))
}

fn watch_stop(c: &mut Client, id: &Value) -> Value {
    c.call_timeout("watch_stop", json!({"id": id}), Duration::from_secs(10)).unwrap()
}

fn tracer_pid(pid: i32) -> i32 {
    let s = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    s.lines().find_map(|l| l.strip_prefix("TracerPid:")).unwrap().trim().parse().unwrap()
}

/// The process state letter from /proc/<pid>/stat (`Z` once it died, e.g. of a stray SIGTRAP).
fn proc_state(pid: i32) -> char {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    stat.rsplit_once(')').and_then(|(_, r)| r.trim_start().chars().next()).unwrap_or('X')
}

fn thread_count(pid: i32) -> usize {
    std::fs::read_dir(format!("/proc/{pid}/task")).unwrap().count()
}

fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if f() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The next `watch_ended` notification within `timeout` (skipping others such as `process_exited`).
fn watch_ended(c: &mut Client, timeout: Duration) -> Option<Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let n = c.next_notification(left)?;
        if n["method"] == "watch_ended" {
            return Some(n["params"].clone());
        }
    }
}

fn read_i32(c: &mut Client, h: &Value, addr: &str) -> i32 {
    let b = c.call("read", json!({"handle": h, "address": addr, "length": 4})).unwrap()["bytes"].as_str().unwrap().to_string();
    let bytes: Vec<u8> = (0..8).step_by(2).map(|i| u8::from_str_radix(&b[i..i + 2], 16).unwrap()).collect();
    i32::from_le_bytes(bytes.try_into().unwrap())
}

#[test]
fn hello_lists_watch_capability() {
    let d = Daemon::start();
    let mut c = d.client();
    let caps = c.call("hello", json!({})).unwrap()["capabilities"].clone();
    assert!(caps.as_array().unwrap().iter().any(|v| v == "watch"), "{caps}");
}

#[test]
fn write_watch_reports_bump_counter() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = watch_start(&mut c, json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write", "duration_ms": 1000}))
        .unwrap();
    let id = r["id"].clone();
    std::thread::sleep(Duration::from_millis(400));
    let rep = watch_stop(&mut c, &id);
    assert_eq!(rep["active"], false);
    assert_eq!(rep["reason"], "stopped");
    let hits = rep["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "one writing instruction: {rep}");
    let hit = &hits[0];
    let bump = hex(&t.addr("bump_counter"));
    let (addr, next) = (hex(hit["address"].as_str().unwrap()), hex(hit["next"].as_str().unwrap()));
    assert!(addr >= bump && addr < bump + 64, "address {addr:#x} not in bump_counter {bump:#x}");
    assert!(next > addr && next - addr <= 15, "next {next:#x} is not right after {addr:#x}");
    assert!(hit["module"].as_str().unwrap().starts_with("target+0x"), "{hit}");
    assert!(hit["count"].as_u64().unwrap() >= 3, "{hit}");
    assert!(hit["text"].as_str().unwrap().contains('['), "{hit}");
    assert_eq!(hit["registers"]["rip"], hit["next"]);
    for r in ["rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp", "r8", "r15", "eflags"] {
        assert!(hit["registers"][r].as_str().is_some_and(|v| v.starts_with("0x")), "{r}: {hit}");
    }
    // The decoded instruction is the store itself: it ends exactly at `next`.
    let dis = c.call("disassemble", json!({"handle": h, "address": hit["address"], "count": 1})).unwrap();
    assert_eq!(dis["instructions"][0]["length"].as_u64().unwrap(), next - addr);
    // Stopped by the client: no watch_ended notification.
    assert!(watch_ended(&mut c, Duration::from_millis(300)).is_none());
    // The id is gone after watch_stop.
    assert_eq!(c.call("watch_poll", json!({"id": id})).unwrap_err().0, -32009);
}

#[test]
fn access_watch_reports_reads_too() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    // Nothing writes g_health; the main loop only reads it once a second.
    let id = watch_start(&mut c, json!({"handle": h, "address": t.addr("g_health"), "size": 4, "kind": "access", "duration_ms": 5000}))
        .unwrap()["id"]
        .clone();
    let mut last = Value::Null;
    let got = wait_until(Duration::from_millis(1500), || {
        last = c.call("watch_poll", json!({"id": id})).unwrap();
        !last["hits"].as_array().unwrap().is_empty()
    });
    assert!(got, "no access reported within 1.5 s: {last}");
    assert_eq!(last["active"], true);
    assert_eq!(last["reason"], Value::Null);
    assert!(last["hits"][0]["module"].as_str().unwrap().starts_with("target+0x"), "{last}");
    watch_stop(&mut c, &id);
}

#[test]
fn late_thread_hits_are_reported() {
    let t = Target::spawn(&["--late-writer", "1000"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let id = watch_start(&mut c, json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write", "duration_ms": 5000}))
        .unwrap()["id"]
        .clone();
    assert_eq!(thread_count(t.pid), 1, "the writer thread must not exist yet when the watch starts");
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(thread_count(t.pid), 2, "the writer thread should exist by now");
    let rep = watch_stop(&mut c, &id);
    let hits = rep["hits"].as_array().unwrap();
    assert!(!hits.is_empty(), "the thread created after watch_start was not watched: {rep}");
    let bump = hex(&t.addr("bump_counter"));
    let addr = hex(hits[0]["address"].as_str().unwrap());
    assert!(addr >= bump && addr < bump + 64, "{rep}");
}

#[test]
fn watch_times_out_and_notifies() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let started = Instant::now();
    let id = watch_start(&mut c, json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write", "duration_ms": 300}))
        .unwrap()["id"]
        .clone();
    let n = watch_ended(&mut c, Duration::from_secs(1)).expect("no watch_ended within 1 s");
    assert!(started.elapsed() >= Duration::from_millis(300), "ended before its deadline");
    assert_eq!(n["id"], id);
    assert_eq!(n["reason"], "timeout");
    let p = c.call("watch_poll", json!({"id": id})).unwrap();
    assert_eq!(p["active"], false);
    assert_eq!(p["reason"], "timeout");
    assert!(!p["hits"].as_array().unwrap().is_empty(), "the hits collected before the timeout are kept");
    // A timed-out watch leaves the game untraced (the watch was the only tracer user).
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0));
}

#[test]
fn max_hits_ends_a_busy_watch_and_the_game_survives() {
    // --spin stores to g_spin_calls in a tight loop: hits arrive as fast as ptrace can take them.
    let t = Target::spawn(&["--spin"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let id = watch_start(&mut c, json!({"handle": h, "address": t.addr("g_spin_calls"), "size": 8, "kind": "write", "max_hits": 50}))
        .unwrap()["id"]
        .clone();
    let n = watch_ended(&mut c, Duration::from_secs(2)).expect("no watch_ended at max_hits");
    assert_eq!(n["id"], id);
    assert_eq!(n["reason"], "max_hits");
    let p = c.call("watch_poll", json!({"id": id})).unwrap();
    let total: u64 = p["hits"].as_array().unwrap().iter().map(|h| h["count"].as_u64().unwrap()).sum();
    assert_eq!(total, 50, "{p}");
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0));
    std::thread::sleep(Duration::from_millis(200));
    assert!(!matches!(proc_state(t.pid), 'Z' | 'X'), "a hit's SIGTRAP reached the game");
}

#[test]
fn watch_ends_when_target_exits() {
    let mut t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let id = watch_start(&mut c, json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write"}))
        .unwrap()["id"]
        .clone();
    t.kill();
    let n = watch_ended(&mut c, Duration::from_secs(2)).expect("no watch_ended after the target exited");
    assert_eq!(n["id"], id);
    assert_eq!(n["reason"], "process_exited");
    let p = c.call("watch_poll", json!({"id": id})).unwrap();
    assert_eq!(p["active"], false);
    assert_eq!(p["reason"], "process_exited");
}

#[test]
fn closing_connection_clears_watch_and_detaches() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut a = d.client();
    let h = attach(&mut a, &t);
    watch_start(&mut a, json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write", "duration_ms": 10000}))
        .unwrap();
    assert_ne!(tracer_pid(t.pid), 0, "a live watch keeps the game traced");
    drop(a);
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced 1 s after the connection closed");
    std::thread::sleep(Duration::from_millis(500));
    // A debug register left armed would SIGTRAP the writer on its next store and kill the game.
    assert!(!matches!(proc_state(t.pid), 'Z' | 'X'), "target died after the watch was torn down");
    let mut b = d.client();
    let hb = attach(&mut b, &t);
    let before = read_i32(&mut b, &hb, &t.addr("g_counter"));
    std::thread::sleep(Duration::from_millis(200));
    assert!(read_i32(&mut b, &hb, &t.addr("g_counter")) > before, "the writer stopped writing");
}

#[test]
fn detach_ends_watch_as_detached() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let id = watch_start(&mut c, json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write"}))
        .unwrap()["id"]
        .clone();
    c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10)).unwrap();
    let n = watch_ended(&mut c, Duration::from_secs(1)).expect("no watch_ended after detach");
    assert_eq!(n["id"], id);
    assert_eq!(n["reason"], "detached");
    assert_eq!(tracer_pid(t.pid), 0);
}

#[test]
fn fifth_watch_is_busy() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let w = |c: &mut Client, addr: String, size: u64| {
        watch_start(c, json!({"handle": h, "address": addr, "size": size, "kind": "write", "duration_ms": 10000}))
    };
    let mut ids = vec![];
    for (name, size) in [("g_health", 4), ("g_counter", 4), ("g_souls", 8), ("g_byte", 1)] {
        ids.push(w(&mut c, t.addr(name), size).unwrap()["id"].clone());
    }
    let e = w(&mut c, t.addr("g_pi"), 8).unwrap_err();
    assert_eq!(e.0, -32013, "{e:?}");
    // The four slots are per process, not per connection.
    let mut other = d.client();
    let h2 = attach(&mut other, &t);
    let e = watch_start(&mut other, json!({"handle": h2, "address": t.addr("g_pi"), "size": 8, "kind": "write"})).unwrap_err();
    assert_eq!(e.0, -32013, "{e:?}");
    // Stopping one frees its slot.
    watch_stop(&mut c, &ids[0]);
    assert!(w(&mut c, t.addr("g_pi"), 8).is_ok());
}

#[test]
fn misaligned_address_is_32602() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let counter = hex(&t.addr("g_counter"));
    let bad = [
        json!({"handle": h, "address": format!("{:#x}", counter + 1), "size": 4, "kind": "write"}),
        json!({"handle": h, "address": format!("{:#x}", counter + 2), "size": 8, "kind": "write"}),
        json!({"handle": h, "address": t.addr("g_counter"), "size": 3, "kind": "write"}),
        json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "execute"}),
        json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write", "duration_ms": 60001}),
        json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write", "max_hits": 0}),
    ];
    for p in bad {
        let e = watch_start(&mut c, p.clone()).unwrap_err();
        assert_eq!(e.0, -32602, "{p}: {e:?}");
    }
    // Nothing was armed by the refused requests: the game is not traced.
    assert_eq!(tracer_pid(t.pid), 0);
    assert_eq!(c.call("watch_poll", json!({"id": 1})).unwrap_err().0, -32009);
    // The same watch, aligned and with the longest duration, is accepted.
    let ok = json!({"handle": h, "address": t.addr("g_counter"), "size": 4, "kind": "write", "duration_ms": 60000});
    assert!(watch_start(&mut c, ok).is_ok());
}
