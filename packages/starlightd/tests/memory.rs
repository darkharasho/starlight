mod common;
use common::*;
use serde_json::{json, Value};
use std::time::Duration;

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

#[test]
fn reads_int32_health() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let v = c.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap();
    assert_eq!(v["bytes"], "64000000");
}

#[test]
fn write_then_read_roundtrip() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    c.call("write", json!({"handle": h, "address": t.addr("g_health"), "bytes": "e7030000"})).unwrap();
    let v = c.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap();
    assert_eq!(v["bytes"], "e7030000");
}

#[test]
fn read_unmapped_is_error() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    assert_eq!(c.call("read", json!({"handle": h, "address": "0x0", "length": 4})).unwrap_err().0, -32003);
}

#[test]
fn write_unmapped_is_32004() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    assert_eq!(c.call("write", json!({"handle": h, "address": "0x0", "bytes": "00"})).unwrap_err().0, -32004);
}

#[test]
fn attach_missing_pid_is_32002() {
    let d = Daemon::start();
    let mut c = d.client();
    assert_eq!(c.call("attach", json!({"pid": 999_999_999})).unwrap_err().0, -32002);
}

#[test]
fn unknown_handle_is_32007() {
    let d = Daemon::start();
    let mut c = d.client();
    assert_eq!(c.call("read", json!({"handle": 42, "address": "0x1000", "length": 1})).unwrap_err().0, -32007);
}

#[test]
fn bad_params_are_32602() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    assert_eq!(c.call("attach", json!({})).unwrap_err().0, -32602);
    let h = attach(&mut c, &t);
    assert_eq!(c.call("read", json!({"handle": h, "address": "zz", "length": 4})).unwrap_err().0, -32602);
    assert_eq!(c.call("write", json!({"handle": h, "address": "0x1000", "bytes": "abc"})).unwrap_err().0, -32602);
}

#[test]
fn detach_invalidates_handle() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    c.call("detach", json!({"handle": h})).unwrap();
    let e = c.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap_err();
    assert_eq!(e.0, -32007);
    assert_eq!(c.call("detach", json!({"handle": h})).unwrap_err().0, -32007);
}

#[test]
fn handles_are_per_connection() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c1 = d.client();
    let mut c2 = d.client();
    let h = attach(&mut c1, &t);
    let e = c2.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap_err();
    assert_eq!(e.0, -32007);
}

#[test]
fn notifies_when_target_exits() {
    let mut t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    t.kill();
    let n = c.next_notification(Duration::from_secs(2)).expect("notification");
    assert_eq!(n["method"], "process_exited");
    assert_eq!(n["params"]["handle"], h);
    // exactly once, and the handle is gone
    assert!(c.next_notification(Duration::from_millis(400)).is_none());
    assert_eq!(c.call("read", json!({"handle": h, "address": "0x1000", "length": 1})).unwrap_err().0, -32007);
}

#[test]
fn no_notification_after_detach() {
    let mut t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    c.call("detach", json!({"handle": h})).unwrap();
    t.kill();
    assert!(c.next_notification(Duration::from_millis(600)).is_none());
}
