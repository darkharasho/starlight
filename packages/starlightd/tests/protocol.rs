//! Protocol v2 foundation: out-of-order slow methods and teardown before exit.
mod common;
use common::*;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static N: AtomicU64 = AtomicU64::new(0);

/// A fresh path (not yet created) for a cleanup action to create.
fn marker() -> PathBuf {
    let n = N.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!("starlightd-cleanup-{}-{n}", std::process::id()));
    let _ = std::fs::remove_file(&p);
    p
}

fn wait_for_file(p: &PathBuf, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if p.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    p.exists()
}

#[test]
fn hello_reports_protocol_3() {
    let d = Daemon::start();
    let mut c = d.client();
    let v = c.call("hello", json!({})).unwrap();
    assert_eq!(v["protocol"], 3);
    assert!(v["capabilities"].as_array().unwrap().iter().any(|x| x == "freeze"));
}

#[test]
fn slow_call_does_not_block_fast_calls() {
    let d = Daemon::start();
    let mut c = d.client();
    let started = Instant::now();
    let sleep_id = c.send("debug_sleep", json!({ "ms": 1500 }));
    let t = Instant::now();
    c.call_timeout("hello", json!({}), Duration::from_secs(1)).unwrap();
    assert!(t.elapsed() < Duration::from_millis(300), "hello took {:?}", t.elapsed());
    let r = c.wait_response(sleep_id, Duration::from_secs(5)).expect("debug_sleep response");
    assert_eq!(r.unwrap(), json!({}));
    assert!(started.elapsed() >= Duration::from_millis(1500), "debug_sleep returned early");
}

#[test]
fn stdin_eof_runs_cleanup_before_exit() {
    let mut d = Daemon::start();
    let mut c = d.client();
    let p = marker();
    c.call("debug_on_cleanup", json!({ "path": p })).unwrap();
    assert!(!p.exists());
    d.close_stdin();
    assert!(d.wait_exit(Duration::from_secs(3)).is_some(), "daemon did not exit");
    assert!(p.exists(), "cleanup did not run before exit");
    let _ = std::fs::remove_file(&p);
}

#[test]
fn sigterm_runs_cleanup_before_exit() {
    let mut d = Daemon::start();
    let mut c = d.client();
    let p = marker();
    c.call("debug_on_cleanup", json!({ "path": p })).unwrap();
    assert!(!p.exists());
    assert_eq!(unsafe { libc::kill(d.pid(), libc::SIGTERM) }, 0);
    let status = d.wait_exit(Duration::from_secs(3)).expect("daemon did not exit");
    assert_eq!(status.code(), Some(0), "SIGTERM should be a clean exit, got {status:?}");
    assert!(p.exists(), "cleanup did not run before exit");
    let _ = std::fs::remove_file(&p);
}

#[test]
fn connection_close_runs_cleanup() {
    let d = Daemon::start();
    let mut c = d.client();
    let p = marker();
    c.call("debug_on_cleanup", json!({ "path": p })).unwrap();
    assert!(!p.exists());
    drop(c);
    assert!(wait_for_file(&p, Duration::from_secs(1)), "cleanup did not run on connection close");
    let mut c2 = d.client();
    assert_eq!(c2.call("hello", json!({})).unwrap()["protocol"], 3);
    let _ = std::fs::remove_file(&p);
}

#[test]
fn detach_runs_handle_cleanup_only() {
    let d = Daemon::start();
    let mut c = d.client();
    let (t1, t2) = (Target::spawn(&[]), Target::spawn(&[]));
    let h1 = c.call("attach", json!({ "pid": t1.pid })).unwrap()["handle"].clone();
    let h2 = c.call("attach", json!({ "pid": t2.pid })).unwrap()["handle"].clone();
    let (p1, p2) = (marker(), marker());
    c.call("debug_on_cleanup", json!({ "handle": h1, "path": p1 })).unwrap();
    c.call("debug_on_cleanup", json!({ "handle": h2, "path": p2 })).unwrap();
    c.call("detach", json!({ "handle": h1 })).unwrap();
    assert!(p1.exists(), "detach did not run its handle's cleanup");
    assert!(!p2.exists(), "detach ran another handle's cleanup");
    // The other handle's action still runs when the connection ends.
    drop(c);
    assert!(wait_for_file(&p2, Duration::from_secs(1)), "remaining cleanup did not run on close");
    let _ = std::fs::remove_file(&p1);
    let _ = std::fs::remove_file(&p2);
}
