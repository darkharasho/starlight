mod common;
use common::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[test]
fn hello_reports_protocol_1() {
    let d = Daemon::start();
    let mut c = d.client();
    let v = c.call("hello", json!({})).unwrap();
    assert_eq!(v["protocol"], 1);
    assert!(v["capabilities"].as_array().unwrap().iter().any(|x| x == "read"));
}

#[test]
fn unknown_method_is_32601() {
    let d = Daemon::start();
    let mut c = d.client();
    assert_eq!(c.call("nope", json!({})).unwrap_err().0, -32601);
}

#[test]
fn malformed_json_is_32700_with_null_id() {
    let d = Daemon::start();
    let mut c = d.client();
    let v = c.raw("{not json");
    assert_eq!(v["error"]["code"], -32700);
    assert!(v["id"].is_null());
}

#[test]
fn exits_when_stdin_closes() {
    let mut d = Daemon::start();
    d.close_stdin();
    assert!(d.wait_exit(Duration::from_secs(1)).is_some());
}

#[test]
fn socket_is_private() {
    let d = Daemon::start();
    assert_eq!(fs::metadata(d.socket_path()).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn target_helper_lists_addresses() {
    let t = Target::spawn(&[]);
    assert!(t.addr("g_health").starts_with("0x"));
    assert_eq!(t.offset("hp_in_stats"), 0);
}
