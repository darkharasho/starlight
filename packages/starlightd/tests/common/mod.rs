#![allow(dead_code)]
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    socket: PathBuf,
}

impl Daemon {
    pub fn start() -> Daemon {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let socket = std::env::temp_dir().join(format!("starlightd-test-{}-{n}.sock", std::process::id()));
        let mut child = Command::new(env!("CARGO_BIN_EXE_starlightd"))
            .arg("--socket")
            .arg(&socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn starlightd");
        let stdin = child.stdin.take();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        out.read_line(&mut line).expect("read READY");
        assert_eq!(line.trim(), "READY 1", "unexpected banner: {line:?}");
        Daemon { child, stdin, socket }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

    pub fn client(&self) -> Client {
        Client::connect(&self.socket)
    }

    pub fn close_stdin(&mut self) {
        self.stdin.take();
    }

    pub fn wait_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return Some(s);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

pub struct Client {
    stream: UnixStream,
    rx: Receiver<Value>,
    pending_notifications: Vec<Value>,
    next_id: u64,
}

impl Client {
    pub fn connect(path: &Path) -> Client {
        let stream = UnixStream::connect(path).expect("connect");
        let reader = BufReader::new(stream.try_clone().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        Client { stream, rx, pending_notifications: vec![], next_id: 1 }
    }

    /// Send a raw line (for malformed-input tests) and return the next response.
    pub fn raw(&mut self, line: &str) -> Value {
        writeln!(self.stream, "{line}").unwrap();
        loop {
            let v = self.rx.recv_timeout(Duration::from_secs(5)).expect("response");
            if v.get("id").is_some() {
                return v;
            }
            self.pending_notifications.push(v);
        }
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stream, "{req}").unwrap();
        loop {
            let v = self.rx.recv_timeout(Duration::from_secs(5)).expect("response");
            if v.get("id") == Some(&json!(id)) {
                if let Some(e) = v.get("error") {
                    return Err((e["code"].as_i64().unwrap(), e["message"].as_str().unwrap_or("").to_string()));
                }
                return Ok(v["result"].clone());
            }
            if v.get("id").is_none() {
                self.pending_notifications.push(v);
            }
        }
    }

    pub fn next_notification(&mut self, timeout: Duration) -> Option<Value> {
        if !self.pending_notifications.is_empty() {
            return Some(self.pending_notifications.remove(0));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(v) if v.get("id").is_none() => return Some(v),
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    }
}

pub struct Target {
    child: Child,
    pub pid: i32,
    pub addrs: HashMap<String, String>,
    pub offsets: HashMap<String, u64>,
}

impl Target {
    pub fn spawn(args: &[&str]) -> Target {
        let exe = Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine/test-target/build/target");
        assert!(exe.exists(), "build it with `make -C packages/engine/test-target`");
        let mut child = Command::new(&exe)
            .args(args)
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn target");
        let pid = child.id() as i32;
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let (mut addrs, mut offsets) = (HashMap::new(), HashMap::new());
        let mut line = String::new();
        loop {
            line.clear();
            if out.read_line(&mut line).expect("read target") == 0 {
                panic!("target exited before finishing its listing");
            }
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("addr ") {
                let (k, v) = rest.split_once('=').unwrap();
                addrs.insert(k.to_string(), v.to_string());
            } else if let Some(rest) = l.strip_prefix("offset ") {
                let (k, v) = rest.split_once('=').unwrap();
                offsets.insert(k.to_string(), v.parse().unwrap());
                if k == "hp_in_stats" {
                    break; // last line of the listing
                }
            }
        }
        // Keep draining so later target output never blocks it.
        std::thread::spawn(move || {
            let mut s = String::new();
            while out.read_line(&mut s).map(|n| n > 0).unwrap_or(false) {
                s.clear();
            }
        });
        Target { child, pid, addrs, offsets }
    }

    pub fn addr(&self, name: &str) -> String {
        self.addrs.get(name).unwrap_or_else(|| panic!("no addr {name}")).clone()
    }

    pub fn offset(&self, name: &str) -> u64 {
        *self.offsets.get(name).unwrap_or_else(|| panic!("no offset {name}"))
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Minimal PE32+ image header: "MZ", e_lfanew=0x40, "PE\0\0", COFF header, optional header with SizeOfImage.
pub fn minimal_pe(size_of_image: u32) -> Vec<u8> {
    let mut h = vec![0u8; 0x200];
    h[0..4].copy_from_slice(&[0x4D, 0x5A, 0x90, 0x00]);
    h[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
    h[0x40..0x44].copy_from_slice(b"PE\0\0");
    h[0x44..0x46].copy_from_slice(&0x8664u16.to_le_bytes()); // Machine
    h[0x54..0x56].copy_from_slice(&0xF0u16.to_le_bytes()); // SizeOfOptionalHeader
    let opt = 0x58;
    h[opt..opt + 2].copy_from_slice(&0x20bu16.to_le_bytes());
    h[opt + 56..opt + 60].copy_from_slice(&size_of_image.to_le_bytes());
    h
}
