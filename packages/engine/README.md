# @starlight/engine

Cross-platform memory engine for Starlight. Wraps frida-node with a typed API
for attach/detach, read/write, pointer chains, AOB scans, and freeze loops.

## Requirements

- Node 20+
- Linux: `kernel.yama.ptrace_scope` ≤ 1 (test mode child-process attach works at default value 1)
- Windows: usually unprivileged for non-DRM games; admin for some
- macOS: not yet validated (deferred to later phase)

## Test target

The C test target in `test-target/` provides a deterministic process for
integration tests. Build it before running tests:

```bash
make -C test-target
pnpm test
```

## Linux: ptrace troubleshooting

If `attach()` throws `PermissionError`, your kernel is restricting ptrace.
Tests work at the default `kernel.yama.ptrace_scope=1` because they spawn
the target as a child process. To attach to arbitrary running processes
(real games), lower the scope:

```bash
sudo sysctl kernel.yama.ptrace_scope=0
```

Or grant cap_sys_ptrace to the Node binary (more targeted, more setup).
