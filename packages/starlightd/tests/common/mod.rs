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

    pub fn pid(&self) -> i32 {
        self.child.id() as i32
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
    /// Responses that arrived while waiting for a different id (slow methods answer out of order).
    pending_responses: HashMap<u64, Value>,
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
        Client { stream, rx, pending_notifications: vec![], pending_responses: HashMap::new(), next_id: 1 }
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
        self.call_timeout(method, params, Duration::from_secs(5))
    }

    /// Like `call`, but panics if no response arrives within `timeout`.
    pub fn call_timeout(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, (i64, String)> {
        let id = self.send(method, params);
        self.wait_response(id, timeout)
            .unwrap_or_else(|| panic!("no response to {method} within {timeout:?}"))
    }

    /// Send a request without waiting; returns its id for `wait_response`.
    pub fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stream, "{req}").unwrap();
        id
    }

    /// The response to request `id`, or `None` if it doesn't arrive within `timeout`.
    pub fn wait_response(&mut self, id: u64, timeout: Duration) -> Option<Result<Value, (i64, String)>> {
        let deadline = Instant::now() + timeout;
        let v = loop {
            if let Some(v) = self.pending_responses.remove(&id) {
                break v;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            let v = self.rx.recv_timeout(left).ok()?;
            match v.get("id").and_then(Value::as_u64) {
                Some(got) => {
                    self.pending_responses.insert(got, v);
                }
                None if v.get("id").is_none() => self.pending_notifications.push(v),
                None => {} // non-numeric id: not one of ours
            }
        };
        if let Some(e) = v.get("error") {
            return Some(Err((e["code"].as_i64().unwrap(), e["message"].as_str().unwrap_or("").to_string())));
        }
        Some(Ok(v["result"].clone()))
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

/// `minimal_pe` image that also exports each `(name, rva)` (rva = file offset, so the file can be
/// mapped as-is). The export directory lives at 0x200, its tables below 0x1000; `size_of_image` >= 0x1000.
pub fn minimal_pe_with_exports(size_of_image: u32, exports: &[(&str, u32)]) -> Vec<u8> {
    let mut b = minimal_pe(size_of_image);
    b.resize(0x1000, 0);
    let put = |b: &mut Vec<u8>, off: usize, v: &[u8]| b[off..off + v.len()].copy_from_slice(v);
    let n = exports.len() as u32;
    put(&mut b, 0x58 + 112, &0x200u32.to_le_bytes()); // data directory 0: export table RVA
    put(&mut b, 0x58 + 116, &0x100u32.to_le_bytes()); // ... and size
    put(&mut b, 0x210, &1u32.to_le_bytes()); // ordinal base
    put(&mut b, 0x214, &n.to_le_bytes());
    put(&mut b, 0x218, &n.to_le_bytes());
    put(&mut b, 0x21c, &0x600u32.to_le_bytes());
    put(&mut b, 0x220, &0x700u32.to_le_bytes());
    put(&mut b, 0x224, &0x800u32.to_le_bytes());
    let mut name_at = 0x900;
    for (i, (name, rva)) in exports.iter().enumerate() {
        put(&mut b, 0x600 + i * 4, &rva.to_le_bytes());
        put(&mut b, 0x700 + i * 4, &(name_at as u32).to_le_bytes());
        put(&mut b, 0x800 + i * 2, &(i as u16).to_le_bytes());
        put(&mut b, name_at, name.as_bytes());
        name_at += name.len() + 1;
    }
    b
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

impl Drop for Client {
    /// The reader thread holds a clone of the socket, so close it explicitly.
    fn drop(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}
