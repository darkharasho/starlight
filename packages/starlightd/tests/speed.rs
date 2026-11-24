//! Game speed on native games (Task 11) and with Win64 hooks (Task 12; the target's
//! `--win64-clocks` thread stands in for Wine's timing functions). Every test launches its own C test target and daemon.
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

/// Send `speed_set(speed)` while sampling the clock at `addr` every 20 ms for a second; returns
/// the samples. Asserts the change succeeded.
fn sample_across_change(c: &mut Client, h: &Value, pid: i32, addr: u64, speed: f64) -> Vec<i64> {
    let id = c.send("speed_set", json!({"handle": h, "speed": speed}));
    let mut samples = vec![proc_i64(pid, addr)];
    let end = Instant::now() + Duration::from_secs(1);
    while Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
        samples.push(proc_i64(pid, addr));
    }
    let r = c.wait_response(id, Duration::from_secs(15)).expect("speed_set answered").unwrap();
    assert_eq!(r["speed"], speed, "{r}");
    samples
}

/// The clock never goes back, and never jumps (20 ms of real time is at most 40 ms of game time
/// here; a rebase bug or a removed hook is a jump of the time gained, or back to real time).
fn assert_continuous(samples: &[i64], what: &str) {
    for w in samples.windows(2) {
        assert!(w[1] >= w[0], "{what} went backwards across the change: {} -> {}", w[0], w[1]);
        assert!(w[1] - w[0] < 300_000_000, "{what} jumped {} ns across the change", w[1] - w[0]);
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
    let samples = sample_across_change(&mut c, &h, t.pid, mono, 0.5);
    assert_continuous(&samples, "CLOCK_MONOTONIC");
    assert_rate(t.pid, mono, 1e9, 0.45, 0.55, "CLOCK_MONOTONIC at 0.5x");
}

#[test]
fn speed_1_never_turns_time_back() {
    // Speed 1.0 keeps the hooks: the game keeps the time it gained instead of jumping back.
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (mono, tod) = (hex(&t.addr("g_mono_ns")), hex(&t.addr("g_tod_us")));
    speed_set(&mut c, &h, 2.0).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let samples = sample_across_change(&mut c, &h, t.pid, mono, 1.0);
    assert_continuous(&samples, "CLOCK_MONOTONIC");
    // gettimeofday (the GOT route) keeps its gained time too.
    let ahead = proc_i64(t.pid, tod) - std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros() as i64;
    assert!(ahead > 200_000, "gettimeofday is only {ahead} us ahead of real time after 2x then 1x");
    assert_rate(t.pid, mono, 1e9, 0.9, 1.1, "CLOCK_MONOTONIC at 1x after 2x");
}

#[test]
fn speed_1_keeps_hooks_and_detach_restores_bytes() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    // Let the clocks thread call gettimeofday once, so its lazily bound GOT slot is resolved.
    settle();
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (f, got) = (hex(&t.addr("libc_clock_gettime")), hex(&t.addr("got_gettimeofday")));
    let (before, got_before) = (proc_read(t.pid, f, 16), proc_read(t.pid, got, 8));
    speed_set(&mut c, &h, 2.0).unwrap();
    let (hooked, got_hooked) = (proc_read(t.pid, f, 16), proc_read(t.pid, got, 8));
    assert_ne!(hooked, before, "clock_gettime was not hooked");
    assert_ne!(got_hooked, got_before, "the executable's gettimeofday GOT slot was not hooked");
    // 1.0 is a speed change like any other: the hooks stay.
    let r = speed_set(&mut c, &h, 1.0).unwrap();
    assert_eq!(r["speed"], 1.0, "{r}");
    assert_eq!(hook_status(&r, "clock_gettime").as_deref(), Some("hooked"), "{r}");
    assert_eq!((proc_read(t.pid, f, 16), proc_read(t.pid, got, 8)), (hooked.clone(), got_hooked.clone()));
    settle();
    assert_rate(t.pid, hex(&t.addr("g_mono_ns")), 1e9, 0.9, 1.1, "CLOCK_MONOTONIC at 1x");
    assert_rate(t.pid, hex(&t.addr("g_tod_us")), 1e6, 0.9, 1.1, "gettimeofday at 1x");
    let g = speed_get(&mut c, &h);
    assert_eq!(g["speed"], 1.0, "{g}");
    assert_eq!(hook_status(&g, "gettimeofday").as_deref(), Some("hooked"), "{g}");
    // Speeding up again reuses the same hooks.
    speed_set(&mut c, &h, 2.0).unwrap();
    assert_eq!((proc_read(t.pid, f, 16), proc_read(t.pid, got, 8)), (hooked, got_hooked), "the hooks were reinstalled");
    settle();
    assert_rate(t.pid, hex(&t.addr("g_mono_ns")), 1e9, 1.8, 2.2, "CLOCK_MONOTONIC at 2x after 1x");
    // Session end restores every original byte and lets go of the game.
    c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10)).unwrap();
    assert_eq!(proc_read(t.pid, f, 16), before, "detach did not restore clock_gettime");
    assert_eq!(proc_read(t.pid, got, 8), got_before, "detach did not restore the gettimeofday GOT slot");
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced after detach");
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
    assert_eq!(speed_set(&mut c, &h, 1.0).unwrap()["speed"], 1.0);
}

#[test]
fn a_thread_suspended_in_the_lock_does_not_hang_the_game() {
    // The target suspends a thread for 500 ms at a time inside a signal handler, as a GC's
    // stop-the-world does, possibly while it holds the hooks' lock. Another thread's
    // clock_gettime calls must keep returning (the spin gives up and passes the call through).
    let _serial = serial();
    let t = Target::spawn(&["--clock-stall"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (other, loops) = (hex(&t.addr("g_clock_other")), hex(&t.addr("g_clock_loops")));
    speed_set(&mut c, &h, 2.0).unwrap();
    let loops0 = proc_i64(t.pid, loops);
    for window in 0..16 {
        let o0 = proc_i64(t.pid, other);
        std::thread::sleep(Duration::from_millis(250));
        let o1 = proc_i64(t.pid, other);
        assert!(o1 > o0, "window {window}: clock_gettime hung while another thread was suspended ({o0} -> {o1})");
    }
    assert!(proc_i64(t.pid, loops) > loops0, "the suspended thread never resumed");
    assert_eq!(speed_get(&mut c, &h)["speed"], 2.0);
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
    // A at 1.0 still has its hooks in; once A detaches, B may.
    speed_set(&mut a, &ha, 1.0).unwrap();
    assert_eq!(speed_set(&mut b, &hb, 3.0).unwrap_err().0, -32014);
    a.call_timeout("detach", json!({"handle": ha}), Duration::from_secs(10)).unwrap();
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
    settle(); // the GOT slot is bound
    let (f, got) = (hex(&t.addr("libc_clock_gettime")), hex(&t.addr("got_gettimeofday")));
    let mono = hex(&t.addr("g_mono_ns"));
    let (before, got_before) = (proc_read(t.pid, f, 16), proc_read(t.pid, got, 8));
    let mut a = Daemon::start();
    {
        let mut c = a.client();
        let h = attach(&mut c, &t);
        speed_set(&mut c, &h, 2.0).unwrap();
        // SIGKILL daemon A (only the daemon this test launched): nothing can run its teardown.
        a.kill();
    }
    assert_ne!(proc_read(t.pid, f, 16), before, "the hooks should survive a SIGKILLed daemon");
    assert_ne!(proc_read(t.pid, got, 8), got_before, "the GOT hook should survive a SIGKILLed daemon");
    assert!(wait_until(Duration::from_secs(2), || tracer_pid(t.pid) == 0), "A's ptrace attach outlived it");
    settle();
    assert_rate(t.pid, mono, 1e9, 1.8, 2.2, "CLOCK_MONOTONIC with orphaned hooks");
    let b = Daemon::start();
    let mut c = b.client();
    let h = attach(&mut c, &t);
    let g = speed_get(&mut c, &h);
    assert_eq!((g["speed"].clone(), g["hooks"].clone()), (json!(1.0), json!([])), "{g}");
    assert_eq!(proc_read(t.pid, f, 16), before, "daemon B did not restore the orphaned hooks");
    assert_eq!(proc_read(t.pid, got, 8), got_before, "daemon B did not restore the gettimeofday GOT slot");
    settle();
    assert_rate(t.pid, mono, 1e9, 0.9, 1.1, "CLOCK_MONOTONIC after recovery");
    assert_rate(t.pid, hex(&t.addr("g_tod_us")), 1e6, 0.9, 1.1, "gettimeofday after recovery");
    assert_eq!(unsafe { libc::kill(t.pid, 0) }, 0, "target died");
}

/// A debug `targets` entry for one of the target's Win64 stand-ins.
fn win64(t: &Target, name: &str, kind: &str) -> Value {
    json!({"name": name, "address": t.addr(name), "abi": "win64", "kind": kind})
}

#[test]
fn win64_templates_scale_qpc_and_ticks() {
    let _serial = serial();
    let t = Target::spawn(&["--win64-clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let targets = json!([win64(&t, "fake_qpc", "qpc"), win64(&t, "fake_tick32", "tick32"), win64(&t, "fake_tick64", "tick64")]);
    let r = speed_set_targets(&mut c, &h, 2.0, targets).unwrap();
    for name in ["fake_qpc", "fake_tick32", "fake_tick64"] {
        assert_eq!(hook_status(&r, name).as_deref(), Some("hooked"), "{r}");
    }
    settle();
    assert_rate(t.pid, hex(&t.addr("g_w_qpc")), 1e7, 1.8, 2.2, "QPC (Win64) at 2x");
    assert_rate(t.pid, hex(&t.addr("g_w_tick32")), 1e3, 1.8, 2.2, "GetTickCount (Win64) at 2x");
    assert_rate(t.pid, hex(&t.addr("g_w_tick64")), 1e3, 1.8, 2.2, "GetTickCount64 (Win64) at 2x");
}

#[test]
fn nested_win64_calls_scale_once() {
    let _serial = serial();
    let t = Target::spawn(&["--win64-clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    // fake_time_get_time calls fake_qpc through a pointer: both hooked, the time is scaled once.
    let targets = json!([win64(&t, "fake_qpc", "qpc"), win64(&t, "fake_time_get_time", "tick32")]);
    let r = speed_set_targets(&mut c, &h, 2.0, targets).unwrap();
    assert_eq!(hook_status(&r, "fake_time_get_time").as_deref(), Some("hooked"), "{r}");
    settle();
    assert_rate(t.pid, hex(&t.addr("g_w_tgt")), 1e3, 1.8, 2.2, "timeGetTime (nested QPC) at 2x");
    assert_rate(t.pid, hex(&t.addr("g_w_qpc")), 1e7, 1.8, 2.2, "QPC (Win64) at 2x");
}

#[test]
fn qpc_success_follows_each_functions_return_convention() {
    // NtQueryPerformanceCounter returns an NTSTATUS (0 = success); QueryPerformanceCounter a BOOL
    // (0 = failure). Only successful calls are scaled.
    let _serial = serial();
    let t = Target::spawn(&["--win64-clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let targets = json!([win64(&t, "fake_nt_qpc", "nt_qpc"), win64(&t, "fake_qpc_fail", "qpc")]);
    let r = speed_set_targets(&mut c, &h, 2.0, targets).unwrap();
    assert_eq!(hook_status(&r, "fake_nt_qpc").as_deref(), Some("hooked"), "{r}");
    assert_eq!(hook_status(&r, "fake_qpc_fail").as_deref(), Some("hooked"), "{r}");
    settle();
    assert_rate(t.pid, hex(&t.addr("g_w_ntqpc")), 1e7, 1.8, 2.2, "NtQueryPerformanceCounter (STATUS_SUCCESS) at 2x");
    assert_rate(t.pid, hex(&t.addr("g_w_qpc_fail")), 1e7, 0.9, 1.1, "a failed QueryPerformanceCounter at 2x");
}

// ---- Absolute-time waits (M4 Task 3, D2): a deadline in game time is waited for in real time.

/// The wait functions the native targets hook, with the target's address listing for each.
const WAITS: [(&str, &str); 5] = [
    ("clock_nanosleep", "libc_clock_nanosleep"),
    ("pthread_cond_timedwait", "libc_pthread_cond_timedwait"),
    ("pthread_cond_clockwait", "libc_pthread_cond_clockwait"),
    ("sem_timedwait", "libc_sem_timedwait"),
    ("sem_clockwait", "libc_sem_clockwait"),
];

/// The target's `flag` thread waits until "now + 20 ms" (now read through the hooked
/// `clock_gettime`) with the hooked wait `hook`, and counts into `counter`: 50 per real second
/// at 1.0, 100 at 2.0, 25 at 0.5 (each ±25%). Without the wait hooks 2.0 stalls (the deadline is
/// ahead of real time by all the time gained) and 0.5 busy-loops (it is always in the past).
fn abstime_wait_follows_game_speed(flag: &str, counter: &str, hook: &str) {
    let _serial = serial();
    let t = Target::spawn(&[flag, "--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let n = hex(&t.addr(counter));
    settle();
    assert_rate(t.pid, n, 1.0, 37.5, 62.5, &format!("{counter} at 1x (unhooked)"));
    let r = speed_set(&mut c, &h, 2.0).unwrap();
    assert_eq!(hook_status(&r, hook).as_deref(), Some("hooked"), "{r}");
    settle();
    assert_rate(t.pid, n, 1.0, 75.0, 125.0, &format!("{counter} at 2x"));
    speed_set(&mut c, &h, 0.5).unwrap();
    settle();
    assert_rate(t.pid, n, 1.0, 18.75, 31.25, &format!("{counter} at 0.5x"));
    speed_set(&mut c, &h, 1.0).unwrap();
    settle();
    assert_rate(t.pid, n, 1.0, 37.5, 62.5, &format!("{counter} at 1x (hooked)"));
}

#[test]
fn abstime_sleep_follows_game_speed() {
    abstime_wait_follows_game_speed("--abs-sleep", "g_abs_sleeps", "clock_nanosleep");
}

#[test]
fn abstime_cond_wait_monotonic_follows_game_speed() {
    // The condvar's clock (MONOTONIC here) is read from glibc's internal layout.
    abstime_wait_follows_game_speed("--abs-cond", "g_abs_conds", "pthread_cond_timedwait");
}

#[test]
fn abstime_cond_wait_realtime_follows_game_speed() {
    abstime_wait_follows_game_speed("--abs-cond-rt", "g_abs_conds_rt", "pthread_cond_timedwait");
}

#[test]
fn abstime_sem_wait_follows_game_speed() {
    abstime_wait_follows_game_speed("--abs-sem", "g_abs_sems", "sem_timedwait");
}

fn proc_i32(pid: i32, addr: u64) -> i32 {
    i32::from_le_bytes(proc_read(pid, addr, 4).try_into().unwrap())
}

#[test]
fn relative_sleeps_are_untouched() {
    // usleep(50 ms) reaches clock_nanosleep without TIMER_ABSTIME: a relative wait is already
    // real time, so it stays 50 ms (D2 only translates absolute deadlines).
    let _serial = serial();
    let t = Target::spawn(&["--writer", "--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = speed_set(&mut c, &h, 2.0).unwrap();
    assert_eq!(hook_status(&r, "clock_nanosleep").as_deref(), Some("hooked"), "{r}");
    settle();
    let counter = hex(&t.addr("g_counter"));
    let (v0, t0) = (proc_i32(t.pid, counter), Instant::now());
    std::thread::sleep(Duration::from_secs(1));
    let (v1, t1) = (proc_i32(t.pid, counter), Instant::now());
    let rate = (v1 - v0) as f64 / (t1 - t0).as_secs_f64();
    eprintln!("measured rate of g_counter at 2x: {rate:.3}/s");
    assert!((15.0..=25.0).contains(&rate), "usleep(50 ms) loop runs {rate:.3}/s at 2x, expected about 20");
    assert_rate(t.pid, hex(&t.addr("g_mono_ns")), 1e9, 1.8, 2.2, "CLOCK_MONOTONIC at 2x");
}

#[test]
fn wait_hooks_are_listed_and_restored_on_detach() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let before: Vec<(u64, Vec<u8>)> = WAITS
        .iter()
        .map(|(_, a)| {
            let f = hex(&t.addr(a));
            (f, proc_read(t.pid, f, 16))
        })
        .collect();
    let r = speed_set(&mut c, &h, 2.0).unwrap();
    for ((name, _), (f, orig)) in WAITS.iter().zip(&before) {
        assert_eq!(hook_status(&r, name).as_deref(), Some("hooked"), "{name}: {r}");
        // The default version, the one dlsym (and a game's linker) picks, is the one hooked.
        let listed = r["hooks"].as_array().unwrap().iter().find(|x| x["name"] == *name).unwrap()["address"].clone();
        assert_eq!(hex(listed.as_str().unwrap()), *f, "{name}: {r}");
        assert_ne!(proc_read(t.pid, *f, 16), *orig, "{name} was not hooked");
    }
    c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10)).unwrap();
    for ((name, _), (f, orig)) in WAITS.iter().zip(&before) {
        assert_eq!(proc_read(t.pid, *f, 16), *orig, "detach did not restore {name}");
    }
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced after detach");
}

#[test]
fn many_waiting_threads_do_not_exhaust_the_nesting_table() {
    // 80 threads blocked in pthread_cond_timedwait at once: more than the 64 nesting entries. The
    // wait hooks hold an entry only while converting the deadline, never across the wait, so the
    // clock hooks still find a free entry and scale.
    let _serial = serial();
    let t = Target::spawn(&["--abs-cond-threads", "80", "--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = speed_set(&mut c, &h, 2.0).unwrap();
    assert_eq!(hook_status(&r, "pthread_cond_timedwait").as_deref(), Some("hooked"), "{r}");
    settle();
    assert_rate(t.pid, hex(&t.addr("g_mono_ns")), 1e9, 1.7, 2.3, "CLOCK_MONOTONIC at 2x with 80 waiting threads");
    // And the waiters keep waking (80 threads × 100/s at 2x; a stall would be near 0).
    let waits = rate(t.pid, hex(&t.addr("g_abs_conds")), 1.0);
    eprintln!("measured rate of g_abs_conds (80 threads) at 2x: {waits:.1}/s");
    assert!(waits > 6000.0, "80 waiting threads wake {waits:.1}/s at 2x, expected about 8000");
}

#[test]
fn abstime_wait_on_a_gettimeofday_deadline_follows_game_speed() {
    // gettimeofday + timeout, waited for on a REALTIME condvar: the game never calls
    // clock_gettime(REALTIME), so the wait converts through gettimeofday's slot.
    abstime_wait_follows_game_speed("--abs-cond-tod", "g_abs_conds_tod", "pthread_cond_timedwait");
}

#[test]
fn a_late_realtime_reader_keeps_gettimeofday_deadlines_right() {
    // gettimeofday runs at 2x for 1.5 s before anything reads clock_gettime(REALTIME). REALTIME
    // then starts from gettimeofday's game time (one clock), so the REALTIME wait, now converted
    // through REALTIME's slot, still gets gettimeofday's deadline right: about 100/s, not a
    // stall on the 0.75 s gained.
    let _serial = serial();
    let t = Target::spawn(&["--abs-cond-tod", "--late-realtime", "1500"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = speed_set(&mut c, &h, 2.0).unwrap();
    assert_eq!(hook_status(&r, "pthread_cond_timedwait").as_deref(), Some("hooked"), "{r}");
    let late = hex(&t.addr("g_late_rt"));
    assert!(wait_until(Duration::from_secs(5), || proc_i64(t.pid, late) != 0), "REALTIME was never read");
    settle();
    let n = hex(&t.addr("g_abs_conds_tod"));
    assert_rate(t.pid, n, 1.0, 75.0, 125.0, "g_abs_conds_tod at 2x after REALTIME's first read");
    // And the two clocks agree: REALTIME's game time is gettimeofday's (to within a few 20 ms steps).
    let ahead = proc_i64(t.pid, late) - std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as i64;
    assert!(ahead > 1_000_000_000, "REALTIME is only {ahead} ns ahead of real time; it should carry gettimeofday's gain");
}

#[test]
fn realtime_and_gettimeofday_change_speed_together() {
    // Both clocks read at 2.0. Then, with REALTIME unread (and the REALTIME waiter idle), the speed
    // goes to 1.0 and only gettimeofday is read for 1.2 s. REALTIME must still agree with
    // gettimeofday when it is read again (rebased together, not on its own next read, which would
    // leave it 1.2 s ahead for good), and a REALTIME wait on a gettimeofday deadline counts at
    // 1.0's rate instead of busy-looping on a deadline already past.
    let _serial = serial();
    let t = Target::spawn(&["--abs-cond-tod", "--pair-clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let set = |c: &mut Client, name: &str, on: bool| {
        c.call("write", json!({"handle": h, "address": t.addr(name), "bytes": if on { "01000000" } else { "00000000" }})).unwrap();
    };
    speed_set(&mut c, &h, 2.0).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    set(&mut c, "g_pair_rt_on", false);
    set(&mut c, "g_abs_tod_on", false);
    std::thread::sleep(Duration::from_millis(100));
    speed_set(&mut c, &h, 1.0).unwrap();
    std::thread::sleep(Duration::from_millis(1200));
    set(&mut c, "g_pair_rt_on", true);
    settle();
    let (tod, rt) = (hex(&t.addr("g_pair_tod_us")), hex(&t.addr("g_pair_rt_ns")));
    // Stored one right after the other; our two reads may straddle one 20 ms step.
    let gap_ms = (proc_i64(t.pid, rt) - proc_i64(t.pid, tod) * 1000) as f64 / 1e6;
    eprintln!("REALTIME - gettimeofday after the late read: {gap_ms:.3} ms");
    assert!(gap_ms.abs() < 25.0, "REALTIME and gettimeofday differ by {gap_ms:.3} ms after a speed change");
    set(&mut c, "g_abs_tod_on", true);
    settle();
    assert_rate(t.pid, hex(&t.addr("g_abs_conds_tod")), 1.0, 37.5, 62.5, "g_abs_conds_tod at 1x after the late REALTIME read");
}

// ---- Session-end landing (M4 Task 4, D3): the clock glides back onto real time before the hooks
// are removed, so detach neither steps it back nor forward.

/// CLOCK_MONOTONIC now, as the test (never hooked) sees it, in ns.
fn mono_now() -> i64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec * 1_000_000_000 + ts.tv_nsec
}

/// Detach `h` while a thread samples the i64 at `addr` every 20 ms, from just before the detach
/// until 200 ms after it returned. Returns the samples and how long the detach took.
fn detach_sampling(c: &mut Client, h: &Value, pid: i32, addr: u64) -> (Vec<i64>, Duration) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let stop = Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    let sampler = std::thread::spawn(move || {
        let mut v = vec![proc_i64(pid, addr)];
        while !s.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(20));
            v.push(proc_i64(pid, addr));
        }
        v
    });
    let t0 = Instant::now();
    c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10)).unwrap();
    let took = t0.elapsed();
    std::thread::sleep(Duration::from_millis(200));
    stop.store(true, Ordering::Relaxed);
    (sampler.join().unwrap(), took)
}

#[test]
fn detach_after_speed_up_never_turns_monotonic_time_back() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("libc_clock_gettime"));
    let before = proc_read(t.pid, f, 16);
    speed_set(&mut c, &h, 2.0).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    let (samples, took) = detach_sampling(&mut c, &h, t.pid, hex(&t.addr("g_mono_ns")));
    eprintln!("detach after 600 ms at 2x took {took:?}");
    for w in samples.windows(2) {
        assert!(w[1] >= w[0], "CLOCK_MONOTONIC went back across detach: {} -> {} ({} ns)", w[0], w[1], w[1] - w[0]);
    }
    assert!(took <= Duration::from_millis(1600), "detach took {took:?}");
    assert_eq!(proc_read(t.pid, f, 16), before, "detach did not restore clock_gettime");
}

#[test]
fn detach_after_slow_down_catches_up_without_a_jump() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    speed_set(&mut c, &h, 0.5).unwrap();
    std::thread::sleep(Duration::from_millis(1000));
    let (samples, took) = detach_sampling(&mut c, &h, t.pid, hex(&t.addr("g_mono_ns")));
    eprintln!("detach after 1000 ms at 0.5x took {took:?}");
    for w in samples.windows(2) {
        assert!(w[1] >= w[0], "CLOCK_MONOTONIC went back across detach: {} -> {}", w[0], w[1]);
        assert!(w[1] - w[0] <= 60_000_000, "CLOCK_MONOTONIC jumped {} ns across detach", w[1] - w[0]);
    }
    // Afterwards the game's clock is real time (stored right after it by raw syscall).
    let (game, raw) = (proc_i64(t.pid, hex(&t.addr("g_mono_ns"))), proc_i64(t.pid, hex(&t.addr("g_mono_raw_ns"))));
    assert!((game - raw).abs() <= 5_000_000, "CLOCK_MONOTONIC is {} ns off real time after detach", game - raw);
    assert!(mono_now() - raw < 1_000_000_000, "the clocks thread stopped");
}

#[test]
fn landing_is_bounded_when_the_gap_is_too_large() {
    let _serial = serial();
    let t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (f, got) = (hex(&t.addr("libc_clock_gettime")), hex(&t.addr("got_gettimeofday")));
    settle(); // the GOT slot is bound
    let (before, got_before) = (proc_read(t.pid, f, 16), proc_read(t.pid, got, 8));
    speed_set(&mut c, &h, 4.0).unwrap();
    // About 3 s ahead: more than the glide can close in LAND_MAX_MS.
    std::thread::sleep(Duration::from_millis(1000));
    let t0 = Instant::now();
    c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10)).unwrap();
    let took = t0.elapsed();
    eprintln!("detach 3 s ahead took {took:?}");
    assert!(took <= Duration::from_millis(2500), "detach took {took:?}");
    assert_eq!(proc_read(t.pid, f, 16), before, "detach did not restore clock_gettime");
    assert_eq!(proc_read(t.pid, got, 8), got_before, "detach did not restore the gettimeofday GOT slot");
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced after detach");
}

#[test]
fn game_exit_skips_landing() {
    let _serial = serial();
    let mut t = Target::spawn(&["--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    speed_set(&mut c, &h, 2.0).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    t.kill();
    let t0 = Instant::now();
    // The handle may already be gone (process_exited): either answer is fine, only the time counts.
    let _ = c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10));
    let took = t0.elapsed();
    eprintln!("detach of an exited game took {took:?}");
    assert!(took <= Duration::from_millis(300), "detach of an exited game took {took:?}");
}

#[test]
fn abstime_waits_stay_sane_while_landing() {
    // While the clock glides back (0.5x, clamped to real time once landed), clock_nanosleep
    // deadlines keep converting: the waiter never stalls on a deadline the glide pushed away.
    let _serial = serial();
    let t = Target::spawn(&["--abs-sleep", "--clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = speed_set(&mut c, &h, 2.0).unwrap();
    assert_eq!(hook_status(&r, "clock_nanosleep").as_deref(), Some("hooked"), "{r}");
    std::thread::sleep(Duration::from_millis(600));
    let (samples, took) = detach_sampling(&mut c, &h, t.pid, hex(&t.addr("g_abs_sleeps")));
    eprintln!("detach with an abstime sleeper took {took:?}");
    // 20 ms apart: 50 samples without progress is a 1 s gap.
    let mut still = 0;
    for w in samples.windows(2) {
        still = if w[1] > w[0] { 0 } else { still + 1 };
        assert!(still < 50, "g_abs_sleeps made no progress for 1 s while landing: {samples:?}");
    }
    assert!(samples.last() > samples.first(), "{samples:?}");
}

#[test]
fn a_slot_idle_across_a_speed_change_stays_continuous() {
    // REALTIME is read once, then left idle while the speed goes 2 → 1 (only gettimeofday is
    // read). Its next reading continues from where it was: at most 2x the real time between.
    let _serial = serial();
    let t = Target::spawn(&["--pair-clocks"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let set = |c: &mut Client, on: bool| {
        c.call("write", json!({"handle": h, "address": t.addr("g_pair_rt_on"), "bytes": if on { "01000000" } else { "00000000" }})).unwrap();
    };
    let rt = hex(&t.addr("g_pair_rt_ns"));
    speed_set(&mut c, &h, 2.0).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    // The last REALTIME store happens at most one 20 ms step before the write.
    let t0 = Instant::now() - Duration::from_millis(25);
    set(&mut c, false);
    std::thread::sleep(Duration::from_millis(50));
    let rt0 = proc_i64(t.pid, rt);
    speed_set(&mut c, &h, 1.0).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    set(&mut c, true);
    assert!(wait_until(Duration::from_secs(2), || proc_i64(t.pid, rt) != rt0), "REALTIME was not read again");
    let elapsed = t0.elapsed().as_nanos() as i64;
    let step = proc_i64(t.pid, rt) - rt0;
    eprintln!("REALTIME step across the idle speed change: {step} ns over {elapsed} ns");
    assert!(step >= 0, "REALTIME went back {step} ns");
    assert!(step <= elapsed * 2 + 5_000_000, "REALTIME stepped {step} ns over {elapsed} ns of real time");
}
