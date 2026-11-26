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

// ---------------------------------------------------------------------------------------------
// Recorded patches (Task 8)

fn patch(c: &mut Client, h: &Value, addr: u64, bytes: &str) -> Result<Value, (i64, String)> {
    c.call_timeout("patch", json!({"handle": h, "address": format!("{addr:#x}"), "bytes": bytes}), Duration::from_secs(10))
}

fn unpatch(c: &mut Client, id: &Value, force: bool) -> Result<Value, (i64, String)> {
    c.call_timeout("unpatch", json!({"id": id, "force": force}), Duration::from_secs(10))
}

fn read_hex(c: &mut Client, h: &Value, addr: u64, len: usize) -> String {
    c.call("read", json!({"handle": h, "address": format!("{addr:#x}"), "length": len})).unwrap()["bytes"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Read the target's memory straight from `/proc/<pid>/mem`, without the daemon.
fn proc_read_hex(pid: i32, addr: u64, len: usize) -> String {
    use std::os::unix::fs::FileExt;
    let f = std::fs::File::open(format!("/proc/{pid}/mem")).unwrap();
    let mut buf = vec![0u8; len];
    f.read_exact_at(&mut buf, addr).unwrap();
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// `count` instructions at `addr`, as (address, hex bytes, target address).
fn disasm(c: &mut Client, h: &Value, addr: &str, count: u64) -> Vec<(u64, String, Option<u64>)> {
    let r = c.call("disassemble", json!({"handle": h, "address": addr, "count": count})).unwrap();
    r["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                hex(i["address"].as_str().unwrap()),
                i["bytes"].as_str().unwrap().to_string(),
                i.get("target").map(|t| hex(t["address"].as_str().unwrap())),
            )
        })
        .collect()
}

/// The instruction in `bump_counter` that stores the new value to `g_counter` (ruling R2).
fn counter_store(c: &mut Client, h: &Value, t: &Target) -> (u64, String) {
    let g_counter = hex(&t.addr("g_counter"));
    disasm(c, h, &t.addr("bump_counter"), 8)
        .into_iter()
        .find(|(_, b, tg)| b.starts_with("89") && *tg == Some(g_counter))
        .map(|(a, b, _)| (a, b))
        .expect("no `mov [g_counter],reg` in bump_counter")
}

fn nops(hex_len: usize) -> String {
    "90".repeat(hex_len / 2)
}

#[test]
fn hello_lists_patch_capability() {
    let d = Daemon::start();
    let mut c = d.client();
    let caps = c.call("hello", json!({})).unwrap()["capabilities"].clone();
    assert!(caps.as_array().unwrap().iter().any(|v| v == "patch"), "{caps}");
}

#[test]
fn patch_and_unpatch_restore_original_bytes() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let counter = t.addr("g_counter");
    let (site, orig) = counter_store(&mut c, &h, &t);
    let r = patch(&mut c, &h, site, &nops(orig.len())).unwrap();
    assert_eq!(r["original"], orig.as_str());
    assert_eq!(read_hex(&mut c, &h, site, orig.len() / 2), nops(orig.len()));
    // The writer thread still runs bump_counter, but the store is gone.
    std::thread::sleep(Duration::from_millis(120));
    let frozen = read_u64(&mut c, &h, &counter) as u32;
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(read_u64(&mut c, &h, &counter) as u32, frozen, "g_counter still increases with the store NOPed");
    unpatch(&mut c, &r["id"], false).unwrap();
    assert_eq!(read_hex(&mut c, &h, site, orig.len() / 2), orig, "unpatch did not restore the original bytes");
    assert!(
        wait_until(Duration::from_secs(1), || read_u64(&mut c, &h, &counter) as u32 > frozen),
        "g_counter does not increase after unpatch"
    );
    // The id is gone.
    assert_eq!(unpatch(&mut c, &r["id"], false).unwrap_err().0, -32009);
    assert_eq!(unpatch(&mut c, &json!(9999), false).unwrap_err().0, -32009);
}

#[test]
fn patch_waits_until_no_thread_is_inside_the_site() {
    // Ruling R1: alternate two different valid encodings of spin_target's body, with different
    // instruction boundaries. A thread stopped in the middle of either would crash (or compute
    // garbage) after the other is written, unless the daemon waits until no RIP is inside.
    let t = Target::spawn(&["--spin"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let ins = disasm(&mut c, &h, &t.addr("spin_target"), 11);
    // [endbr64 under -fcf-protection, Ubuntu's default] push rbp; mov rbp,rsp |
    // mov [rbp-4],edi; mov edx,[rbp-4]; mov eax,edx; add eax,eax; add eax,edx; add eax,1 | pop rbp
    let s = if ins[0].1 == "f30f1efa" { 3 } else { 2 };
    let site = ins[s].0;
    let body: String = ins[s..s + 6].iter().map(|i| i.1.as_str()).collect();
    assert_eq!(body, "897dfc8b55fc89d001c001d083c001", "spin_target compiled differently; update this test");
    assert_eq!(ins[s + 6].1, "5d");
    // lea eax,[rdi+rdi*2+1]; nop dword [rax+rax+0]; nop word [rax+rax+0]: the same result, x*3+1.
    let alt = "8d447f01" .to_string() + "0f1f440000" + "660f1f440000";
    assert_eq!(alt.len(), body.len());
    let calls = t.addr("g_spin_calls");
    let start = read_u64(&mut c, &h, &calls);
    for i in 0..250 {
        let r = patch(&mut c, &h, site, &alt).unwrap_or_else(|e| panic!("patch {i}: {e:?}"));
        assert_eq!(r["original"], body.as_str());
        unpatch(&mut c, &r["id"], false).unwrap_or_else(|e| panic!("unpatch {i}: {e:?}"));
    }
    assert_eq!(unsafe { libc::kill(t.pid, 0) }, 0, "target died");
    assert_eq!(read_hex(&mut c, &h, site, body.len() / 2), body);
    let after = read_u64(&mut c, &h, &calls);
    std::thread::sleep(Duration::from_millis(50));
    assert!(read_u64(&mut c, &h, &calls) > after && after > start, "spin thread stalled");
    assert!(!any_thread_stopped(t.pid), "a target thread was left stopped");
}

#[test]
fn overlapping_patch_is_32014() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let h2 = attach(&mut c, &t);
    let f = hex(&t.addr("bump_counter")); // never called without --writer
    let orig = read_hex(&mut c, &h, f, 8);
    let a = patch(&mut c, &h, f, "90909090").unwrap();
    let e = patch(&mut c, &h, f + 2, "90909090").unwrap_err();
    assert_eq!(e.0, -32014, "{e:?}");
    // Another handle to the same process shares its code.
    assert_eq!(patch(&mut c, &h2, f + 3, "90").unwrap_err().0, -32014);
    assert_eq!(read_hex(&mut c, &h, f, 8), "90909090".to_string() + &orig[8..], "a refused patch wrote bytes");
    // Adjacent is fine.
    let b = patch(&mut c, &h, f + 4, "9090").unwrap();
    unpatch(&mut c, &a["id"], false).unwrap();
    let a2 = patch(&mut c, &h, f + 2, "90").unwrap();
    unpatch(&mut c, &a2["id"], false).unwrap();
    unpatch(&mut c, &b["id"], false).unwrap();
    assert_eq!(read_hex(&mut c, &h, f, 8), orig);
}

#[test]
fn unpatch_after_game_changed_bytes_is_32014_unless_forced() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("bump_counter"));
    let orig = read_hex(&mut c, &h, f, 4);
    let p = patch(&mut c, &h, f, "90909090").unwrap();
    // The game (here: a plain write) changes the patched bytes.
    c.call("write", json!({"handle": h, "address": format!("{f:#x}"), "bytes": "cccc"})).unwrap();
    let e = unpatch(&mut c, &p["id"], false).unwrap_err();
    assert_eq!(e.0, -32014, "{e:?}");
    assert_eq!(read_hex(&mut c, &h, f, 4), "cccc9090", "a refused unpatch wrote bytes");
    unpatch(&mut c, &p["id"], true).unwrap();
    assert_eq!(read_hex(&mut c, &h, f, 4), orig);
    assert_eq!(unpatch(&mut c, &p["id"], true).unwrap_err().0, -32009);

    // Session-end teardown leaves bytes the game changed alone.
    let p = patch(&mut c, &h, f, "90909090").unwrap();
    assert_eq!(p["original"], orig.as_str());
    c.call("write", json!({"handle": h, "address": format!("{f:#x}"), "bytes": "cc"})).unwrap();
    c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10)).unwrap();
    assert_eq!(proc_read_hex(t.pid, f, 4), "cc909090");
}

#[test]
fn detach_restores_patched_bytes() {
    let t = Target::spawn(&["--spin"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("bump_counter"));
    let orig = read_hex(&mut c, &h, f, 4);
    patch(&mut c, &h, f, "90909090").unwrap();
    // A live patch keeps the game traced (ruling R12) ...
    assert_ne!(tracer_pid(t.pid), 0, "a live patch must hold the tracer");
    c.call_timeout("detach", json!({"handle": h}), Duration::from_secs(10)).unwrap();
    assert_eq!(proc_read_hex(t.pid, f, 4), orig, "detach did not restore the bytes");
    // ... and the last patch going away releases it.
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced after detach");
    assert!(!any_thread_stopped(t.pid));
}

#[test]
fn connection_drop_restores_patched_bytes() {
    let t = Target::spawn(&["--spin"]);
    let d = Daemon::start();
    let f = hex(&t.addr("bump_counter"));
    let orig = proc_read_hex(t.pid, f, 4);
    {
        let mut a = d.client();
        let h = attach(&mut a, &t);
        patch(&mut a, &h, f, "90909090").unwrap();
        assert_eq!(proc_read_hex(t.pid, f, 4), "90909090");
    }
    let mut b = d.client();
    let h = attach(&mut b, &t);
    assert!(
        wait_until(Duration::from_secs(1), || read_hex(&mut b, &h, f, 4) == orig),
        "bytes not restored within 1 s of the connection closing: {}",
        read_hex(&mut b, &h, f, 4)
    );
    assert!(wait_until(Duration::from_secs(1), || tracer_pid(t.pid) == 0), "still traced after the connection closed");
}

#[test]
fn stdin_eof_restores_patched_bytes() {
    let t = Target::spawn(&["--spin"]);
    let mut d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("bump_counter"));
    let orig = read_hex(&mut c, &h, f, 4);
    patch(&mut c, &h, f, "90909090").unwrap();
    assert_eq!(proc_read_hex(t.pid, f, 4), "90909090");
    d.close_stdin();
    assert!(d.wait_exit(Duration::from_secs(3)).is_some(), "daemon did not exit within 3 s of stdin EOF");
    assert_eq!(proc_read_hex(t.pid, f, 4), orig, "stdin EOF did not restore the bytes");
    assert_eq!(unsafe { libc::kill(t.pid, 0) }, 0, "target died");
    assert!(!any_thread_stopped(t.pid));
}

#[test]
fn patch_rejects_bad_params() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let f = hex(&t.addr("bump_counter"));
    assert_eq!(patch(&mut c, &h, f, "").unwrap_err().0, -32602);
    assert_eq!(patch(&mut c, &h, f, "9").unwrap_err().0, -32602);
    assert_eq!(patch(&mut c, &json!(99), f, "90").unwrap_err().0, -32007);
    // Unmapped memory: nothing to patch.
    assert_eq!(patch(&mut c, &h, 0x10, "90").unwrap_err().0, -32004);
}

#[test]
fn assemble_bits_32() {
    let d = Daemon::start();
    let mut c = d.client();
    let r = c.call("assemble", json!({"address": "0x401000", "source": "pushad", "bits": 32})).unwrap();
    assert_eq!(r["bytes"], "60");
    // Without bits or a handle it is 64-bit, where pushad doesn't exist.
    assert!(c.call("assemble", json!({"address": "0x401000", "source": "pushad"})).is_err());
    assert_eq!(c.call("assemble", json!({"address": "0x1", "source": "nop", "bits": 16})).unwrap_err().0, -32602);
    // With a handle on a 32-bit game, its bitness.
    let t = Target::spawn32(&[]);
    let h = attach(&mut c, &t);
    let r = c.call("assemble", json!({"handle": h, "address": "0x401000", "source": "push eax"})).unwrap();
    assert_eq!(r["bytes"], "50");
}
