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

fn alloc(c: &mut Client, params: Value) -> Result<Value, (i64, String)> {
    c.call_timeout("alloc", params, Duration::from_secs(10))
}

fn read_u64(c: &mut Client, h: &Value, addr: &str) -> u64 {
    let b = c.call("read", json!({"handle": h, "address": addr, "length": 8})).unwrap()["bytes"].as_str().unwrap().to_string();
    let bytes: Vec<u8> = (0..16).step_by(2).map(|i| u8::from_str_radix(&b[i..i + 2], 16).unwrap()).collect();
    u64::from_le_bytes(bytes.try_into().unwrap())
}

/// The `/proc/<pid>/maps` permissions of the mapping that starts at `addr`.
fn perms_at(pid: i32, addr: u64) -> Option<String> {
    let maps = std::fs::read_to_string(format!("/proc/{pid}/maps")).unwrap();
    maps.lines()
        .find(|l| l.split('-').next().and_then(|s| u64::from_str_radix(s, 16).ok()) == Some(addr))
        .map(|l| l.split_whitespace().nth(1).unwrap().to_string())
}

fn tracer_pid(pid: i32) -> i32 {
    let s = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    s.lines().find_map(|l| l.strip_prefix("TracerPid:")).unwrap().trim().parse().unwrap()
}

/// True if any thread of `pid` sits in a ptrace stop (state `t`) or a job-control stop (`T`).
fn any_thread_stopped(pid: i32) -> bool {
    std::fs::read_dir(format!("/proc/{pid}/task")).unwrap().flatten().any(|e| {
        let stat = std::fs::read_to_string(e.path().join("stat")).unwrap_or_default();
        // The state follows the parenthesised command name.
        let state = stat.rsplit_once(')').map(|(_, r)| r.trim_start().chars().next().unwrap_or(' ')).unwrap_or(' ');
        state == 't' || state == 'T'
    })
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

#[test]
fn alloc_returns_rwx_memory_we_can_use() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = alloc(&mut c, json!({"handle": h, "size": 100})).unwrap();
    let a = hex(r["address"].as_str().unwrap());
    assert_eq!(a % 4096, 0, "address {a:#x} is not page-aligned");
    assert_eq!(r["size"], 4096);
    let addr = format!("{a:#x}");
    c.call("write", json!({"handle": h, "address": addr, "bytes": "c3deadbeef"})).unwrap();
    let back = c.call("read", json!({"handle": h, "address": addr, "length": 5})).unwrap();
    assert_eq!(back["bytes"], "c3deadbeef");
    assert_eq!(perms_at(t.pid, a).as_deref(), Some("rwxp"));
}

#[test]
fn alloc_honours_prot() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let rw = hex(alloc(&mut c, json!({"handle": h, "size": 8192, "prot": "rw"})).unwrap()["address"].as_str().unwrap());
    assert_eq!(perms_at(t.pid, rw).as_deref(), Some("rw-p"));
    let rx = hex(alloc(&mut c, json!({"handle": h, "size": 1, "prot": "rx"})).unwrap()["address"].as_str().unwrap());
    assert_eq!(perms_at(t.pid, rx).as_deref(), Some("r-xp"));
    assert_eq!(alloc(&mut c, json!({"handle": h, "size": 1, "prot": "wx"})).unwrap_err().0, -32602);
    assert_eq!(alloc(&mut c, json!({"handle": h, "size": 0})).unwrap_err().0, -32602);
}

#[test]
fn alloc_near_is_within_2gb() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let near = hex(&t.addr("bump_counter"));
    let r = alloc(&mut c, json!({"handle": h, "size": 100, "near": t.addr("bump_counter")})).unwrap();
    let a = hex(r["address"].as_str().unwrap());
    assert!(a.abs_diff(near) < (1 << 31) - 4096, "{a:#x} is not within 2 GiB of {near:#x}");
    assert_eq!(a % 0x10000, 0, "near allocations are 64 KiB aligned");
    assert_eq!(perms_at(t.pid, a).as_deref(), Some("rwxp"));
}

#[test]
fn target_keeps_running_after_alloc() {
    let t = Target::spawn(&["--spin"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let calls = t.addr("g_spin_calls");
    let before = read_u64(&mut c, &h, &calls);
    for _ in 0..5 {
        alloc(&mut c, json!({"handle": h, "size": 64})).unwrap();
    }
    let after_allocs = read_u64(&mut c, &h, &calls);
    std::thread::sleep(Duration::from_millis(100));
    let later = read_u64(&mut c, &h, &calls);
    assert!(after_allocs > before && later > after_allocs, "spin thread stalled: {before} -> {after_allocs} -> {later}");
    assert_eq!(unsafe { libc::kill(t.pid, 0) }, 0, "target died");
    assert!(!any_thread_stopped(t.pid), "a target thread was left stopped");
}

#[test]
fn blocked_syscall_resumes_after_alloc() {
    let mut t = Target::spawn(&["--spin"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (ticks, calls) = (t.addr("g_main_ticks"), t.addr("g_spin_calls"));
    // The main thread spends nearly all its time blocked in sleep(1), so each alloc interrupts it.
    let ticks0 = read_u64(&mut c, &h, &ticks);
    let start = Instant::now();
    for _ in 0..5 {
        alloc(&mut c, json!({"handle": h, "size": 64})).unwrap();
        std::thread::sleep(Duration::from_millis(60));
    }
    let ticks_after_allocs = read_u64(&mut c, &h, &ticks);
    // If the interrupted sleep did not restart, every alloc would end it early and add a tick.
    let allowed = 1 + start.elapsed().as_secs();
    assert!(
        ticks_after_allocs - ticks0 <= allowed,
        "sleep(1) was cut short: {} ticks in {:?}",
        ticks_after_allocs - ticks0,
        start.elapsed()
    );
    let spin0 = read_u64(&mut c, &h, &calls);
    assert!(
        wait_until(Duration::from_millis(3500), || read_u64(&mut c, &h, &ticks) >= ticks_after_allocs + 2),
        "main thread stopped ticking after alloc"
    );
    assert!(read_u64(&mut c, &h, &calls) > spin0, "spin thread stalled");
    assert!(!any_thread_stopped(t.pid), "a target thread was left stopped");
    t.kill(); // returns only if the target can be killed and reaped
    assert_ne!(unsafe { libc::kill(t.pid, 0) }, 0, "target still exists after kill + wait");
}

#[test]
fn free_unknown_address_is_32009() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let h2 = attach(&mut c, &t);
    let e = c.call("free", json!({"handle": h, "address": "0x12340000"})).unwrap_err();
    assert_eq!(e.0, -32009);
    let addr = alloc(&mut c, json!({"handle": h, "size": 100})).unwrap()["address"].as_str().unwrap().to_string();
    // Another handle's allocation is unknown to this one.
    assert_eq!(c.call("free", json!({"handle": h2, "address": addr})).unwrap_err().0, -32009);
    assert!(perms_at(t.pid, hex(&addr)).is_some());
    c.call_timeout("free", json!({"handle": h, "address": addr}), Duration::from_secs(10)).unwrap();
    assert_eq!(perms_at(t.pid, hex(&addr)), None, "free did not unmap the page");
    assert_eq!(c.call("free", json!({"handle": h, "address": addr})).unwrap_err().0, -32009, "double free");
}

#[test]
fn second_tracer_is_32012() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    // This test thread becomes the target's debugger.
    assert_eq!(unsafe { libc::ptrace(libc::PTRACE_SEIZE, t.pid, 0, 0) }, 0, "seize failed");
    let e = alloc(&mut c, json!({"handle": h, "size": 100})).unwrap_err();
    // Detach before asserting, so a failure never leaves the target traced by the test.
    unsafe {
        libc::ptrace(libc::PTRACE_INTERRUPT, t.pid, 0, 0);
        let mut status = 0;
        libc::waitpid(t.pid, &mut status, libc::__WALL);
        libc::ptrace(libc::PTRACE_DETACH, t.pid, 0, 0);
    }
    assert_eq!(e.0, -32012, "{e:?}");
    assert!(e.1.contains("another debugger"), "message: {}", e.1);
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0));
    // Once the other debugger is gone, alloc works again.
    alloc(&mut c, json!({"handle": h, "size": 100})).unwrap();
}

#[test]
fn detach_releases_ptrace() {
    let t = Target::spawn(&["--spin"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    alloc(&mut c, json!({"handle": h, "size": 100})).unwrap();
    c.call("detach", json!({"handle": h})).unwrap();
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "TracerPid {}", tracer_pid(t.pid));
    assert!(!any_thread_stopped(t.pid));
}

#[test]
fn allocations_alone_do_not_keep_the_game_traced() {
    // Ruling R12: only patches, hooks, watches and in-flight remote ops hold the tracer.
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    assert_eq!(tracer_pid(t.pid), 0, "plain attach must not ptrace");
    let addr = alloc(&mut c, json!({"handle": h, "size": 100})).unwrap()["address"].clone();
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced after alloc");
    // The allocation record survives the tracer going away.
    c.call_timeout("free", json!({"handle": h, "address": addr}), Duration::from_secs(10)).unwrap();
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced after free");
}

#[test]
fn hello_lists_alloc_capability() {
    let d = Daemon::start();
    let mut c = d.client();
    let caps = c.call("hello", json!({})).unwrap()["capabilities"].clone();
    assert!(caps.as_array().unwrap().iter().any(|v| v == "alloc"), "{caps}");
}
