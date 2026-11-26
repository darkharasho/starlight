//! JSON-RPC 2.0 plumbing: errors, a shared connection writer, and method dispatch.
use crate::cleanup::{self, Owner};
use crate::scan::{FirstReq, NextReq, Scans};
use crate::patch::Patches;
use crate::pointer_scan::{self, PointerScans};
use crate::speed::Speeds;
use crate::tracer::DrRw;
use crate::watch::{self, Watches};
use crate::{aob, asm, disasm, mem, modules, pointer, process::Handles, signature, speed, symbols};
use crate::arch::Bits;
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::time::Duration;
use std::sync::{Arc, Mutex};

pub const PROTOCOL: u64 = 3;
pub const CAPABILITIES: &[&str] = &["read", "write", "modules", "aob", "pointer", "freeze", "read_many", "scan", "symbols", "disasm", "signature", "assemble", "alloc", "patch", "watch", "pointer_scan", "speed", "aob_exec", "lua", "freeze_mask", "bits"];

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

/// Protocol v2 codes (D25). Each is first used by a later M2 task.
#[allow(dead_code)]
impl RpcError {
    pub fn symbol_not_found(m: impl Into<String>) -> Self { Self::new(-32008, m) }
    pub fn unknown_id(m: impl Into<String>) -> Self { Self::new(-32009, m) }
    pub fn assemble_failed(m: impl Into<String>) -> Self { Self::new(-32010, m) }
    pub fn alloc_failed(m: impl Into<String>) -> Self { Self::new(-32011, m) }
    pub fn ptrace_failed(m: impl Into<String>) -> Self { Self::new(-32012, m) }
    pub fn busy(m: impl Into<String>) -> Self { Self::new(-32013, m) }
    pub fn patch_conflict(m: impl Into<String>) -> Self { Self::new(-32014, m) }
    pub fn unsupported_target(m: impl Into<String>) -> Self { Self::new(-32015, m) }
    pub fn target_not_ready() -> Self { Self::new(-32016, "The game is still starting; try again in a moment.") }
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

/// Per-connection state, shared with worker threads running slow methods.
/// Later tasks add their per-connection tables here.
pub struct ConnState {
    pub handles: Handles,
    pub owner: Arc<Owner>,
    pub scans: Scans,
    pub pointer_scans: PointerScans,
    pub patches: Arc<Patches>,
    pub watches: Watches,
    pub speeds: Speeds,
    pub luas: crate::lua::Luas,
}

/// Methods that can take long; they run on their own thread and answer out of order,
/// so a long scan never stalls a cheat toggle on the same connection.
pub fn is_slow(method: &str) -> bool {
    matches!(
        method,
        "scan_first"
            | "scan_next"
            | "pointer_scan"
            | "pointer_rescan"
            | "make_signature"
            | "aob_scan"
            | "alloc"
            | "free"
            | "patch"
            | "unpatch"
            | "speed_set"
            | "speed_get"
            | "watch_start"
            | "watch_stop"
            | "debug_sleep"
            | "lua_run"
    )
}

pub struct Session {
    pub conn: Conn,
    pub state: Arc<ConnState>,
}

impl Session {
    pub fn new(conn: Conn) -> Self {
        let owner = Arc::new(Owner::default());
        cleanup::register(&owner);
        let patches = Arc::new(Patches::new(owner.clone()));
        let state = Arc::new(ConnState {
            handles: Handles::new(conn.clone(), owner.clone()),
            scans: Scans::new(owner.clone()),
            pointer_scans: PointerScans::new(owner.clone()),
            speeds: Speeds::new(owner.clone(), patches.clone()),
            patches,
            watches: Watches::new(owner.clone(), conn.clone()),
            luas: crate::lua::Luas::default(),
            owner,
        });
        Session { conn, state }
    }

    /// Handle one request line: answer inline, or on a worker thread for slow methods.
    pub fn handle_line(&self, line: &str) {
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
        let Some(method) = req.get("method").and_then(Value::as_str).map(str::to_owned) else {
            respond(&self.conn, id, Err(RpcError::invalid_params("missing method")));
            return;
        };
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        if is_slow(&method) {
            let (conn, state) = (self.conn.clone(), self.state.clone());
            std::thread::spawn(move || respond(&conn, id, dispatch(&state, &method, &params)));
        } else {
            respond(&self.conn, id, dispatch(&self.state, &method, &params));
        }
    }

    /// Connection end: revert everything this connection changed.
    pub fn close(&self) {
        self.state.owner.run_all();
    }
}

/// Requests without an id are notifications: no response.
fn respond(conn: &Conn, id: Option<Value>, result: Result<Value, RpcError>) {
    let Some(id) = id else { return };
    let resp = match result {
        Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
        Err(e) => error_response(id, &e),
    };
    conn.send(&resp);
}

/// Add new methods here (and to `is_slow` if they can take long).
fn dispatch(state: &ConnState, method: &str, params: &Value) -> Result<Value, RpcError> {
    let handles = &state.handles;
    match method {
        "hello" => Ok(json!({
            "protocol": PROTOCOL,
            "version": env!("CARGO_PKG_VERSION"),
            "capabilities": CAPABILITIES,
        })),
        "attach" => {
            let pid = param_u64(params, "pid")?;
            let pid = i32::try_from(pid).map_err(|_| RpcError::invalid_params("pid out of range"))?;
            let main_module = params.get("main_module").and_then(Value::as_str).map(str::to_string);
            let (handle, t) = handles.attach(pid, main_module)?;
            Ok(json!({ "handle": handle, "process_bits": t.process_bits.n(), "code_bits": t.code_bits().map(Bits::n) }))
        }
        "target_info" => {
            let t = handles.get(param_handle(params)?)?;
            Ok(json!({ "process_bits": t.process_bits.n(), "code_bits": t.code_bits().map(Bits::n) }))
        }
        "process_info" => {
            let pid = param_u64(params, "pid")?;
            let pid = i32::try_from(pid).map_err(|_| RpcError::invalid_params("pid out of range"))?;
            let main_module = params.get("main_module").and_then(Value::as_str).map(str::to_string);
            let (process_bits, code_bits) = crate::process::process_info(pid, main_module)?;
            Ok(json!({ "process_bits": process_bits.n(), "code_bits": code_bits.map(Bits::n) }))
        }
        "detach" => {
            handles.detach(param_handle(params)?)?;
            Ok(json!({}))
        }
        "read" => {
            let t = handles.get(param_handle(params)?)?;
            let addr = param_addr(params, "address")?;
            let len = param_u64(params, "length")?;
            if len > MAX_READ {
                return Err(RpcError::invalid_params(format!("length exceeds {MAX_READ}")));
            }
            let bytes = mem::read_bytes(&t, addr, len as usize)?;
            Ok(json!({ "bytes": to_hex(&bytes) }))
        }
        "read_many" => {
            let t = handles.get(param_handle(params)?)?;
            let items = params
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| RpcError::invalid_params("items must be an array"))?;
            if items.len() > MAX_MANY_ITEMS {
                return Err(RpcError::invalid_params(format!("at most {MAX_MANY_ITEMS} items")));
            }
            let items = items
                .iter()
                .map(|it| {
                    let len = param_u64(it, "length")?;
                    if len > MAX_MANY_LENGTH {
                        return Err(RpcError::invalid_params(format!("item length exceeds {MAX_MANY_LENGTH}")));
                    }
                    Ok((param_addr(it, "address")?, len as usize))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let values: Vec<Value> = items
                .into_iter()
                .map(|(addr, len)| mem::read_bytes(&t, addr, len).map_or(Value::Null, |b| Value::String(to_hex(&b))))
                .collect();
            Ok(json!({ "values": values }))
        }
        "scan_first" => {
            let handle = param_handle(params)?;
            let t = handles.get(handle)?;
            let req: FirstReq = from_params(params)?;
            let (scan, count) = state.scans.first(t, handle, req)?;
            // Detach runs the handle's teardown, then drops it: rechecking after the session's
            // teardown was registered means no scan outlives its handle.
            if handles.get(handle).is_err() {
                let _ = state.scans.end(scan);
                return Err(RpcError::unknown_handle(format!("unknown handle: {handle}")));
            }
            Ok(json!({ "scan": scan, "count": count }))
        }
        "scan_next" => {
            let scan = param_scan(params)?;
            let req: NextReq = from_params(params)?;
            Ok(json!({ "count": state.scans.next(scan, req)? }))
        }
        "scan_results" => {
            let scan = param_scan(params)?;
            let offset = match params.get("offset") {
                None | Some(Value::Null) => 0,
                Some(_) => param_u64(params, "offset")?,
            };
            let limit = match params.get("limit") {
                None | Some(Value::Null) => 100,
                Some(_) => param_u64(params, "limit")?,
            };
            if limit > MAX_RESULTS_PAGE {
                return Err(RpcError::invalid_params(format!("limit exceeds {MAX_RESULTS_PAGE}")));
            }
            let (count, results) = state.scans.results(scan, offset, limit as usize)?;
            let results: Vec<Value> = results
                .into_iter()
                .map(|(a, v)| json!({ "address": format!("{a:#x}"), "value": v }))
                .collect();
            Ok(json!({ "count": count, "results": results }))
        }
        "scan_end" => {
            state.scans.end(param_scan(params)?)?;
            Ok(json!({}))
        }
        "modules" => {
            let t = handles.get(param_handle(params)?)?;
            let list = modules::list(&t)?;
            Ok(json!({ "modules": list }))
        }
        "module_exports" => {
            let t = handles.get(param_handle(params)?)?;
            let name = param_str(params, "module")?;
            let mods = modules::list(&t)?;
            let m = modules::find(&mods, name)
                .ok_or_else(|| RpcError::module_not_found(format!("module not found: {name}")))?;
            let exports: Vec<Value> = symbols::exports(&t, m)?
                .into_iter()
                .map(|e| {
                    let mut v = json!({ "name": e.name, "address": format!("{:#x}", e.address), "kind": e.kind.as_str() });
                    if let Some(f) = e.forwarder {
                        v["forwarder"] = Value::String(f);
                    }
                    v
                })
                .collect();
            Ok(json!({ "exports": exports }))
        }
        "resolve_symbol" => {
            let t = handles.get(param_handle(params)?)?;
            let (module, name) = (param_str(params, "module")?, param_str(params, "name")?);
            let mods = modules::list(&t)?;
            let address = symbols::resolve(&t, &mods, module, name)?;
            Ok(json!({ "address": format!("{address:#x}") }))
        }
        "disassemble" => {
            let t = handles.get(param_handle(params)?)?;
            let addr = param_addr(params, "address")?;
            let count = match params.get("count") {
                None | Some(Value::Null) => 20,
                Some(_) => param_u64(params, "count")?,
            };
            if count == 0 || count > MAX_DISASM_COUNT {
                return Err(RpcError::invalid_params(format!("count must be 1..={MAX_DISASM_COUNT}")));
            }
            let count = count as usize;
            let bytes = disasm::read_code(&t, addr, count * disasm::MAX_INSN_LEN)?;
            let sym = disasm::Symbolizer::new(&modules::list(&t)?);
            let instructions: Vec<Value> = disasm::decode(&bytes, addr, count, disasm::bits_of(&t))
                .into_iter()
                .map(|i| {
                    let mut v = json!({
                        "address": format!("{:#x}", i.address),
                        "length": i.length,
                        "bytes": to_hex(&i.bytes),
                        "text": i.text,
                        "symbol": sym.name(i.address),
                    });
                    if let Some(tg) = i.target {
                        v["target"] = json!({ "address": format!("{tg:#x}"), "symbol": sym.name(tg) });
                    }
                    v
                })
                .collect();
            Ok(json!({ "instructions": instructions }))
        }
        "make_signature" => {
            let t = handles.get(param_handle(params)?)?;
            let addr = param_addr(params, "address")?;
            let max_len = match params.get("max_length") {
                None | Some(Value::Null) => 64,
                Some(_) => param_u64(params, "max_length")?,
            };
            if max_len == 0 || max_len > 4096 {
                return Err(RpcError::invalid_params("max_length must be 1..=4096"));
            }
            let s = signature::build(&t, addr, max_len as usize)?;
            Ok(json!({ "pattern": s.pattern, "offset": 0, "module": s.module, "length": s.length, "unique": s.unique, "matches": s.matches }))
        }
        "assemble" => {
            let addr = param_addr(params, "address")?;
            let source = param_str(params, "source")?;
            // Supplied symbols first, then (with a handle) module names.
            let mut syms = std::collections::HashMap::new();
            match params.get("symbols") {
                None | Some(Value::Null) => {}
                Some(Value::Object(m)) => {
                    for (name, v) in m {
                        let a = parse_hex(v.as_str())
                            .ok_or_else(|| RpcError::invalid_params(format!("symbols.{name} must be a \"0x...\" hex string")))?;
                        syms.insert(name.to_ascii_lowercase(), a);
                    }
                }
                Some(_) => return Err(RpcError::invalid_params("symbols must be an object")),
            }
            let target = match params.get("handle") {
                None | Some(Value::Null) => None,
                Some(_) => Some(handles.get(param_handle(params)?)?),
            };
            // Explicit bits, else the game's (an error while unknown), else 64.
            let bits = match params.get("bits") {
                None | Some(Value::Null) => match &target {
                    Some(t) => t.require_code_bits()?,
                    None => Bits::B64,
                },
                Some(v) => match v.as_u64() {
                    Some(32) => Bits::B32,
                    Some(64) => Bits::B64,
                    _ => return Err(RpcError::invalid_params("bits must be 32 or 64")),
                },
            };
            let mods = match &target {
                None => vec![],
                Some(t) => modules::list(t)?,
            };
            let resolve = |name: &str| {
                syms.get(&name.to_ascii_lowercase()).copied().or_else(|| modules::find(&mods, name).map(|m| m.base))
            };
            let a = asm::assemble(source, addr, bits, &resolve).map_err(|e| RpcError::assemble_failed(e.to_string()))?;
            let labels: serde_json::Map<String, Value> =
                a.labels.iter().map(|(k, v)| (k.clone(), Value::String(format!("{v:#x}")))).collect();
            Ok(json!({ "bytes": to_hex(&a.bytes), "length": a.bytes.len(), "labels": labels }))
        }
        "write" => {
            let t = handles.get(param_handle(params)?)?;
            let addr = param_addr(params, "address")?;
            let data = from_hex(params.get("bytes").and_then(Value::as_str))?;
            mem::write_bytes(&t, addr, &data)?;
            Ok(json!({}))
        }
        "aob_scan" => {
            let t = handles.get(param_handle(params)?)?;
            // No module (protocol 3, `aob_exec`): every executable region (M4 D10).
            let module = match params.get("module") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_str().ok_or_else(|| RpcError::invalid_params("module must be a string"))?),
            };
            let pattern = params
                .get("pattern")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::invalid_params("pattern must be a string"))?;
            let max = match params.get("max") {
                None | Some(Value::Null) => 1000,
                Some(_) => param_u64(params, "max")?.min(usize::MAX as u64) as usize,
            };
            let pattern = aob::Pattern::parse(pattern)?;
            let found = match module {
                Some(module) => aob::scan(&t, aob::module_range(&t, module)?, &pattern, max)?,
                None => aob::scan_exec(&t, &pattern, max)?,
            };
            let matches: Vec<String> = found.iter().map(|a| format!("{a:#x}")).collect();
            Ok(json!({ "matches": matches }))
        }
        "resolve_pointer" => {
            let t = handles.get(param_handle(params)?)?;
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
            let size = match params.get("pointer_size") {
                None | Some(Value::Null) => t.require_code_bits()?.ptr_size(),
                Some(v) => match v.as_u64() {
                    Some(4) => 4,
                    Some(8) => 8,
                    _ => return Err(RpcError::invalid_params("pointer_size must be 4 or 8")),
                },
            };
            let addr = pointer::resolve(&t, module_base.wrapping_add(base), &offsets, size)?;
            Ok(json!({ "address": format!("{addr:#x}") }))
        }
        "pointer_scan" => {
            let t = handles.get(param_handle(params)?)?;
            let address = param_addr(params, "address")?;
            let opts = pointer_opts(params)?;
            let (id, count, truncated) = state.pointer_scans.start(&t, address, &opts)?;
            Ok(json!({ "id": id, "count": count, "truncated": truncated }))
        }
        "pointer_results" => {
            let id = param_id(params)?;
            let offset = match params.get("offset") {
                None | Some(Value::Null) => 0,
                Some(_) => param_u64(params, "offset")?,
            };
            let limit = match params.get("limit") {
                None | Some(Value::Null) => 100,
                Some(_) => param_u64(params, "limit")?,
            };
            if limit > MAX_RESULTS_PAGE {
                return Err(RpcError::invalid_params(format!("limit exceeds {MAX_RESULTS_PAGE}")));
            }
            let (count, results) = state.pointer_scans.results(id, offset, limit as usize)?;
            Ok(json!({ "count": count, "results": results }))
        }
        "pointer_rescan" => {
            let id = param_id(params)?;
            let t = handles.get(param_handle(params)?)?;
            let address = match params.get("address") {
                None | Some(Value::Null) => None,
                Some(_) => Some(param_addr(params, "address")?),
            };
            Ok(json!({ "count": state.pointer_scans.rescan(id, &t, address)? }))
        }
        "pointer_end" => {
            state.pointer_scans.end(param_id(params)?)?;
            Ok(json!({}))
        }
        "alloc" => {
            let handle = param_handle(params)?;
            let size = param_u64(params, "size")?;
            if size == 0 || size > MAX_ALLOC {
                return Err(RpcError::invalid_params(format!("size must be 1..={MAX_ALLOC}")));
            }
            let near = match params.get("near") {
                None | Some(Value::Null) => None,
                Some(_) => Some(param_addr(params, "near")?),
            };
            let prot = match params.get("prot") {
                None | Some(Value::Null) => "rwx",
                Some(v) => v.as_str().ok_or_else(|| RpcError::invalid_params("prot must be \"rwx\", \"rw\" or \"rx\""))?,
            };
            let prot = match prot {
                "rwx" => libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC,
                "rw" => libc::PROT_READ | libc::PROT_WRITE,
                "rx" => libc::PROT_READ | libc::PROT_EXEC,
                _ => return Err(RpcError::invalid_params("prot must be \"rwx\", \"rw\" or \"rx\"")),
            };
            let (address, size) = handles.alloc(handle, size, near, prot)?;
            Ok(json!({ "address": format!("{address:#x}"), "size": size }))
        }
        "free" => {
            let handle = param_handle(params)?;
            handles.free(handle, param_addr(params, "address")?)?;
            Ok(json!({}))
        }
        "patch" => {
            let handle = param_handle(params)?;
            let t = handles.get(handle)?;
            let addr = param_addr(params, "address")?;
            let data = from_hex(params.get("bytes").and_then(Value::as_str))?;
            if data.is_empty() || data.len() > MAX_PATCH {
                return Err(RpcError::invalid_params(format!("bytes must be 1..={MAX_PATCH} bytes")));
            }
            let (id, original) = state.patches.apply(handle, &t, addr, &data)?;
            // As for scans: detach runs the handle's teardown, then drops it. If it did so before
            // this patch's teardown was registered, revert it here so it never outlives the handle.
            if handles.get(handle).is_err() {
                let _ = state.patches.revert(id, true);
                return Err(RpcError::unknown_handle(format!("unknown handle: {handle}")));
            }
            Ok(json!({ "id": id, "original": to_hex(&original) }))
        }
        "unpatch" => {
            let id = u32::try_from(param_u64(params, "id")?).map_err(|_| RpcError::invalid_params("id out of range"))?;
            let force = match params.get("force") {
                None | Some(Value::Null) => false,
                Some(v) => v.as_bool().ok_or_else(|| RpcError::invalid_params("force must be a boolean"))?,
            };
            state.patches.revert(id, force)?;
            Ok(json!({}))
        }
        "watch_start" => {
            let handle = param_handle(params)?;
            let t = handles.get(handle)?;
            let addr = param_addr(params, "address")?;
            let size = param_u64(params, "size")?;
            let rw = match param_str(params, "kind")? {
                "write" => DrRw::Write,
                "access" => DrRw::Access,
                _ => return Err(RpcError::invalid_params("kind must be \"write\" or \"access\"")),
            };
            let duration_ms = match params.get("duration_ms") {
                None | Some(Value::Null) => watch::DEFAULT_DURATION_MS,
                Some(_) => param_u64(params, "duration_ms")?,
            };
            let max_hits = match params.get("max_hits") {
                None | Some(Value::Null) => watch::DEFAULT_MAX_HITS,
                Some(_) => param_u64(params, "max_hits")?,
            };
            let id = state.watches.start(handle, t, addr, size, rw, duration_ms, max_hits)?;
            // As for patches: if detach ran the handle's teardown before this watch's was
            // registered, end it here so it never outlives the handle.
            if handles.get(handle).is_err() {
                state.watches.cancel(id);
                return Err(RpcError::unknown_handle(format!("unknown handle: {handle}")));
            }
            Ok(json!({ "id": id }))
        }
        "speed_set" => {
            let handle = param_handle(params)?;
            let t = handles.get(handle)?;
            let speed = params
                .get("speed")
                .and_then(Value::as_f64)
                .ok_or_else(|| RpcError::invalid_params("speed must be a number"))?;
            let targets = speed_targets(params)?;
            let status = state.speeds.set(handle, &t, speed, targets)?;
            // As for patches: if detach ran the handle's teardown before the speed state's was
            // registered (or while hooks were going in), undo it here so no hook outlives it.
            if handles.get(handle).is_err() {
                state.speeds.release(handle);
                return Err(RpcError::unknown_handle(format!("unknown handle: {handle}")));
            }
            Ok(speed_json(&status))
        }
        "speed_get" => {
            let handle = param_handle(params)?;
            let t = handles.get(handle)?;
            Ok(speed_json(&state.speeds.get(handle, &t)?))
        }
        "watch_poll" => state.watches.poll(param_id(params)?),
        "watch_stop" => state.watches.stop(param_id(params)?),
        "freeze" => {
            let handle = param_handle(params)?;
            let addr = param_addr(params, "address")?;
            let data = from_hex(params.get("bytes").and_then(Value::as_str))?;
            if data.is_empty() {
                return Err(RpcError::invalid_params("bytes must not be empty"));
            }
            let mask = match params.get("mask").and_then(Value::as_str) {
                Some(m) => Some(from_hex(Some(m))?),
                None => None,
            };
            let interval = param_u64(params, "interval_ms")?;
            Ok(json!({ "id": handles.freeze(handle, addr, data, mask, interval)? }))
        }
        "lua_open" => {
            let handle = param_handle(params)?;
            let t = handles.get(handle)?;
            let process = params.get("process").and_then(Value::as_str).map(str::to_string);
            Ok(json!({ "id": state.luas.open(handle, t, process)? }))
        }
        "lua_run" => {
            let id = param_id(params)?;
            let t = handles.get(state.luas.handle_of(id)?)?;
            state.luas.run(id, t, params)
        }
        "lua_close" => {
            state.luas.close(param_id(params)?)?;
            Ok(json!({}))
        }
        "unfreeze" => {
            let id = u32::try_from(param_u64(params, "id")?).map_err(|_| RpcError::invalid_params("id out of range"))?;
            handles.unfreeze(id)?;
            Ok(json!({}))
        }
        #[cfg(debug_assertions)]
        "debug_sleep" => {
            let ms = param_u64(params, "ms")?.min(60_000);
            std::thread::sleep(Duration::from_millis(ms));
            Ok(json!({}))
        }
        #[cfg(debug_assertions)]
        "debug_on_cleanup" => {
            let handle = match params.get("handle") {
                None | Some(Value::Null) => None,
                Some(_) => {
                    let h = param_handle(params)?;
                    handles.get(h)?;
                    Some(h)
                }
            };
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::invalid_params("path must be a string"))?
                .to_owned();
            state.owner.add(handle, cleanup::Teardown::Scan, Box::new(move || {
                let _ = std::fs::File::create(&path);
            }));
            Ok(json!({}))
        }
        other => Err(RpcError::method_not_found(format!("unknown method: {other}"))),
    }
}

fn speed_json(s: &speed::Status) -> Value {
    let hooks: Vec<Value> = s
        .hooks
        .iter()
        .map(|h| {
            let mut v = json!({
                "name": h.name,
                "address": format!("{:#x}", h.address),
                "status": if h.skipped.is_some() { "skipped" } else { "hooked" },
            });
            if let Some(r) = &h.skipped {
                v["reason"] = Value::String(r.clone());
            }
            v
        })
        .collect();
    json!({ "speed": s.speed, "hooks": hooks })
}

/// `speed_set.targets` (debug builds only): `[{ name, address, abi, kind }]` replaces discovery.
#[cfg(debug_assertions)]
fn speed_targets(params: &Value) -> Result<Option<Vec<speed::targets::HookTarget>>, RpcError> {
    let list = match params.get("targets") {
        None | Some(Value::Null) => return Ok(None),
        Some(v) => v.as_array().ok_or_else(|| RpcError::invalid_params("targets must be an array"))?,
    };
    list.iter()
        .map(|it| {
            let name = param_str(it, "name")?.to_string();
            let address = param_addr(it, "address")?;
            let abi = speed::Abi::parse(param_str(it, "abi")?)
                .ok_or_else(|| RpcError::invalid_params("abi must be \"win64\" or \"sysv\""))?;
            let kind = match speed::Kind::parse(param_str(it, "kind")?) {
                // Needs the original and GOT slots that only discovery finds.
                Some(speed::Kind::GettimeofdayGot) | None => {
                    return Err(RpcError::invalid_params(
                        "kind must be \"qpc\", \"nt_qpc\", \"tick32\", \"tick64\", \"clock_gettime\" or \"gettimeofday\"",
                    ))
                }
                Some(k) => k,
            };
            let slot = speed::targets::default_slot(kind, &name);
            Ok(speed::targets::HookTarget { name, address, abi, kind, slot, original: None, got_slots: vec![], skipped: None })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

#[cfg(not(debug_assertions))]
fn speed_targets(params: &Value) -> Result<Option<Vec<speed::targets::HookTarget>>, RpcError> {
    match params.get("targets") {
        None | Some(Value::Null) => Ok(None),
        Some(_) => Err(RpcError::invalid_params("targets is only accepted by debug builds")),
    }
}

fn error_response(id: Value, e: &RpcError) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": e.code, "message": e.message } })
}

const MAX_READ: u64 = 64 * 1024 * 1024;
const MAX_MANY_ITEMS: usize = 4096;
const MAX_MANY_LENGTH: u64 = 4096;
const MAX_RESULTS_PAGE: u64 = 1000;
const MAX_DISASM_COUNT: u64 = 500;
const MAX_ALLOC: u64 = 64 * 1024 * 1024;
const MAX_PATCH: usize = 4096;

/// An integer, or a "0x..." hex string.
fn param_num(params: &Value, key: &str) -> Result<Option<u64>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => parse_hex(Some(s)).map(Some).ok_or_else(|| RpcError::invalid_params(format!("{key} must be an integer or a \"0x...\" hex string"))),
        Some(_) => param_u64(params, key).map(Some),
    }
}

fn pointer_opts(params: &Value) -> Result<pointer_scan::Opts, RpcError> {
    let mut o = pointer_scan::Opts::default();
    if let Some(d) = param_num(params, "max_depth")? {
        if d == 0 || d > pointer_scan::MAX_DEPTH as u64 {
            return Err(RpcError::invalid_params(format!("max_depth must be 1..={}", pointer_scan::MAX_DEPTH)));
        }
        o.max_depth = d as u8;
    }
    if let Some(v) = param_num(params, "max_offset")? {
        if v > pointer_scan::MAX_OFFSET {
            return Err(RpcError::invalid_params(format!("max_offset must be at most {:#x}", pointer_scan::MAX_OFFSET)));
        }
        o.max_offset = v;
    }
    if let Some(v) = param_num(params, "max_results")? {
        if v == 0 || v > pointer_scan::MAX_RESULTS as u64 {
            return Err(RpcError::invalid_params(format!("max_results must be 1..={}", pointer_scan::MAX_RESULTS)));
        }
        o.max_results = v as usize;
    }
    o.modules = match params.get("modules") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_array()
                .ok_or_else(|| RpcError::invalid_params("modules must be an array of names"))?
                .iter()
                .map(|n| n.as_str().map(str::to_owned).ok_or_else(|| RpcError::invalid_params("modules must be an array of names")))
                .collect::<Result<_, _>>()?,
        ),
    };
    Ok(o)
}

fn param_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params(format!("{key} must be a string")))
}

fn param_id(params: &Value) -> Result<u32, RpcError> {
    u32::try_from(param_u64(params, "id")?).map_err(|_| RpcError::invalid_params("id out of range"))
}

fn param_scan(params: &Value) -> Result<u32, RpcError> {
    u32::try_from(param_u64(params, "scan")?).map_err(|_| RpcError::invalid_params("scan out of range"))
}

/// Deserialize a method's params struct; a bad shape is `-32602`.
fn from_params<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T, RpcError> {
    T::deserialize(params).map_err(|e| RpcError::invalid_params(e.to_string()))
}

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
