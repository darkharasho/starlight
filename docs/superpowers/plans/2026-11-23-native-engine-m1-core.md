# Native Engine — Milestone 1 (Engine Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Frida engine with `starlightd`, a Rust sidecar that reads and writes game memory from outside the game (native and Proton), and refuse to attach to games with anti-cheat loaded on both engines.

**Architecture:** `starlightd` is a standalone Rust binary that speaks newline-delimited JSON-RPC 2.0 over a Unix socket. `@starlight/engine` keeps its public API (`read`, `write`, `aobScan`, `resolvePointerChain`, `freeze`, errors) but becomes a thin client of the daemon. A new `starlightd-host.ts` in Electron main copies the bundled binary into the writable runtime dir, starts and supervises it, and hands out a client to `engine-host.ts`.

**Tech Stack:** Rust (stable, edition 2021; deps limited to `serde`, `serde_json`, `libc`), TypeScript, Node 20, Electron 32, vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-native-engine-agent-design.md` (milestone 1 of §11). Later milestones get their own plans.

## Global Constraints

- Linux x86-64 only. No code is injected into the game. Reads use `process_vm_readv`; writes use `pwrite` on `/proc/<pid>/mem` (works on read-only pages, needed later for code patches).
- Rust dependencies: only `serde` (derive), `serde_json`, `libc`. Anything else needs a permissive license (MIT/Apache-2.0/BSD) and a reason in the commit message.
- Protocol version is `1`. Every daemon reports it in `hello`, and the client refuses a daemon whose protocol doesn't match.
- Addresses on the wire are lowercase `"0x…"` hex strings (u64). Byte buffers are lowercase hex strings without spaces.
- The daemon binary must never run from inside the AppImage. It runs from `<userData>/runtime/starlightd/starlightd`, because `setcap` can't mark files on the read-only squashfs.
- The installed copy is only replaced when its sha256 differs from the bundled one, because replacing it drops `cap_sys_ptrace` and causes a new password prompt.
- If `kernel.yama.ptrace_scope` is `0`, never prompt for ptrace permission.
- Anti-cheat refusal applies to **both** engines (starlightd and CE). It triggers only when anti-cheat modules are **mapped in the running process**. Files on disk and env vars don't count. There is no override.
- No copying of Cheat Engine source.
- vitest runs with at most 2 workers (existing configs already do this; keep it).
- Single-player only: no anti-cheat evasion features of any kind.

## Review Focus

1. **Paths with spaces in `/proc/<pid>/maps`.** Proton games live under `steamapps/common/9 Kings/…` and `Proton - Experimental/`. Module names must still resolve. The test is in Task 1 (`parses_path_with_spaces_and_deleted_suffix`).
2. **The game exits while a cheat is frozen.** The daemon must stop the freeze, send `process_exited`, and keep serving other requests. The test is in Task 5 (`freeze_stops_and_notifies_when_target_exits`).
3. **Starlight quits or crashes.** The daemon must exit, so nothing keeps writing to the game. The test is in Task 1 (`exits_when_stdin_closes`).
4. **Reading an unmapped or partly mapped address.** This must return a `ReadFailed` error, not partial bytes and not a crash. The test is in Task 2 (`read_unmapped_is_error`).
5. **Case-insensitive PE module names.** CE tables say `gameassembly.dll` as often as `GameAssembly.dll`. The test is in Task 3 (`pe_module_lookup_is_case_insensitive`).
6. **The daemon dies mid-session.** The next attach must start a new daemon instead of reusing a dead socket. The test is in Task 7 (`respawns daemon after it dies`).

---

## File Structure

**New crate `packages/starlightd/`** (Rust, built with `cargo`; not a pnpm workspace member):
- `Cargo.toml`
- `src/main.rs` — CLI (`--socket <path>`), socket listener, exits on stdin EOF
- `src/rpc.rs` — JSON-RPC framing, method dispatch, error codes, per-connection writer
- `src/maps.rs` — `/proc/<pid>/maps` parsing
- `src/process.rs` — handle table, attach/detach, pidfd exit watcher
- `src/mem.rs` — `read_bytes`, `write_bytes`
- `src/modules.rs` — ELF + PE module list, case-insensitive lookup, PE header parsing
- `src/aob.rs` — pattern parsing and scanning
- `src/pointer.rs` — pointer-chain resolution
- `src/freeze.rs` — freeze threads
- `tests/common/mod.rs` — spawns the daemon and the C test target, plus a JSON-RPC test client
- `tests/*.rs` — integration tests, one file per task

**Modified test target:** `packages/engine/test-target/target.c` gets a `--map <file>` option that mmaps a file read-only (for PE tests without Wine).

**`packages/engine/`** (rewritten internals, same public API):
- `src/client.ts` (new) — `EngineClient`, `connectEngine`, `startEngine`
- `src/session.ts`, `src/memory.ts`, `src/aob-scan.ts`, `src/pointer-chain.ts`, `src/freeze.ts` — reimplemented on the client
- `src/modules.ts` (new) — `listModules`
- `test/helpers/daemon.ts` (new) — starts the debug daemon for tests

**`apps/desktop/`:**
- `src/main/starlightd-host.ts` (new) — install, start, supervise, `getEngineClient`, `restartEngine`
- `src/main/anti-cheat.ts` + `src/main/anti-cheat-signatures.json` (new)
- `src/main/engine-host.ts` — uses `getEngineClient()`, `session.onDetached`, and the anti-cheat check
- `src/main/ce-session.ts` — anti-cheat check after the pid is known
- `src/main/ce-native.ts` — `grantPtraceCap` accepts several binaries
- `src/main/index.ts` — ptrace grant covers starlightd; stop the daemon on quit
- `src/shared/ipc.ts` — `'anti-cheat'` codes and reasons
- `electron-builder.yml`, `electron.vite.config.ts`, `package.json` — drop frida, bundle starlightd

**CI:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`.

---

## Protocol v1 (shared reference for Tasks 1–6)

Requests and responses are JSON-RPC 2.0, one JSON object per line. Notifications from the daemon have no `id`.

| Method | Params | Result |
|---|---|---|
| `hello` | `{}` | `{ protocol: 1, version: string, capabilities: string[] }` (capabilities in M1: `["read","write","modules","aob","pointer","freeze"]`) |
| `attach` | `{ pid }` | `{ handle: number }` |
| `detach` | `{ handle }` | `{}` |
| `modules` | `{ handle }` | `{ modules: [{ name, base, size, path, kind: "elf" \| "pe" }] }` |
| `read` | `{ handle, address, length }` | `{ bytes }` |
| `write` | `{ handle, address, bytes }` | `{}` |
| `aob_scan` | `{ handle, module, pattern, max? }` (`max` defaults to 1000) | `{ matches: string[] }` (ascending) |
| `resolve_pointer` | `{ handle, module?, base, offsets: string[] }` | `{ address }` |
| `freeze` | `{ handle, address, bytes, interval_ms }` | `{ id: number }` |
| `unfreeze` | `{ id }` | `{}` |

Notification: `{ "jsonrpc":"2.0", "method":"process_exited", "params":{ "handle": N } }`, sent once to the connection that owns the handle.

Error codes: `-32700` parse error, `-32601` method not found, `-32602` invalid params, `-32001` `PermissionDenied`, `-32002` `ProcessNotFound`, `-32003` `ReadFailed`, `-32004` `WriteFailed`, `-32005` `ModuleNotFound`, `-32006` `InvalidPattern`, `-32007` `UnknownHandle`.

Ownership: handles and freezes belong to the connection that created them. When the connection closes, all of them are detached or cancelled.

---

### Task 1: Crate scaffold, JSON-RPC server, maps parser

**Files:**
- Create: `packages/starlightd/Cargo.toml`, `src/main.rs`, `src/rpc.rs`, `src/maps.rs`, `tests/common/mod.rs`, `tests/server.rs`
- Modify: `.gitignore` (add `packages/starlightd/target/`)

**Interfaces:**
- Produces (Rust): `maps::Region { start: u64, end: u64, perms: Perms { read, write, exec, shared: bool }, offset: u64, path: Option<String> }`; `maps::parse(text: &str) -> Vec<Region>`; `maps::read(pid: i32) -> io::Result<Vec<Region>>`; `rpc::RpcError { code: i64, message: String }` with constructors for each error code above; `rpc::Conn` (cloneable, thread-safe writer with `send_notification(method, params)`).
- Produces (CLI): `starlightd --socket <path>`. It removes any stale socket file, binds, `chmod 0600`, prints `READY 1\n` to stdout, and exits 0 when stdin reaches EOF.
- Produces (tests): `tests/common/mod.rs` exports `Daemon::start() -> Daemon` (spawns `env!("CARGO_BIN_EXE_starlightd")` with a temp socket, waits for `READY`), `Daemon::client() -> Client`, `Daemon::socket_path() -> &Path`, `Daemon::close_stdin()`, `Daemon::wait_exit(timeout) -> Option<ExitStatus>`, `Client::call(method, params: Value) -> Result<Value, (i64, String)>`, `Client::next_notification(timeout) -> Option<Value>`, `Target::spawn(args: &[&str]) -> Target` (runs `../engine/test-target/build/target`, parses its `addr name=0x…` / `offset name=N` lines into maps), `Target::kill()`.

- [ ] **Step 1: Write the failing tests**

In `src/maps.rs` (unit tests):
```rust
#[test] fn parses_basic_line() {
    let r = parse("00400000-00401000 r-xp 00000000 08:01 1234  /usr/bin/target\n");
    assert_eq!(r[0].start, 0x400000); assert_eq!(r[0].end, 0x401000);
    assert!(r[0].perms.read && r[0].perms.exec && !r[0].perms.write);
    assert_eq!(r[0].path.as_deref(), Some("/usr/bin/target"));
}
#[test] fn parses_path_with_spaces_and_deleted_suffix() {
    let r = parse("7f0000000000-7f0000001000 r--p 00000000 00:2a 99 /home/u/.steam/steamapps/common/9 Kings/GameAssembly.dll (deleted)\n");
    assert_eq!(r[0].path.as_deref(), Some("/home/u/.steam/steamapps/common/9 Kings/GameAssembly.dll"));
}
#[test] fn anonymous_and_pseudo_paths() {
    let r = parse("1000-2000 rw-p 00000000 00:00 0 \n3000-4000 rw-p 00000000 00:00 0  [heap]\n");
    assert_eq!(r[0].path, None); assert_eq!(r[1].path.as_deref(), Some("[heap]"));
}
```
In `tests/server.rs`:
```rust
#[test] fn hello_reports_protocol_1() {
    let d = Daemon::start(); let mut c = d.client();
    let v = c.call("hello", json!({})).unwrap();
    assert_eq!(v["protocol"], 1);
    assert!(v["capabilities"].as_array().unwrap().iter().any(|x| x == "read"));
}
#[test] fn unknown_method_is_32601() {
    let d = Daemon::start(); let mut c = d.client();
    assert_eq!(c.call("nope", json!({})).unwrap_err().0, -32601);
}
#[test] fn exits_when_stdin_closes() {
    let mut d = Daemon::start(); d.close_stdin();
    assert!(d.wait_exit(Duration::from_secs(1)).is_some());
}
#[test] fn socket_is_private() {
    let d = Daemon::start();
    assert_eq!(fs::metadata(d.socket_path()).unwrap().permissions().mode() & 0o777, 0o600);
}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/starlightd && cargo test`
Expected: compile errors (missing items).

- [ ] **Step 3: Implement**

`maps::parse` splits off the first five whitespace-separated fields and treats the **rest of the line, trimmed**, as the path. It strips a trailing ` (deleted)`; an empty rest means `None`. The server spawns one thread per connection, reads lines with `BufRead`, and dispatches through a `match` on the method name. Unknown methods return `-32601`, and malformed JSON returns `-32700` with `id: null`. A separate thread blocks on stdin and calls `std::process::exit(0)` at EOF.

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/starlightd && cargo test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd .gitignore
git commit -m "feat(starlightd): crate scaffold, JSON-RPC server, maps parser"
```

---

### Task 2: Attach, detach, read, write, process-exit notification

**Files:**
- Create: `packages/starlightd/src/process.rs`, `src/mem.rs`, `tests/memory.rs`
- Modify: `src/rpc.rs` (dispatch)

**Interfaces:**
- Consumes: `maps::read`, `rpc::Conn`, `RpcError` (Task 1).
- Produces (Rust): `process::Handles` (per-connection) with `attach(pid) -> Result<u32, RpcError>`, `get(handle) -> Result<Arc<Target>, RpcError>`, `detach(handle)`, `detach_all()`; `Target { pid: i32, pidfd: OwnedFd, mem: File /* /proc/pid/mem, O_RDWR */ }`; `mem::read_bytes(t: &Target, addr: u64, len: usize) -> Result<Vec<u8>, RpcError>` (fails with `ReadFailed` unless all `len` bytes were read); `mem::write_bytes(t: &Target, addr: u64, data: &[u8]) -> Result<(), RpcError>`.
- Produces (protocol): `attach`, `detach`, `read`, `write`, and the `process_exited` notification.

- [ ] **Step 1: Write the failing tests** (`tests/memory.rs`, against the C target)

```rust
#[test] fn reads_int32_health() {          // g_health = 100
    let t = Target::spawn(&[]); let d = Daemon::start(); let mut c = d.client();
    let h = c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone();
    let v = c.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap();
    assert_eq!(v["bytes"], "64000000");
}
#[test] fn write_then_read_roundtrip() {   // write 999 to g_health → reads back "e7030000"
    /* attach as above */ c.call("write", json!({"handle": h, "address": t.addr("g_health"), "bytes": "e7030000"})).unwrap();
    assert_eq!(c.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap()["bytes"], "e7030000");
}
#[test] fn read_unmapped_is_error() {
    /* attach */ assert_eq!(c.call("read", json!({"handle": h, "address": "0x0", "length": 4})).unwrap_err().0, -32003);
}
#[test] fn attach_missing_pid_is_32002() {
    assert_eq!(c.call("attach", json!({"pid": 999_999_999})).unwrap_err().0, -32002);
}
#[test] fn unknown_handle_is_32007() {
    assert_eq!(c.call("read", json!({"handle": 42, "address": "0x1000", "length": 1})).unwrap_err().0, -32007);
}
#[test] fn notifies_when_target_exits() {
    /* attach */ t.kill();
    let n = c.next_notification(Duration::from_secs(2)).expect("notification");
    assert_eq!(n["method"], "process_exited"); assert_eq!(n["params"]["handle"], h);
}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cd packages/starlightd && cargo test --test memory`
Expected: FAIL (methods return -32601).

- [ ] **Step 3: Implement**

`attach`:
1. `pidfd_open` (`libc::syscall(SYS_pidfd_open)`). `ESRCH` → `ProcessNotFound`.
2. Open `/proc/<pid>/mem` read-write. `EACCES`/`EPERM` → `PermissionDenied`.
3. Validate access with `process_vm_readv` of 1 byte from the first readable region. `EPERM` → `PermissionDenied`.
4. Start a watcher thread that `poll`s the pidfd. When the process exits, it sends `process_exited` once and removes the handle.

`write_bytes` uses `pwrite` on the mem file. Map write errors (`EIO`/`EFAULT`) to `WriteFailed`. When the connection closes, call `detach_all`.

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/starlightd && cargo test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd
git commit -m "feat(starlightd): attach, read/write, process-exit notification"
```

---

### Task 3: Modules: ELF and PE (Proton)

**Files:**
- Create: `packages/starlightd/src/modules.rs`, `tests/modules.rs`
- Modify: `packages/engine/test-target/target.c` (add `--map <file>`), `src/rpc.rs`

**Interfaces:**
- Consumes: `maps::read`, `mem::read_bytes`, `process::Handles`.
- Produces (Rust): `modules::Module { name: String, base: u64, size: u64, path: String, kind: Kind /* Elf | Pe */ }`; `modules::list(t: &Target) -> Result<Vec<Module>, RpcError>`; `modules::find(list: &[Module], name: &str) -> Option<&Module>` (ASCII case-insensitive on `name`); `modules::pe_size_of_image(header: &[u8]) -> Option<u64>`.
- Produces (protocol): `modules`.
- Produces (test target): `target --map <file>` mmaps the whole file `PROT_READ`, `MAP_PRIVATE`, and prints `addr mapped=0x…` alongside its other addresses.

- [ ] **Step 1: Write the failing tests**

Unit tests (`src/modules.rs`):
```rust
#[test] fn pe_size_of_image_from_minimal_header() {
    let h = minimal_pe(0x5000);              // test helper: "MZ", e_lfanew=0x40, "PE\0\0", COFF, PE32+ opt header with SizeOfImage
    assert_eq!(pe_size_of_image(&h), Some(0x5000));
}
#[test] fn non_pe_header_is_none() { assert_eq!(pe_size_of_image(b"\x7fELF...."), None); }
#[test] fn pe_module_lookup_is_case_insensitive() {
    let list = vec![Module { name: "GameAssembly.dll".into(), base: 0x1000, size: 0x3000, path: "/x/GameAssembly.dll".into(), kind: Kind::Pe }];
    assert!(find(&list, "gameassembly.dll").is_some()); assert!(find(&list, "other.dll").is_none());
}
```
Integration tests (`tests/modules.rs`):
```rust
#[test] fn lists_main_elf_module_named_target() {
    // modules contains name "target", kind "elf", and base <= addr(g_health) < base+size
}
#[test] fn lists_mapped_pe_file_as_pe_module() {
    // write minimal_pe(0x3000) padded to 0x3000 bytes to <tmp>/dir with space/GameAssembly.dll
    // Target::spawn(&["--map", path]) → modules has name "GameAssembly.dll", kind "pe", base == addr("mapped"), size == "0x3000"
}
```
(The end-to-end case-insensitive check through the protocol is in Task 6, `resolves a mapped PE module by case-insensitive name`.)
Put `minimal_pe` in `tests/common/mod.rs` and reuse it from the unit tests through a `#[cfg(test)]` copy, or export it from a `src/testutil.rs` behind `cfg(test)`.

- [ ] **Step 2: Run tests and see them fail**

Run: `make -C packages/engine/test-target && cd packages/starlightd && cargo test --test modules`
Expected: FAIL.

- [ ] **Step 3: Implement**

Group file-backed regions by path, in order:
- **PE:** if the path ends in `.dll`/`.exe` (case-insensitive), the module base is the start of the lowest region for that path with offset 0. Read 0x1000 bytes there. If `pe_size_of_image` parses, emit kind `Pe` with that size.
- **ELF:** otherwise emit kind `Elf` with base = lowest start and size = highest end − base.

`name` is the path's basename. Skip pseudo paths (`[heap]`, `[stack]`, `[vdso]`, …). PE parsing reads `e_lfanew` at 0x3c, checks `PE\0\0`, then takes `SizeOfImage` at optional-header offset 56 (PE32 and PE32+ both).

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/starlightd && cargo test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd packages/engine/test-target/target.c
git commit -m "feat(starlightd): ELF and PE module listing (Proton modules from Linux)"
```

---

### Task 4: AOB scan and pointer chains

**Files:**
- Create: `packages/starlightd/src/aob.rs`, `src/pointer.rs`, `tests/scan.rs`
- Modify: `src/rpc.rs`

**Interfaces:**
- Consumes: `modules::list/find`, `maps::read`, `mem::read_bytes`.
- Produces (Rust): `aob::Pattern::parse(s: &str) -> Result<Pattern, RpcError>` (space-separated tokens; a token is two hex digits, `?` or `??`; anything else → `InvalidPattern`); `aob::scan(t, range: (u64, u64), p: &Pattern, max: usize) -> Result<Vec<u64>, RpcError>`; `pointer::resolve(t, base: u64, offsets: &[u64]) -> Result<u64, RpcError>`.
- Produces (protocol): `aob_scan`, `resolve_pointer`.

- [ ] **Step 1: Write the failing tests**

Unit (`aob.rs`): `parse("DE AD ?? EF")` → 4 tokens with a wildcard at index 2; `parse("DE ZZ")` → `-32006`; scanning a buffer finds matches that straddle a chunk boundary (use a 2-chunk test with `CHUNK = 16` via a `#[cfg(test)]` constant).
Integration (`tests/scan.rs`, C target):
```rust
#[test] fn finds_marker_in_target_module() {
    // aob_scan {module:"target", pattern:"DE AD BE EF CA FE BA BE 12 34 56 78"} → matches[0] == addr("g_aob_marker")
}
#[test] fn wildcards_match() { /* "DE AD BE EF ?? ?? BA BE" → non-empty */ }
#[test] fn unknown_module_is_32005() { /* module:"nope.dll" → -32005 */ }
#[test] fn resolves_player_stats_hp_chain() {
    // resolve_pointer {base: addr("g_player_ptr"), offsets:["0x0","0x0"]} → read 4 bytes there == 250 ("fa000000")
}
#[test] fn module_relative_base_with_no_offsets_returns_base() {
    // resolve_pointer {module:"target", base:"0x10", offsets:[]} == module base + 0x10
}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/starlightd && cargo test --test scan`
Expected: FAIL.

- [ ] **Step 3: Implement**

`aob::scan` walks the readable regions that intersect the module range. It reads 1 MiB chunks that overlap by `pattern.len() - 1` so matches across chunk edges aren't lost, and it skips regions whose reads fail. `resolve_pointer` follows CE semantics: `addr = (module base or 0) + base`. With no offsets, return `addr`. Otherwise read a u64 at `addr`, dereference for every offset except the last, and add the last offset without dereferencing. A failed read returns `ReadFailed` with the step index in the message.

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/starlightd && cargo test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd
git commit -m "feat(starlightd): AOB scan and pointer chains"
```

---

### Task 5: Freeze

**Files:**
- Create: `packages/starlightd/src/freeze.rs`, `tests/freeze.rs`
- Modify: `src/rpc.rs`, `src/process.rs` (detach/exit cancel freezes)

**Interfaces:**
- Consumes: `mem::write_bytes`, `process::Handles`.
- Produces (protocol): `freeze`, which writes once synchronously (a failure returns `WriteFailed` and creates no freeze), then keeps writing every `interval_ms` (minimum 10) on its own thread; `unfreeze`. Write errors during the loop are ignored. Detach, connection close or process exit cancels every freeze on that handle.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn freeze_holds_value_against_external_write() {
    // freeze g_health "e7030000" @20ms; write "01000000" directly; sleep 100ms; read == "e7030000"
}
#[test] fn unfreeze_stops_writing() {
    // freeze; unfreeze; write "01000000"; sleep 100ms; read == "01000000"
}
#[test] fn freeze_stops_and_notifies_when_target_exits() {
    // freeze; t.kill(); next_notification == process_exited; then hello still answers
}
#[test] fn closing_connection_cancels_freezes() {
    // client A freezes; drop A; client B attaches, writes "01000000", sleeps 100ms, reads "01000000"
}
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/starlightd && cargo test --test freeze`
Expected: FAIL.

- [ ] **Step 3: Implement**

Each freeze is a thread holding an `Arc<AtomicBool>` stop flag plus an `Arc<Target>`. `Handles` tracks freeze ids per handle so detach can stop them.

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/starlightd && cargo test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/starlightd
git commit -m "feat(starlightd): freeze loops in the daemon"
```

---

### Task 6: `@starlight/engine` becomes a starlightd client (Frida removed)

**Files:**
- Create: `packages/engine/src/client.ts`, `src/modules.ts`, `test/helpers/daemon.ts`, `test/client.test.ts`
- Modify: `packages/engine/src/{session,memory,aob-scan,pointer-chain,freeze,index}.ts`, `package.json` (drop `frida`), `README.md`, `test/*.test.ts`, `test/helpers/spawn-target.ts`

**Interfaces:**
- Consumes: Protocol v1.
- Produces (TS):
  - `interface EngineClient { call<T>(method: string, params: object): Promise<T>; onNotification(cb: (method: string, params: any) => void): () => void; onClose(cb: () => void): void; close(): Promise<void>; readonly closed: boolean }`
  - `connectEngine(opts: { socketPath: string }): Promise<EngineClient>`. It sends `hello` and throws `EngineError('starlightd protocol N, expected 1')` on a mismatch.
  - `startEngine(opts: { binary: string; socketPath: string; readyTimeoutMs?: number /* default 5000 */ }): Promise<{ client: EngineClient; pid: number; stop(): Promise<void> }>`. It spawns with `stdio: ['pipe','pipe','inherit']` and waits for `READY 1`. `stop()` closes stdin.
  - `attach(client: EngineClient, pid: number): Promise<Session>` (**signature change**: it now takes the client)
  - `interface Session { readonly pid: number; readonly handle: number; readonly attached: boolean; readonly client: EngineClient; detach(): Promise<void>; onDetached(cb: (reason: 'process-exit' | 'manual') => void): void }`. The `fridaSession` field is removed.
  - `listModules(session): Promise<Array<{ name: string; base: string; size: string; path: string; kind: 'elf' | 'pe' }>>`
  - `read`, `write`, `aobScan`, `resolvePointerChain` and `freeze` keep their current signatures and semantics. `freeze` → daemon `freeze`, and `FreezeHandle.cancel` → `unfreeze`.
  - Error mapping: `-32001` → `PermissionError`, `-32002` → `AttachError`, `-32003` → `ReadError`, `-32004` → `WriteError`, `-32005`/`-32006` → `ScanError`; anything else → `EngineError`.
- Test helper: `startTestEngine(): Promise<{ client; stop }>` uses `packages/starlightd/target/debug/starlightd`, with a clear error if that's missing ("run `cargo build` in packages/starlightd").

- [ ] **Step 1: Write the failing tests**

`test/client.test.ts`:
```ts
it('rejects a daemon with the wrong protocol', ...)   // fake Unix-socket server answering hello {protocol: 2} → connectEngine rejects /protocol 2, expected 1/
it('maps -32001 to PermissionError', ...)              // fake server returns -32001 for attach → attach rejects instanceof PermissionError
it('fires onDetached("process-exit") on process_exited', ...) // real daemon + spawnTarget; kill target → callback with 'process-exit'
it('detach() fires onDetached("manual") once', ...)
```
Update the existing tests (`memory-read`, `memory-write`, `aob-scan`, `pointer-chain`, `freeze`, `session`) to call `attach(client, pid)` with the client from `startTestEngine()` in `beforeAll`. Their assertions stay the same. Add to `aob-scan.test.ts`:
```ts
it('resolves a mapped PE module by case-insensitive name', ...) // spawnTarget({ map: <tmp>/GameAssembly.dll }) → aobScan({module:'gameassembly.dll', pattern: <first 4 PE bytes "4D 5A 90 00">}) has a match
```
`spawnTarget` gains an optional `{ map?: string }` that passes `--map`. Drop the grandchild-shell workaround comment about Frida (keep the wrapper; it still works).

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/starlightd && cargo build && cd ../engine && pnpm build && pnpm test`
Expected: FAIL (`connectEngine` missing; old tests fail on the `attach` signature).

- [ ] **Step 3: Implement**

`client.ts` uses `node:net`, newline framing and an id→promise map. When the socket closes, it rejects every pending call with `EngineError('starlightd connection closed')` and fires `onClose`. When the client closes, the session fires `onDetached('process-exit')` and marks itself detached. Remove `frida` from `package.json` and update the README (ptrace section: the daemon needs `cap_sys_ptrace` or `ptrace_scope=0`).

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/engine && pnpm build && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine pnpm-lock.yaml
git commit -m "feat(engine): reimplement @starlight/engine on starlightd, drop Frida"
```

---

### Task 7: Desktop: install, start and supervise starlightd; switch engine-host

**Files:**
- Create: `apps/desktop/src/main/starlightd-host.ts`, `apps/desktop/test/main/starlightd-host.test.ts`
- Modify: `apps/desktop/src/main/engine-host.ts`, `src/main/ce-native.ts` (`grantPtraceCap`), `src/main/index.ts` (lines ~120–127 detach wiring, ~297–301 `allowMemoryAccess`, ~434 quit), `test/main/engine-host.inc-dec.test.ts`, `package.json` (remove `frida`), `electron.vite.config.ts` (remove frida external), `electron-builder.yml` (comment + `extraResources`)

**Interfaces:**
- Consumes: `startEngine`, `EngineClient`, `attach`, `Session.onDetached` (Task 6); `readPtraceScope`, `hasPtraceCap` (`ce-native.ts`).
- Produces (TS, `starlightd-host.ts`):
  - `bundledBinaryPath(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): string`. Packaged: `<resourcesPath>/starlightd`. Dev: `<appPath>/../../packages/starlightd/target/release/starlightd`.
  - `installDaemon(opts: { bundled: string; runtimeRoot: string }): Promise<{ path: string; changed: boolean }>`. Target is `<runtimeRoot>/starlightd/starlightd`. It copies only when the sha256 differs, via a temp file + `rename`, with `chmod 0o755`.
  - `socketPath(env = process.env, uid = process.getuid!()): string`. Uses `<XDG_RUNTIME_DIR>/starlight/starlightd.sock`, falling back to `<os.tmpdir()>/starlight-<uid>/starlightd.sock`. Creates the directory with mode 0700.
  - `getEngineClient(): Promise<EngineClient>`. Starts the daemon lazily, reuses a live client, and starts a fresh daemon if the previous one exited or its client closed.
  - `restartEngine(): Promise<void>` (after a ptrace grant, so the new capability takes effect).
  - `stopEngine(): Promise<void>`.
  - `installedDaemonPath(): Promise<string>` (runs `installDaemon` once per app run, memoized).
  - `configureStarlightdHost(opts: { runtimeRoot: string; isPackaged: boolean; resourcesPath: string; appPath: string; start?: typeof startEngine }): void`. Called once from `index.ts`; `start` is injectable for tests.
- Changes `grantPtraceCap(opts: { bins: string[]; … })`: one `pkexec setcap cap_sys_ptrace=ep <bin1> cap_sys_ptrace=ep <bin2> …` call (setcap accepts file/caps pairs). The manual fallback message lists every binary.
- `engine-host.attach(pid)` uses `attach(await getEngineClient(), pid)` and `session.onDetached(...)` in place of `fridaSession.detached.connect`.

- [ ] **Step 1: Write the failing tests**

`starlightd-host.test.ts`:
```ts
it('installDaemon copies when missing and reports changed', ...)        // tmp dirs; changed === true; file mode & 0o777 === 0o755
it('installDaemon skips copy when sha256 matches', ...)                  // second call → changed === false, mtime unchanged
it('installDaemon replaces a different binary', ...)                     // write other bytes to target → changed === true, contents == bundled
it('socketPath prefers XDG_RUNTIME_DIR', ...)                            // {XDG_RUNTIME_DIR:'/run/user/1000'} → '/run/user/1000/starlight/starlightd.sock'
it('bundledBinaryPath dev vs packaged', ...)
it('respawns daemon after it dies', ...)                                 // inject fake start(); first client fires onClose → next getEngineClient() calls start() again
```
`engine-host.inc-dec.test.ts`: change the `attachMock` session to `{ pid: 123, handle: 1, attached: true, onDetached: vi.fn(), detach: vi.fn() }`, mock `../../src/main/starlightd-host.js` → `getEngineClient: async () => ({})`, and keep the existing assertions. Add:
```ts
it('notifies detached listener with process-exit when session reports it', ...) // capture onDetached cb, invoke('process-exit') → onDetached listener got 'process-exit'
```
`ce-native` grant test (existing file `test/main/ce-native*.test.ts` if present, else new `test/main/grant-ptrace.test.ts`):
```ts
it('grants several binaries in one pkexec call', ...) // run mock receives ['/usr/sbin/setcap','cap_sys_ptrace=ep','/a','cap_sys_ptrace=ep','/b']
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd apps/desktop && pnpm test`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

- In `index.ts`: call `configureStarlightdHost({ runtimeRoot: CE_RUNTIME_ROOT, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })`.
- The `allowMemoryAccess` handler becomes: if `await readPtraceScope() === 0`, return `{ ok: true }` without prompting. Otherwise collect `[await installedDaemonPath()]`, plus the ceserver path if `runtimeManager.ensure()` succeeds (a CE download failure no longer blocks granting starlightd). Call `grantPtraceCap({ bins })`, and on success call `restartEngine()`.
- On `before-quit`, call `stopEngine()` after `engineHost.detach()`.
- `electron-builder.yml`: add `extraResources: [{ from: '../../packages/starlightd/target/release/starlightd', to: 'starlightd' }]` and update the npmRebuild comment (drop frida).
- Remove `frida` from `package.json` dependencies and from the `electron.vite.config.ts` externals.

- [ ] **Step 4: Run tests, lint, and a dev smoke check**

Run: `cd apps/desktop && pnpm lint && pnpm test`
Expected: all pass.
Run: `cd packages/starlightd && cargo build --release && cd ../.. && pnpm dev`. Then open a hand-written catalog trainer with `packages/engine/test-target/build/target` running and toggle a cheat.
Expected: the cheat toggles; `ps` shows `starlightd` running from `~/.config/Starlight/runtime/starlightd/`; quitting Starlight leaves no `starlightd` process.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat(desktop): run trainers on starlightd; one ptrace grant for both engines"
```

---

### Task 8: Anti-cheat refusal on both engines

**Files:**
- Create: `apps/desktop/src/main/anti-cheat.ts`, `src/main/anti-cheat-signatures.json`, `test/main/anti-cheat.test.ts`
- Modify: `src/main/engine-host.ts` (`attach`), `src/main/ce-session.ts` (right after `effectivePid` is final, before any CE/ceserver launch, ~line 328), `src/main/index.ts` (session-start error → reason), `src/shared/ipc.ts`

**Interfaces:**
- Produces:
  - `interface AntiCheatSignature { name: string; patterns: string[] /* regex sources, matched case-insensitively against the mapped file's basename */ }`
  - `findAntiCheat(mapsText: string, sigs?: AntiCheatSignature[]): { name: string; module: string } | null`
  - `detectAntiCheat(pid: number, readMaps?: (pid: number) => Promise<string>): Promise<{ name: string; module: string } | null>`. An unreadable maps file → `null` (attach then fails on its own with a proper error).
  - `antiCheatMessage(hit): string` = `` `${hit.name} is running in this game, so Starlight won't attach. Starlight only works with single-player games that don't have anti-cheat running.` ``
  - `ipc.ts`: `AttachResult` code union adds `'anti-cheat'`; the CE session start `reason` union adds `'anti-cheat'`.
  - `StartSessionOpts.detectAntiCheatFn?: typeof detectAntiCheat` (injectable for the existing ce-session tests). On a hit, `startSession` throws `new Error(antiCheatMessage(hit))`, and `index.ts` maps `/anti-cheat|won't attach/i` → reason `'anti-cheat'`.
- Initial `anti-cheat-signatures.json`:
```json
[
  { "name": "Easy Anti-Cheat", "patterns": ["^easyanticheat.*\\.(dll|so)$"] },
  { "name": "BattlEye", "patterns": ["^beclient.*\\.(dll|so)$"] }
]
```
Don't add `EOSSDK-*`. Many games without anti-cheat load the Epic Online Services SDK, so it would cause false refusals.

- [ ] **Step 1: Write the failing tests**

```ts
it('detects EAC loaded via a Proton path with spaces', ...)
  // maps line ".../steamapps/common/Some Game/EasyAntiCheat/EasyAntiCheat_EOS_x64.dll" → { name: 'Easy Anti-Cheat', module: 'EasyAntiCheat_EOS_x64.dll' }
it('detects the Proton BattlEye runtime .so', ...)          // ".../Proton BattlEye Runtime/v1/beclient_x64.so" → BattlEye
it('ignores anti-cheat files that are not mapped', ...)     // maps without them → null
it('ignores EOSSDK', ...)                                   // "EOSSDK-Win64-Shipping.dll" → null
it('engine-host.attach refuses with code anti-cheat and never calls the engine', ...)
it('ce startSession throws the anti-cheat message before launching CE', ...) // detectAntiCheatFn returns a hit → rejects /won't attach/, spawn/launch mocks not called
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd apps/desktop && pnpm test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Parse the maps lines with the same rule as the Rust parser: the path is everything after the fifth field, minus ` (deleted)`. Match each pattern against the path's basename. In `engine-host.attach`, return `{ ok: false, code: 'anti-cheat', message: antiCheatMessage(hit) }`. In the renderer, the existing error text paths show `message`/`error` already. Check that the CE session start screen shows the error text for an unknown reason (it does for `ceStartError`), and add `'anti-cheat'` to any exhaustive switch the lint flags.

- [ ] **Step 4: Run tests and see them pass**

Run: `cd apps/desktop && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): refuse to attach when anti-cheat is loaded (both engines)"
```

---

### Task 9: CI and release build starlightd

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/RELEASING.md`

**Interfaces:**
- Consumes: the crate (Tasks 1–5) and `extraResources` (Task 7).

- [ ] **Step 1: Edit `ci.yml`**

After "Build C test target", add `cargo test --manifest-path packages/starlightd/Cargo.toml` and `cargo build --manifest-path packages/starlightd/Cargo.toml` (the debug build is used by the engine tests). Use `Swatinem/rust-cache@v2` for caching. ubuntu-latest already has rustup/stable.

- [ ] **Step 2: Edit `release.yml`**

Do the same in the `test` job. In `build-linux`, before the dist step, run `cargo build --release --manifest-path packages/starlightd/Cargo.toml` and then `test -x packages/starlightd/target/release/starlightd`. After dist, assert that the AppImage contains the binary: `./dist/Starlight-*.AppImage --appimage-extract resources/starlightd >/dev/null && test -x squashfs-root/resources/starlightd`.

- [ ] **Step 3: Update `docs/RELEASING.md`**

Explain that starlightd is built and bundled automatically, and that changing it re-prompts users for ptrace permission once (only when ptrace_scope > 0).

- [ ] **Step 4: Verify on a branch push**

Run: `git push -u origin <branch>` and watch CI.
Expected: the CI workflow is green, including cargo tests and the engine tests against the daemon.

- [ ] **Step 5: Commit**

```bash
git add .github docs/RELEASING.md
git commit -m "ci: build, test and bundle starlightd"
```

---

### Task 10: Live verification against native and Proton games

No new code is expected. Any bug found here goes back to the owning task, with a test.

- [ ] **Step 1: Native, ptrace restricted**

On a machine with `ptrace_scope=1`: start the packaged AppImage (`pnpm dist`) and run the test target.
Expected: attaching shows the permission error. "Allow" shows **one** password prompt (covering starlightd + ceserver). After that, attach works and a freeze holds. Restarting Starlight doesn't prompt again.

- [ ] **Step 2: Proton module resolution**

Run 9 Kings under Proton (see memory `starlight-live-testing`). Run a throwaway Node script against the dev daemon: `attach` → `listModules` → find `GameAssembly.dll`.
Expected: kind `pe`, with a nonzero size equal to the PE `SizeOfImage`. `aobScan` for the first 2 bytes `4D 5A` at the module returns the module base. If GameAssembly.dll's regions turn out to be anonymous (not file-backed) in this Proton version, record it in the plan's follow-ups and in memory. Milestone 2 then adds header-scan detection.

- [ ] **Step 3: Anti-cheat**

Launch any installed EAC/BattlEye title with its anti-cheat active, then try to attach from both a trainer and a CE table.
Expected: both refuse with the anti-cheat message. If no such title is installed, run the unit tests and note it in the PR.

- [ ] **Step 4: No leftovers**

Freeze a value, then quit Starlight.
Expected: no `starlightd` process remains and the value is no longer frozen.

- [ ] **Step 5: Record results**

Write the outcomes in the PR description and update the memory file `starlight-native-engine-plan.md` with what was verified.

---

## Follow-ups (later milestone plans)

- **Milestone 2** (separate plan): value/pointer scans, watchpoints, disassembly, signature builder, remote alloc + assembler, game speed, `ScannerPanel` on starlightd.
- **Milestone 3** (separate plan): MCP server, attach approval, `ask_player`, activity panel, schema v2.
- **Milestone 4** (separate plan): AA-subset compiler, engine-agnostic session, `ct-runner`, coverage script.
- **Game identity** (Steam app id + build id from `appmanifest_<appid>.acf`, spec §6.1) isn't needed until cheat provenance in milestone 3; it's built there.
- **Deviation from spec §5, "Distribution":** starlightd ships **bundled in the AppImage and copied** into the runtime dir, instead of being downloaded through the starlight-runtimes manifest. The source lives in this repo, so bundling avoids a manual manifest update on every release, and the spec's real constraint (not run from squashfs, re-prompt only when the bytes change) still holds.
