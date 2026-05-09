# Engine test target

Deterministic C process for integration-testing the memory engine.

## Build

```bash
make
```

Produces `build/target`.

## Run

```bash
./build/target
```

Prints addresses of all instrumented globals on startup, then idles.
Tests parse this output to learn addresses, attach via Frida, and
exercise read/write/scan/freeze.
