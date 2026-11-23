//! JSON-RPC 2.0 plumbing: errors, a shared connection writer, and method dispatch.
use crate::{aob, mem, modules, pointer, process::Handles};
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::time::Duration;
use std::sync::{Arc, Mutex};

pub const PROTOCOL: u64 = 1;
pub const CAPABILITIES: &[&str] = &["read", "write", "modules", "aob", "pointer", "freeze"];

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError { code, message: message.into() }
    }
    pub fn parse_error(m: impl Into<String>) -> Self { Self::new(-32700, m) }
    pub fn method_not_found(m: impl Into<String>) -> Self { Self::new(-32601, m) }
    pub fn invalid_params(m: impl Into<String>) -> Self { Self::new(-32602, m) }
    pub fn internal_error(m: impl Into<String>) -> Self { Self::new(-32603, m) }
    pub fn permission_denied(m: impl Into<String>) -> Self { Self::new(-32001, m) }
    pub fn process_not_found(m: impl Into<String>) -> Self { Self::new(-32002, m) }
    pub fn read_failed(m: impl Into<String>) -> Self { Self::new(-32003, m) }
    pub fn write_failed(m: impl Into<String>) -> Self { Self::new(-32004, m) }
    pub fn module_not_found(m: impl Into<String>) -> Self { Self::new(-32005, m) }
    pub fn invalid_pattern(m: impl Into<String>) -> Self { Self::new(-32006, m) }
    pub fn unknown_handle(m: impl Into<String>) -> Self { Self::new(-32007, m) }
}

/// Cloneable, thread-safe line writer for one connection.
#[derive(Clone)]
pub struct Conn {
    writer: Arc<Mutex<UnixStream>>,
}

impl Conn {
    pub fn new(stream: UnixStream) -> Self {
        // A stalled client must not pin writer threads forever.
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        Conn { writer: Arc::new(Mutex::new(stream)) }
    }

    /// Write one JSON value as a single line. Errors (peer gone) are ignored.
    pub fn send(&self, value: &Value) {
        let mut line = value.to_string();
        line.push('\n');
        if let Ok(mut w) = self.writer.lock() {
            if w.write_all(line.as_bytes()).is_err() {
                // Timed out or peer gone: drop the connection so the reader loop ends and cleanup runs.
                let _ = w.shutdown(std::net::Shutdown::Both);
            }
        }
    }

    pub fn send_notification(&self, method: &str, params: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }
}

/// Per-connection state. Later tasks hang handles/freezes off this.
pub struct Session {
    pub conn: Conn,
    pub handles: Handles,
}

impl Session {
    pub fn new(conn: Conn) -> Self {
        Session { handles: Handles::new(conn.clone()), conn }
    }

    /// Handle one request line and write the response.
    pub fn handle_line(&mut self, line: &str) {
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                self.conn.send(&error_response(Value::Null, &RpcError::parse_error(e.to_string())));
                return;
            }
        };
        if !req.is_object() {
            self.conn.send(&error_response(Value::Null, &RpcError::invalid_params("request must be a JSON object")));
            return;
        }
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(Value::as_str);
        let result = match method {
            Some(m) => self.dispatch(m, req.get("params").unwrap_or(&Value::Null)),
            None => Err(RpcError::invalid_params("missing method")),
        };
        // Requests without an id are notifications: no response.
        let Some(id) = id else { return };
        let resp = match result {
            Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
            Err(e) => error_response(id, &e),
        };
        self.conn.send(&resp);
    }

    /// Add new methods here.
    fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value, RpcError> {
        match method {
            "hello" => Ok(json!({
                "protocol": PROTOCOL,
                "version": env!("CARGO_PKG_VERSION"),
                "capabilities": CAPABILITIES,
            })),
            "attach" => {
                let pid = param_u64(params, "pid")?;
                let pid = i32::try_from(pid).map_err(|_| RpcError::invalid_params("pid out of range"))?;
                Ok(json!({ "handle": self.handles.attach(pid)? }))
            }
            "detach" => {
                self.handles.detach(param_handle(params)?)?;
                Ok(json!({}))
            }
            "read" => {
                let t = self.handles.get(param_handle(params)?)?;
                let addr = param_addr(params, "address")?;
                let len = param_u64(params, "length")?;
                if len > MAX_READ {
                    return Err(RpcError::invalid_params(format!("length exceeds {MAX_READ}")));
                }
                let bytes = mem::read_bytes(&t, addr, len as usize)?;
                Ok(json!({ "bytes": to_hex(&bytes) }))
            }
            "modules" => {
                let t = self.handles.get(param_handle(params)?)?;
                let list = modules::list(&t)?;
                Ok(json!({ "modules": list }))
            }
            "write" => {
                let t = self.handles.get(param_handle(params)?)?;
                let addr = param_addr(params, "address")?;
                let data = from_hex(params.get("bytes").and_then(Value::as_str))?;
                mem::write_bytes(&t, addr, &data)?;
                Ok(json!({}))
            }
            "aob_scan" => {
                let t = self.handles.get(param_handle(params)?)?;
                let module = params
                    .get("module")
                    .and_then(Value::as_str)
                    .ok_or_else(|| RpcError::invalid_params("module must be a string"))?;
                let pattern = params
                    .get("pattern")
                    .and_then(Value::as_str)
                    .ok_or_else(|| RpcError::invalid_params("pattern must be a string"))?;
                let max = match params.get("max") {
                    None | Some(Value::Null) => 1000,
                    Some(_) => param_u64(params, "max")?.min(usize::MAX as u64) as usize,
                };
                let pattern = aob::Pattern::parse(pattern)?;
                let range = aob::module_range(&t, module)?;
                let matches: Vec<String> = aob::scan(&t, range, &pattern, max)?.iter().map(|a| format!("{a:#x}")).collect();
                Ok(json!({ "matches": matches }))
            }
            "resolve_pointer" => {
                let t = self.handles.get(param_handle(params)?)?;
                let base = param_addr(params, "base")?;
                let offsets = params
                    .get("offsets")
                    .and_then(Value::as_array)
                    .ok_or_else(|| RpcError::invalid_params("offsets must be an array of \"0x...\" strings"))?
                    .iter()
                    .map(|v| parse_hex(v.as_str()).ok_or_else(|| RpcError::invalid_params("offsets must be \"0x...\" hex strings")))
                    .collect::<Result<Vec<u64>, _>>()?;
                let module_base = match params.get("module") {
                    None | Some(Value::Null) => 0,
                    Some(v) => {
                        let name = v.as_str().ok_or_else(|| RpcError::invalid_params("module must be a string"))?;
                        aob::module_range(&t, name)?.0
                    }
                };
                let addr = pointer::resolve(&t, module_base.wrapping_add(base), &offsets)?;
                Ok(json!({ "address": format!("{addr:#x}") }))
            }
            "freeze" => {
                let handle = param_handle(params)?;
                let addr = param_addr(params, "address")?;
                let data = from_hex(params.get("bytes").and_then(Value::as_str))?;
                if data.is_empty() {
                    return Err(RpcError::invalid_params("bytes must not be empty"));
                }
                let interval = param_u64(params, "interval_ms")?;
                Ok(json!({ "id": self.handles.freeze(handle, addr, data, interval)? }))
            }
            "unfreeze" => {
                let id = u32::try_from(param_u64(params, "id")?).map_err(|_| RpcError::invalid_params("id out of range"))?;
                self.handles.unfreeze(id)?;
                Ok(json!({}))
            }
            other => Err(RpcError::method_not_found(format!("unknown method: {other}"))),
        }
    }
}

fn error_response(id: Value, e: &RpcError) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": e.code, "message": e.message } })
}

const MAX_READ: u64 = 64 * 1024 * 1024;

fn param_u64(params: &Value, key: &str) -> Result<u64, RpcError> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| RpcError::invalid_params(format!("{key} must be a non-negative integer")))
}

fn param_handle(params: &Value) -> Result<u32, RpcError> {
    u32::try_from(param_u64(params, "handle")?).map_err(|_| RpcError::invalid_params("handle out of range"))
}

fn parse_hex(s: Option<&str>) -> Option<u64> {
    s?.strip_prefix("0x").and_then(|h| u64::from_str_radix(h, 16).ok())
}

fn param_addr(params: &Value, key: &str) -> Result<u64, RpcError> {
    parse_hex(params.get(key).and_then(Value::as_str))
        .ok_or_else(|| RpcError::invalid_params(format!("{key} must be a \"0x...\" hex string")))
}

pub fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn from_hex(s: Option<&str>) -> Result<Vec<u8>, RpcError> {
    let s = s.ok_or_else(|| RpcError::invalid_params("bytes must be a hex string"))?;
    if s.len() % 2 != 0 || !s.is_ascii() {
        return Err(RpcError::invalid_params("bytes must be an even-length hex string"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| RpcError::invalid_params("bytes has non-hex characters")))
        .collect()
}
