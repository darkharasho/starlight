mod common;
use common::*;
use serde_json::{json, Value};
use std::time::Duration;

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

fn read_health(c: &mut Client, h: &Value, t: &Target) -> String {
    c.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap()["bytes"]
        .as_str()
        .unwrap()
        .to_string()
}

fn write_health(c: &mut Client, h: &Value, t: &Target, bytes: &str) {
    c.call("write", json!({"handle": h, "address": t.addr("g_health"), "bytes": bytes})).unwrap();
}

fn freeze(c: &mut Client, h: &Value, t: &Target) -> Result<Value, (i64, String)> {
    c.call("freeze", json!({"handle": h, "address": t.addr("g_health"), "bytes": "e7030000", "interval_ms": 20}))
}

#[test]
fn freeze_holds_value_against_external_write() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    freeze(&mut c, &h, &t).unwrap();
    write_health(&mut c, &h, &t, "01000000");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(read_health(&mut c, &h, &t), "e7030000");
}

#[test]
fn unfreeze_stops_writing() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let id = freeze(&mut c, &h, &t).unwrap()["id"].clone();
    c.call("unfreeze", json!({"id": id})).unwrap();
    write_health(&mut c, &h, &t, "01000000");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(read_health(&mut c, &h, &t), "01000000");
    assert_eq!(c.call("unfreeze", json!({"id": id})).unwrap_err().0, -32602);
}

#[test]
fn freeze_failure_creates_no_freeze() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let e = c.call("freeze", json!({"handle": h, "address": "0x0", "bytes": "00", "interval_ms": 20})).unwrap_err();
    assert_eq!(e.0, -32004);
    assert_eq!(c.call("unfreeze", json!({"id": 1})).unwrap_err().0, -32602);
}

#[test]
fn detach_cancels_freezes() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    freeze(&mut c, &h, &t).unwrap();
    let h2 = attach(&mut c, &t);
    c.call("detach", json!({"handle": h})).unwrap();
    write_health(&mut c, &h2, &t, "01000000");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(read_health(&mut c, &h2, &t), "01000000");
}

#[test]
fn unfreeze_of_another_connections_freeze_is_rejected() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut a = d.client();
    let mut b = d.client();
    let h = attach(&mut a, &t);
    let id = freeze(&mut a, &h, &t).unwrap()["id"].clone();
    assert_eq!(b.call("unfreeze", json!({"id": id})).unwrap_err().0, -32602);
    write_health(&mut a, &h, &t, "01000000");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(read_health(&mut a, &h, &t), "e7030000");
}

#[test]
fn freeze_stops_and_notifies_when_target_exits() {
    let mut t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    freeze(&mut c, &h, &t).unwrap();
    t.kill();
    let n = c.next_notification(Duration::from_secs(3)).expect("process_exited");
    assert_eq!(n["method"], "process_exited");
    assert_eq!(n["params"]["handle"], h);
    assert!(c.call("hello", json!({})).is_ok());
}

#[test]
fn closing_connection_cancels_freezes() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut a = d.client();
    let h = attach(&mut a, &t);
    freeze(&mut a, &h, &t).unwrap();
    drop(a);
    let mut b = d.client();
    let hb = attach(&mut b, &t);
    std::thread::sleep(Duration::from_millis(100));
    write_health(&mut b, &hb, &t, "01000000");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(read_health(&mut b, &hb, &t), "01000000");
}

#[test]
fn huge_interval_is_invalid_params() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let e = c
        .call("freeze", json!({"handle": h, "address": t.addr("g_health"), "bytes": "e7030000", "interval_ms": u64::MAX}))
        .unwrap_err();
    assert_eq!(e.0, -32602);
    assert!(c.call("freeze", json!({"handle": h, "address": t.addr("g_health"), "bytes": "e7030000", "interval_ms": 3_600_000})).is_ok());
}
