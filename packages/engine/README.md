# @starlight/engine

Memory engine for Starlight. A typed client for `starlightd` (packages/starlightd),
the native daemon that does the memory work over JSON-RPC on a Unix socket.
Attach/detach, read/write, modules, pointer chains, AOB scans and freeze loops.
Nothing is injected into the game.

## Requirements

- Node 20+
- Linux x86-64
- A built `starlightd` (`cargo build` in packages/starlightd for tests)

## Test target

The C test target in `test-target/` provides a deterministic process for
integration tests. Build it before running tests:

```bash
cargo build --manifest-path ../starlightd/Cargo.toml
make -C test-target
pnpm test
```

## Linux: ptrace

The daemon (not Node) attaches to the game, so it is the daemon binary that
needs permission. If `attach()` throws `PermissionError`, either:

- set `kernel.yama.ptrace_scope=0` (`sudo sysctl kernel.yama.ptrace_scope=0`), or
- grant the daemon `cap_sys_ptrace` (`sudo setcap cap_sys_ptrace+ep /path/to/starlightd`).

At `ptrace_scope=0` no grant is needed. Tests spawn the target themselves.
