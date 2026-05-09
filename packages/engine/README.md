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
