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

#[test]
fn non_object_json_gets_32602_with_null_id() {
    let d = Daemon::start();
    let mut c = d.client();
    for raw in ["[1]", "5"] {
        let v = c.raw(raw);
        assert_eq!(v["error"]["code"], -32602, "{raw}");
        assert!(v["id"].is_null());
    }
}

/// The daemon only serves the process that spawned it. Start it through a shell
/// so this test process is not its parent, then check it hangs up on us.
#[test]
fn refuses_connections_from_non_parent() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};

    let socket = std::env::temp_dir().join(format!("starlightd-test-{}-nonparent.sock", std::process::id()));
    // fd 3 keeps the daemon's stdin on our pipe (a background job's stdin is otherwise /dev/null).
    let mut sh = Command::new("sh")
        .arg("-c")
        .arg(r#"exec 3<&0; "$0" --socket "$1" <&3 & wait"#)
        .arg(env!("CARGO_BIN_EXE_starlightd"))
        .arg(&socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn sh");
    let mut out = BufReader::new(sh.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).expect("read READY");
    assert_eq!(line.trim(), "READY 1");

    let mut s = UnixStream::connect(&socket).expect("connect");
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let _ = writeln!(s, r#"{{"jsonrpc":"2.0","id":1,"method":"hello","params":{{}}}}"#);
    let mut buf = Vec::new();
    // Closing with our request unread can surface as a reset rather than EOF.
    match s.read_to_end(&mut buf) {
        Ok(_) => assert!(buf.is_empty(), "non-parent got a reply: {}", String::from_utf8_lossy(&buf)),
        Err(e) => assert_eq!(e.kind(), std::io::ErrorKind::ConnectionReset, "daemon should hang up, not {e}"),
    }

    drop(sh.stdin.take()); // daemon exits on stdin EOF
    let _ = sh.wait();
    let _ = fs::remove_file(&socket);
}
