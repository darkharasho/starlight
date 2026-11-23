//! Game speed on native games (Task 11). Every test launches its own C test target and daemon.
//!
//! These tests are timing-sensitive: each measures how fast the target's clock values advance
//! over one real second. The measuring tests hold `SERIAL` (ruling R15) so a plain
//! `cargo test` is reliable; when running only this file, `-- --test-threads=2` is enough.
mod common;
use common::*;
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

static SERIAL: Mutex<()> = Mutex::new(());

/// Serializes the rate measurements (a failed test must not block the others).
fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn hex(s: &str) -> u64 {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

fn speed_set(c: &mut Client, h: &Value, speed: f64) -> Result<Value, (i64, String)> {
    c.call_timeout("speed_set", json!({"handle": h, "speed": speed}), Duration::from_secs(15))
}

fn speed_set_targets(c: &mut Client, h: &Value, speed: f64, targets: Value) -> Result<Value, (i64, String)> {
    c.call_timeout("speed_set", json!({"handle": h, "speed": speed, "targets": targets}), Duration::from_secs(15))
}

fn speed_get(c: &mut Client, h: &Value) -> Value {
    c.call_timeout("speed_get", json!({"handle": h}), Duration::from_secs(15)).unwrap()
}

/// The status of the hook named `name` in a `speed_set`/`speed_get` result.
fn hook_status(r: &Value, name: &str) -> Option<String> {
    r["hooks"].as_array()?.iter().find(|h| h["name"] == name).map(|h| h["status"].as_str().unwrap().to_string())
}

/// Read the target's memory straight from `/proc/<pid>/mem`, without any daemon.
fn proc_read(pid: i32, addr: u64, len: usize) -> Vec<u8> {
    use std::os::unix::fs::FileExt;
    let f = std::fs::File::open(format!("/proc/{pid}/mem")).unwrap();
    let mut buf = vec![0u8; len];
    f.read_exact_at(&mut buf, addr).unwrap();
    buf
}

fn proc_i64(pid: i32, addr: u64) -> i64 {
    i64::from_le_bytes(proc_read(pid, addr, 8).try_into().unwrap())
}

/// How fast the value at `addr` advances, in `unit_per_s` units per real second, measured over
/// one second of the test's own clock.
fn rate(pid: i32, addr: u64, unit_per_s: f64) -> f64 {
    let (v0, t0) = (proc_i64(pid, addr), Instant::now());
    std::thread::sleep(Duration::from_secs(1));
    let (v1, t1) = (proc_i64(pid, addr), Instant::now());
    (v1 - v0) as f64 / (t1 - t0).as_secs_f64() / unit_per_s
}

fn assert_rate(pid: i32, addr: u64, unit_per_s: f64, lo: f64, hi: f64, what: &str) -> f64 {
    let r = rate(pid, addr, unit_per_s);
    eprintln!("measured rate of {what}: {r:.3}");
    assert!((lo..=hi).contains(&r), "{what} advances at {r:.3}x, expected {lo}..={hi}");
    r
}

fn tracer_pid(pid: i32) -> i32 {
    let s = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    s.lines().find_map(|l| l.strip_prefix("TracerPid:")).unwrap().trim().parse().unwrap()
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

/// Lets the clocks thread store a value read through the (new) hooks.
fn settle() {
    std::thread::sleep(Duration::from_millis(100));
}

#[test]
fn hello_lists_speed_capability() {
    let d = Daemon::start();
    let mut c = d.client();
    let caps = c.call("hello", json!({})).unwrap()["capabilities"].clone();
    assert!(caps.as_array().unwrap().iter().any(|v| v == "speed"), "{caps}");
}

#[test]
fn native_speed_2_doubles_monotonic_and_gettimeofday() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = speed_set(&mut c, &h, 2.0).unwrap();
    assert_eq!(r["speed"], 2.0, "{r}");
    assert_eq!(hook_status(&r, "clock_gettime").as_deref(), Some("hooked"), "{r}");
    assert_eq!(hook_status(&r, "gettimeofday").as_deref(), Some("hooked"), "{r}");
    settle();
    assert_rate(t.pid, hex(&t.addr("g_mono_ns")), 1e9, 1.8, 2.2, "CLOCK_MONOTONIC at 2x");
    assert_rate(t.pid, hex(&t.addr("g_tod_us")), 1e6, 1.8, 2.2, "gettimeofday at 2x");
    // speed_get reports the same state.
    let g = speed_get(&mut c, &h);
    assert_eq!(g["speed"], 2.0, "{g}");
    assert_eq!(hook_status(&g, "clock_gettime").as_deref(), Some("hooked"), "{g}");
}

#[test]
fn speed_change_keeps_time_continuous() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let mono = hex(&t.addr("g_mono_ns"));
    speed_set(&mut c, &h, 2.0).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    // Change the speed while sampling the clock every 20 ms for a second.
    let id = c.send("speed_set", json!({"handle": h, "speed": 0.5}));
    let mut samples = vec![proc_i64(t.pid, mono)];
    let end = Instant::now() + Duration::from_secs(1);
    while Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
        samples.push(proc_i64(t.pid, mono));
    }
    let r = c.wait_response(id, Duration::from_secs(15)).expect("speed_set 0.5 answered").unwrap();
    assert_eq!(r["speed"], 0.5, "{r}");
    for w in samples.windows(2) {
        assert!(w[1] >= w[0], "CLOCK_MONOTONIC went backwards across the change: {} -> {}", w[0], w[1]);
        // 20 ms of real time is at most 40 ms of game time here; allow scheduling slack, but a
        // rebase bug (a jump to real time) is far larger.
        assert!(w[1] - w[0] < 300_000_000, "CLOCK_MONOTONIC jumped {} ns across the change", w[1] - w[0]);
    }
    assert_rate(t.pid, mono, 1e9, 0.45, 0.55, "CLOCK_MONOTONIC at 0.5x");
}

#[test]
fn speed_1_restores_original_bytes() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("libc_clock_gettime"));
    let before = proc_read(t.pid, f, 16);
    speed_set(&mut c, &h, 2.0).unwrap();
    assert_ne!(proc_read(t.pid, f, 16), before, "clock_gettime was not hooked");
    let r = speed_set(&mut c, &h, 1.0).unwrap();
    assert_eq!(r["speed"], 1.0, "{r}");
    assert_eq!(r["hooks"], json!([]), "{r}");
    assert_eq!(proc_read(t.pid, f, 16), before, "speed 1.0 did not restore clock_gettime");
    // Nothing needs the game traced any more (ruling R12).
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced at speed 1.0");
    settle();
    assert_rate(t.pid, hex(&t.addr("g_mono_ns")), 1e9, 0.9, 1.1, "CLOCK_MONOTONIC at 1x");
    assert_rate(t.pid, hex(&t.addr("g_tod_us")), 1e6, 0.9, 1.1, "gettimeofday at 1x");
    let g = speed_get(&mut c, &h);
    assert_eq!((g["speed"].clone(), g["hooks"].clone()), (json!(1.0), json!([])), "{g}");
    // Hooking again after a revert works, and scales again.
    speed_set(&mut c, &h, 2.0).unwrap();
    settle();
    assert_rate(t.pid, hex(&t.addr("g_mono_ns")), 1e9, 1.8, 2.2, "CLOCK_MONOTONIC at 2x after a revert");
}

#[test]
fn nested_sysv_calls_scale_once() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let targets = json!([
        {"name": "clock_gettime", "address": t.addr("libc_clock_gettime"), "abi": "sysv", "kind": "clock_gettime"},
        {"name": "clock_wrapper", "address": t.addr("clock_wrapper"), "abi": "sysv", "kind": "clock_gettime"},
    ]);
    let r = speed_set_targets(&mut c, &h, 2.0, targets).unwrap();
    assert_eq!(hook_status(&r, "clock_gettime").as_deref(), Some("hooked"), "{r}");
    assert_eq!(hook_status(&r, "clock_wrapper").as_deref(), Some("hooked"), "{r}");
    assert_eq!(r["hooks"].as_array().unwrap().len(), 2, "only the given targets are hooked: {r}");
    settle();
    // clock_wrapper's hook calls clock_gettime's: scaled twice would be ~4x.
    assert_rate(t.pid, hex(&t.addr("g_wrapped_ns")), 1e9, 1.8, 2.2, "clock_wrapper at 2x");
    assert_rate(t.pid, hex(&t.addr("g_mono_ns")), 1e9, 1.8, 2.2, "CLOCK_MONOTONIC at 2x");
}

#[test]
fn signal_handler_clock_calls_do_not_deadlock() {
    // A signal handler that calls clock_gettime can interrupt its own thread while that thread
    // holds the hooks' spinlock. The hook must pass the call through instead of spinning forever.
    let _serial = serial();
    let t = Target::spawn(&["--clock-signals"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (loops, sigs) = (hex(&t.addr("g_clock_loops")), hex(&t.addr("g_clock_sigs")));
    speed_set(&mut c, &h, 2.0).unwrap();
    for round in 0..6 {
        let (l0, s0) = (proc_i64(t.pid, loops), proc_i64(t.pid, sigs));
        std::thread::sleep(Duration::from_millis(500));
        let (l1, s1) = (proc_i64(t.pid, loops), proc_i64(t.pid, sigs));
        assert!(l1 > l0 && s1 > s0, "round {round}: the clock loop or its signal handler stopped ({l0}->{l1}, {s0}->{s1})");
    }
    // Still hooked, and the game is still answering.
    assert_eq!(speed_get(&mut c, &h)["speed"], 2.0);
    assert_eq!(speed_set(&mut c, &h, 1.0).unwrap()["hooks"], json!([]));
}

#[test]
fn out_of_range_speed_is_32602() {
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("libc_clock_gettime"));
    let before = proc_read(t.pid, f, 16);
    for bad in [0.0, 0.05, 11.0, -2.0] {
        let e = speed_set(&mut c, &h, bad).unwrap_err();
        assert_eq!(e.0, -32602, "speed {bad}: {e:?}");
    }
    let e = c.call_timeout("speed_set", json!({"handle": h, "speed": "2"}), Duration::from_secs(5)).unwrap_err();
    assert_eq!(e.0, -32602, "{e:?}");
    assert_eq!(proc_read(t.pid, f, 16), before, "a rejected speed changed the game");
    assert_eq!(speed_get(&mut c, &h)["speed"], 1.0);
    // The range ends are allowed.
    for ok in [0.1, 10.0] {
        assert_eq!(speed_set(&mut c, &h, ok).unwrap()["speed"], ok);
    }
}

#[test]
fn unhookable_targets_are_skipped_or_32602() {
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    // `xor eax,eax; ret` is shorter than the entry jump.
    let tiny = t.addr("g_name");
    c.call("write", json!({"handle": h, "address": tiny, "bytes": "31c0c3"})).unwrap();
    let only_tiny = json!([{"name": "tiny", "address": tiny, "abi": "sysv", "kind": "clock_gettime"}]);
    let e = speed_set_targets(&mut c, &h, 2.0, only_tiny).unwrap_err();
    assert_eq!(e.0, -32602, "{e:?}");
    assert!(e.1.contains("can't be hooked") && e.1.contains("shorter than 5 bytes"), "{e:?}");
    assert_eq!(proc_read(t.pid, hex(&tiny), 3), [0x31, 0xc0, 0xc3]);
    assert_eq!(speed_get(&mut c, &h)["hooks"], json!([]));
    // With a hookable target too, speed applies and the other is reported with its reason.
    let both = json!([
        {"name": "tiny", "address": tiny, "abi": "sysv", "kind": "clock_gettime"},
        {"name": "clock_wrapper", "address": t.addr("clock_wrapper"), "abi": "sysv", "kind": "clock_gettime"},
    ]);
    let r = speed_set_targets(&mut c, &h, 2.0, both).unwrap();
    assert_eq!(hook_status(&r, "clock_wrapper").as_deref(), Some("hooked"), "{r}");
    assert_eq!(hook_status(&r, "tiny").as_deref(), Some("skipped"), "{r}");
    let tiny_hook = r["hooks"].as_array().unwrap().iter().find(|h| h["name"] == "tiny").unwrap().clone();
    assert!(tiny_hook["reason"].as_str().unwrap().contains("shorter than 5 bytes"), "{r}");
}

#[test]
fn live_hooks_of_another_session_are_left_alone() {
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let f = hex(&t.addr("libc_clock_gettime"));
    let before = proc_read(t.pid, f, 16);
    let (mut a, mut b) = (d.client(), d.client());
    let (ha, hb) = (attach(&mut a, &t), attach(&mut b, &t));
    speed_set(&mut a, &ha, 2.0).unwrap();
    let hooked = proc_read(t.pid, f, 16);
    assert_ne!(hooked, before);
    // B's orphan search must not take A's live state page for an orphan (ruling R6).
    assert_eq!(speed_get(&mut b, &hb)["speed"], 1.0);
    assert_eq!(proc_read(t.pid, f, 16), hooked, "B restored A's live hooks");
    // Two sessions scaling one game would stack.
    let e = speed_set(&mut b, &hb, 3.0).unwrap_err();
    assert_eq!(e.0, -32014, "{e:?}");
    assert_eq!(speed_get(&mut a, &ha)["speed"], 2.0);
    // Once A is back at 1.0, B may.
    speed_set(&mut a, &ha, 1.0).unwrap();
    assert_eq!(proc_read(t.pid, f, 16), before);
    let r = speed_set(&mut b, &hb, 3.0).unwrap();
    assert_eq!(hook_status(&r, "clock_gettime").as_deref(), Some("hooked"), "{r}");
}

#[test]
fn detach_restores_speed_hooks() {
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("libc_clock_gettime"));
    let before = proc_read(t.pid, f, 16);
    speed_set(&mut c, &h, 2.0).unwrap();
    assert_ne!(proc_read(t.pid, f, 16), before, "clock_gettime was not hooked");
    // Live speed hooks keep the game traced (ruling R12).
    assert_ne!(tracer_pid(t.pid), 0);
    c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10)).unwrap();
    assert_eq!(proc_read(t.pid, f, 16), before, "detach did not restore clock_gettime");
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced after detach");
    assert_eq!(unsafe { libc::kill(t.pid, 0) }, 0, "target died");
}

#[test]
fn stdin_eof_restores_speed_hooks() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let mut d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("libc_clock_gettime"));
    let before = proc_read(t.pid, f, 16);
    speed_set(&mut c, &h, 2.0).unwrap();
    assert_ne!(proc_read(t.pid, f, 16), before, "clock_gettime was not hooked");
    d.close_stdin();
    assert!(d.wait_exit(Duration::from_secs(3)).is_some(), "daemon did not exit within 3 s of stdin EOF");
    assert_eq!(proc_read(t.pid, f, 16), before, "stdin EOF did not restore clock_gettime");
    assert_eq!(unsafe { libc::kill(t.pid, 0) }, 0, "target died");
    settle();
    assert_rate(t.pid, hex(&t.addr("g_tod_us")), 1e6, 0.9, 1.1, "gettimeofday after stdin EOF");
}

#[test]
fn orphaned_hooks_are_recovered() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let f = hex(&t.addr("libc_clock_gettime"));
    let mono = hex(&t.addr("g_mono_ns"));
    let before = proc_read(t.pid, f, 16);
    let mut a = Daemon::start();
    {
        let mut c = a.client();
        let h = attach(&mut c, &t);
        speed_set(&mut c, &h, 2.0).unwrap();
        // SIGKILL daemon A (only the daemon this test launched): nothing can run its teardown.
        a.kill();
    }
    assert_ne!(proc_read(t.pid, f, 16), before, "the hooks should survive a SIGKILLed daemon");
    assert!(wait_until(Duration::from_secs(2), || tracer_pid(t.pid) == 0), "A's ptrace attach outlived it");
    settle();
    assert_rate(t.pid, mono, 1e9, 1.8, 2.2, "CLOCK_MONOTONIC with orphaned hooks");
    let b = Daemon::start();
    let mut c = b.client();
    let h = attach(&mut c, &t);
    let g = speed_get(&mut c, &h);
    assert_eq!((g["speed"].clone(), g["hooks"].clone()), (json!(1.0), json!([])), "{g}");
    assert_eq!(proc_read(t.pid, f, 16), before, "daemon B did not restore the orphaned hooks");
    settle();
    assert_rate(t.pid, mono, 1e9, 0.9, 1.1, "CLOCK_MONOTONIC after recovery");
    assert_rate(t.pid, hex(&t.addr("g_tod_us")), 1e6, 0.9, 1.1, "gettimeofday after recovery");
    assert_eq!(unsafe { libc::kill(t.pid, 0) }, 0, "target died");
}
