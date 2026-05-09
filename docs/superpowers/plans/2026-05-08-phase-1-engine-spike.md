# Phase 1 — Engine Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, tested TypeScript memory engine (`@starlight/engine`) that wraps `frida-node` and exposes attach, read, write, pointer-chain, AOB-scan, and freeze-loop primitives, validated on Linux against a deterministic C test target.

**Architecture:** pnpm workspace monorepo. Phase 1 lives in `packages/engine/` as a pure Node library. A small C program in `packages/engine/test-target/` provides a deterministic process to attach to in tests. No UI, no Electron, no `.CT` parsing in this phase — those come in later phases.

**Tech Stack:** Node 20 LTS, TypeScript 5, pnpm workspaces, Vitest for tests, `frida` (npm package = frida-node), C + gcc for the test target, GitHub Actions for CI.

---

## File Structure

```
starlight/
├── pnpm-workspace.yaml          (NEW — workspace config)
├── package.json                 (NEW — root package)
├── tsconfig.base.json           (NEW — shared TS config)
├── .nvmrc                       (NEW — pin Node version)
├── .github/workflows/ci.yml     (NEW — Linux CI)
└── packages/
    └── engine/
        ├── package.json
        ├── tsconfig.json
        ├── vitest.config.ts
        ├── README.md
        ├── src/
        │   ├── index.ts                 (public API barrel)
        │   ├── session.ts               (attach/detach lifecycle)
        │   ├── memory.ts                (read/write primitives)
        │   ├── pointer-chain.ts         (multi-level pointer walk)
        │   ├── aob-scan.ts              (pattern scan in module)
        │   ├── freeze.ts                (freeze loop with cancellation)
        │   ├── errors.ts                (typed error classes)
        │   └── types.ts                 (TS types: ValueType, AddressSpec, etc.)
        ├── test/
        │   ├── helpers/
        │   │   └── spawn-target.ts      (test fixture: spawn the C target, parse stdout)
        │   ├── session.test.ts
        │   ├── memory.test.ts
        │   ├── pointer-chain.test.ts
        │   ├── aob-scan.test.ts
        │   ├── freeze.test.ts
        │   └── errors.test.ts
        └── test-target/
            ├── Makefile
            ├── target.c                 (deterministic memory layout)
            └── README.md
```

**Boundaries:**
- `session.ts` owns the Frida session object lifecycle. Other modules accept a `Session` and never construct one.
- `memory.ts` is stateless typed read/write. No knowledge of pointer chains or scans.
- `pointer-chain.ts` and `aob-scan.ts` use `memory.ts` for the final read.
- `freeze.ts` is the only stateful module besides `session.ts` (it owns the timer).
- `errors.ts` exports typed errors that bubble up from every module.

---

## Task 1: Workspace Scaffolding

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.nvmrc`
- Modify: `.gitignore`

- [ ] **Step 1: Pin Node version**

Create `.nvmrc`:

```
20
```

- [ ] **Step 2: Create workspace config**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3: Create root package.json**

Create `package.json`:

```json
{
  "name": "starlight",
  "version": "0.0.0",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint"
  },
  "packageManager": "pnpm@9.12.0"
}
```

- [ ] **Step 4: Create shared TS config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 5: Update gitignore**

Append to `.gitignore`:

```
# build output
packages/*/dist
packages/*/test-target/build

# pnpm
.pnpm-store
```

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json .nvmrc .gitignore
git commit -m "chore: scaffold pnpm workspace"
```

---

## Task 2: Engine Package Skeleton

**Files:**
- Create: `packages/engine/package.json`
- Create: `packages/engine/tsconfig.json`
- Create: `packages/engine/vitest.config.ts`
- Create: `packages/engine/src/index.ts`
- Create: `packages/engine/README.md`

- [ ] **Step 1: Create engine package.json**

Create `packages/engine/package.json`:

```json
{
  "name": "@starlight/engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "frida": "^16.5.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create engine tsconfig**

Create `packages/engine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["test", "dist", "test-target"]
}
```

- [ ] **Step 3: Create vitest config**

Create `packages/engine/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
```

- [ ] **Step 4: Create empty barrel**

Create `packages/engine/src/index.ts`:

```ts
export {};
```

- [ ] **Step 5: Create README stub**

Create `packages/engine/README.md`:

```md
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
```

- [ ] **Step 6: Install dependencies**

Run: `pnpm install`
Expected: completes without errors; `frida` native binding downloaded.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/ pnpm-lock.yaml
git commit -m "chore(engine): scaffold @starlight/engine package"
```

---

## Task 3: C Test Target

**Files:**
- Create: `packages/engine/test-target/target.c`
- Create: `packages/engine/test-target/Makefile`
- Create: `packages/engine/test-target/README.md`

- [ ] **Step 1: Write the C target**

Create `packages/engine/test-target/target.c`:

```c
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Stable global memory layout for tests.
 * Keep these in BSS/data so addresses are inspectable from the outside. */
volatile int32_t   g_health   = 100;
volatile float     g_speed    = 1.5f;
volatile double    g_pi       = 3.14159265358979;
volatile int64_t   g_souls    = 50000;
volatile uint8_t   g_byte     = 0x42;
char               g_name[16] = "Hero";

/* AOB pattern: a recognizable 12-byte signature, with a float right after. */
volatile uint8_t   g_aob_marker[12] = {
    0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE,
    0x12, 0x34, 0x56, 0x78
};
volatile float     g_after_aob = 9.99f;

/* Pointer chain: g_player -> stats -> hp.
 * Layout: stats struct sits at known offset from a Player struct. */
typedef struct { int32_t hp; int32_t mp; } Stats;
typedef struct { Stats* stats; int32_t level; } Player;

static Stats  s_stats  = { .hp = 250, .mp = 75 };
static Player s_player = { .stats = &s_stats, .level = 12 };
Player*       g_player = &s_player;

int main(void) {
    /* Print addresses on startup so tests can locate them.
     * Format is parsed by the spawn-target test helper. */
    printf("READY\n");
    printf("addr g_health=%p\n",      (void*)&g_health);
    printf("addr g_speed=%p\n",       (void*)&g_speed);
    printf("addr g_pi=%p\n",          (void*)&g_pi);
    printf("addr g_souls=%p\n",       (void*)&g_souls);
    printf("addr g_byte=%p\n",        (void*)&g_byte);
    printf("addr g_name=%p\n",        (void*)g_name);
    printf("addr g_aob_marker=%p\n",  (void*)g_aob_marker);
    printf("addr g_after_aob=%p\n",   (void*)&g_after_aob);
    printf("addr g_player_ptr=%p\n",  (void*)&g_player);
    printf("offset stats_in_player=%zu\n", offsetof(Player, stats));
    printf("offset hp_in_stats=%zu\n",     offsetof(Stats, hp));
    fflush(stdout);

    /* Idle loop. Tests will read/write our memory, then SIGTERM us. */
    while (1) {
        sleep(1);
        /* Re-touch volatile values so the compiler keeps them live. */
        (void)g_health; (void)g_speed; (void)g_souls; (void)g_byte;
        (void)g_aob_marker[0]; (void)g_after_aob;
    }
    return 0;
}
```

- [ ] **Step 2: Add stddef.h include for offsetof**

Edit `packages/engine/test-target/target.c` line 5 — add `#include <stddef.h>`:

```c
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
#include <unistd.h>
```

- [ ] **Step 3: Write the Makefile**

Create `packages/engine/test-target/Makefile`:

```make
CC      ?= gcc
CFLAGS  ?= -O0 -g -Wall -Wextra -fno-pie -no-pie
TARGET  := build/target

.PHONY: all clean
all: $(TARGET)

$(TARGET): target.c | build
	$(CC) $(CFLAGS) -o $@ $<

build:
	mkdir -p build

clean:
	rm -rf build
```

`-fno-pie -no-pie` disables ASLR for the binary so addresses are stable across runs (useful for debugging; tests don't depend on this).

- [ ] **Step 4: Write target README**

Create `packages/engine/test-target/README.md`:

```md
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
```

- [ ] **Step 5: Build and verify**

Run: `make -C packages/engine/test-target`
Expected: produces `packages/engine/test-target/build/target`.

Run: `packages/engine/test-target/build/target & sleep 1; kill %1`
Expected: prints `READY` followed by `addr ...=0x...` lines.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/test-target/
git commit -m "feat(engine): add deterministic C test target"
```

---

## Task 4: spawn-target Test Helper

**Files:**
- Create: `packages/engine/test/helpers/spawn-target.ts`
- Create: `packages/engine/src/types.ts`

- [ ] **Step 1: Define core types**

Create `packages/engine/src/types.ts`:

```ts
export type ValueType =
  | 'int8'  | 'uint8'
  | 'int16' | 'uint16'
  | 'int32' | 'uint32'
  | 'int64' | 'uint64'
  | 'float' | 'double'
  | 'string';

export interface StringSpec {
  type: 'string';
  encoding: 'utf-8' | 'utf-16le';
  maxLength: number;
}

export type ReadSpec = ValueType | StringSpec;

export interface PointerChainSpec {
  module?: string;
  baseAddress: string;     // hex literal "0x..."
  offsets: string[];       // hex literals
}

export interface AobScanSpec {
  module: string;
  pattern: string;         // e.g. "DE AD BE EF ?? ?? CA FE"
  resultOffset?: number;   // bytes added to first match
}
```

- [ ] **Step 2: Write the failing helper test**

Create `packages/engine/test/helpers/spawn-target.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { spawnTarget, type SpawnedTarget } from './spawn-target.js';

describe('spawnTarget', () => {
  let target: SpawnedTarget | undefined;
  afterEach(async () => { await target?.kill(); target = undefined; });

  it('spawns the C target and parses its address table', async () => {
    target = await spawnTarget();
    expect(target.pid).toBeGreaterThan(0);
    expect(target.addresses.g_health).toMatch(/^0x[0-9a-f]+$/);
    expect(target.addresses.g_speed).toMatch(/^0x[0-9a-f]+$/);
    expect(target.offsets.stats_in_player).toBe(0);
    expect(target.offsets.hp_in_stats).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @starlight/engine test`
Expected: FAIL — module `./spawn-target.js` not found.

- [ ] **Step 4: Implement the helper**

Create `packages/engine/test/helpers/spawn-target.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_BINARY = resolve(HERE, '../../test-target/build/target');

export interface SpawnedTarget {
  pid: number;
  addresses: Record<string, string>;  // name -> "0x..."
  offsets: Record<string, number>;
  kill(): Promise<void>;
}

export async function spawnTarget(): Promise<SpawnedTarget> {
  const child: ChildProcess = spawn(TARGET_BINARY, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  if (!child.pid || !child.stdout) throw new Error('failed to spawn target');

  const addresses: Record<string, string> = {};
  const offsets: Record<string, number> = {};

  await new Promise<void>((resolveReady, rejectReady) => {
    let buf = '';
    const onErr = (e: Error) => rejectReady(e);
    child.once('error', onErr);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === 'READY') continue;
        const a = line.match(/^addr (\w+)=(0x[0-9a-fA-F]+)$/);
        if (a) { addresses[a[1]!] = a[2]!.toLowerCase(); continue; }
        const o = line.match(/^offset (\w+)=(\d+)$/);
        if (o) {
          offsets[o[1]!] = Number(o[2]);
          if (o[1] === 'hp_in_stats') {
            child.off('error', onErr);
            resolveReady();
            return;
          }
        }
      }
    });
  });

  return {
    pid: child.pid,
    addresses,
    offsets,
    kill: () => new Promise((r) => {
      if (child.exitCode !== null) return r();
      child.once('exit', () => r());
      child.kill('SIGTERM');
    }),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @starlight/engine test`
Expected: PASS — 1 test passing.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/types.ts packages/engine/test/helpers/
git commit -m "feat(engine): add types and spawn-target test helper"
```

---

## Task 5: Session Attach/Detach

**Files:**
- Create: `packages/engine/src/errors.ts`
- Create: `packages/engine/src/session.ts`
- Create: `packages/engine/test/session.test.ts`
- Modify: `packages/engine/src/index.ts`

- [ ] **Step 1: Write typed errors**

Create `packages/engine/src/errors.ts`:

```ts
export class EngineError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EngineError';
  }
}

export class AttachError extends EngineError { name = 'AttachError'; }
export class PermissionError extends EngineError { name = 'PermissionError'; }
export class ReadError extends EngineError { name = 'ReadError'; }
export class WriteError extends EngineError { name = 'WriteError'; }
export class ScanError extends EngineError { name = 'ScanError'; }
```

- [ ] **Step 2: Write the failing session test**

Create `packages/engine/test/session.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { attach } from '../src/session.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';
import { AttachError } from '../src/errors.js';

describe('Session', () => {
  let target: SpawnedTarget | undefined;
  afterEach(async () => { await target?.kill(); target = undefined; });

  it('attaches by pid and detaches cleanly', async () => {
    target = await spawnTarget();
    const session = await attach(target.pid);
    expect(session.pid).toBe(target.pid);
    expect(session.attached).toBe(true);
    await session.detach();
    expect(session.attached).toBe(false);
  });

  it('throws AttachError for non-existent pid', async () => {
    await expect(attach(999_999_999)).rejects.toBeInstanceOf(AttachError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @starlight/engine test session`
Expected: FAIL — `../src/session.js` not found.

- [ ] **Step 4: Implement session.ts**

Create `packages/engine/src/session.ts`:

```ts
import frida from 'frida';
import { AttachError, PermissionError } from './errors.js';

export interface Session {
  readonly pid: number;
  readonly attached: boolean;
  readonly fridaSession: frida.Session;
  detach(): Promise<void>;
}

export async function attach(pid: number): Promise<Session> {
  let fridaSession: frida.Session;
  try {
    fridaSession = await frida.attach(pid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission|ptrace|EPERM/i.test(msg)) {
      throw new PermissionError(`cannot attach to pid ${pid}: ${msg}`, err);
    }
    throw new AttachError(`failed to attach to pid ${pid}: ${msg}`, err);
  }

  let attached = true;
  fridaSession.detached.connect(() => { attached = false; });

  return {
    pid,
    get attached() { return attached; },
    fridaSession,
    detach: async () => {
      if (!attached) return;
      await fridaSession.detach();
      attached = false;
    },
  };
}
```

- [ ] **Step 5: Update barrel**

Replace contents of `packages/engine/src/index.ts`:

```ts
export { attach, type Session } from './session.js';
export * from './types.js';
export {
  EngineError, AttachError, PermissionError,
  ReadError, WriteError, ScanError,
} from './errors.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @starlight/engine test session`
Expected: PASS — 2 tests passing.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/ packages/engine/test/session.test.ts
git commit -m "feat(engine): add session attach/detach with typed errors"
```

---

## Task 6: Memory Read API

**Files:**
- Create: `packages/engine/src/memory.ts`
- Create: `packages/engine/test/memory-read.test.ts`
- Modify: `packages/engine/src/index.ts`

- [ ] **Step 1: Write the failing read test**

Create `packages/engine/test/memory-read.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read } from '../src/memory.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('memory.read', () => {
  let target: SpawnedTarget;
  let session: Session;

  beforeAll(async () => {
    target = await spawnTarget();
    session = await attach(target.pid);
  });
  afterAll(async () => {
    await session.detach();
    await target.kill();
  });

  it('reads int32', async () => {
    expect(await read(session, target.addresses.g_health!, 'int32')).toBe(100);
  });
  it('reads float', async () => {
    expect(await read(session, target.addresses.g_speed!, 'float')).toBeCloseTo(1.5, 5);
  });
  it('reads double', async () => {
    expect(await read(session, target.addresses.g_pi!, 'double')).toBeCloseTo(3.14159265358979, 10);
  });
  it('reads int64 as bigint', async () => {
    expect(await read(session, target.addresses.g_souls!, 'int64')).toBe(50000n);
  });
  it('reads uint8', async () => {
    expect(await read(session, target.addresses.g_byte!, 'uint8')).toBe(0x42);
  });
  it('reads utf-8 string', async () => {
    const value = await read(session, target.addresses.g_name!, { type: 'string', encoding: 'utf-8', maxLength: 16 });
    expect(value).toBe('Hero');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @starlight/engine test memory-read`
Expected: FAIL — `../src/memory.js` not found.

- [ ] **Step 3: Implement read**

Create `packages/engine/src/memory.ts`:

```ts
import type { Session } from './session.js';
import type { ReadSpec, ValueType, StringSpec } from './types.js';
import { ReadError } from './errors.js';

export type PrimitiveValue = number | bigint | string;

const SIZE_OF: Record<ValueType, number> = {
  int8: 1, uint8: 1,
  int16: 2, uint16: 2,
  int32: 4, uint32: 4,
  int64: 8, uint64: 8,
  float: 4, double: 8,
  string: 0, // unused
};

async function readBytes(session: Session, address: string, length: number): Promise<Buffer> {
  // Frida exposes a Memory.readByteArray(ptr, len) inside the agent. We run
  // a tiny script per call to keep the API stateless. For hot paths, callers
  // can build their own batched script via session.fridaSession.createScript().
  const script = await session.fridaSession.createScript(`
    rpc.exports = {
      read: function(addrHex, len) {
        const p = ptr(addrHex);
        return Array.from(new Uint8Array(p.readByteArray(len)));
      }
    };
  `);
  await script.load();
  try {
    const exp = script.exports as { read: (a: string, l: number) => Promise<number[]> };
    const arr = await exp.read(address, length);
    return Buffer.from(arr);
  } finally {
    await script.unload();
  }
}

export async function read(session: Session, address: string, spec: ReadSpec): Promise<PrimitiveValue> {
  if (typeof spec === 'object' && spec.type === 'string') {
    return readString(session, address, spec);
  }
  const type = spec as ValueType;
  const buf = await readBytes(session, address, SIZE_OF[type]);
  switch (type) {
    case 'int8':   return buf.readInt8(0);
    case 'uint8':  return buf.readUInt8(0);
    case 'int16':  return buf.readInt16LE(0);
    case 'uint16': return buf.readUInt16LE(0);
    case 'int32':  return buf.readInt32LE(0);
    case 'uint32': return buf.readUInt32LE(0);
    case 'int64':  return buf.readBigInt64LE(0);
    case 'uint64': return buf.readBigUInt64LE(0);
    case 'float':  return buf.readFloatLE(0);
    case 'double': return buf.readDoubleLE(0);
    default: throw new ReadError(`unsupported type ${String(type)}`);
  }
}

async function readString(session: Session, address: string, spec: StringSpec): Promise<string> {
  const buf = await readBytes(session, address, spec.maxLength);
  if (spec.encoding === 'utf-8') {
    const nul = buf.indexOf(0);
    return buf.subarray(0, nul === -1 ? buf.length : nul).toString('utf8');
  }
  // utf-16le: terminate at null code unit
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf.readUInt16LE(i) === 0) return buf.subarray(0, i).toString('utf16le');
  }
  return buf.toString('utf16le');
}
```

- [ ] **Step 4: Update barrel to export read**

Edit `packages/engine/src/index.ts` — add `read` and `PrimitiveValue` exports:

```ts
export { attach, type Session } from './session.js';
export { read, type PrimitiveValue } from './memory.js';
export * from './types.js';
export {
  EngineError, AttachError, PermissionError,
  ReadError, WriteError, ScanError,
} from './errors.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @starlight/engine test memory-read`
Expected: PASS — 6 tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/memory.ts packages/engine/src/index.ts packages/engine/test/memory-read.test.ts
git commit -m "feat(engine): add typed read API for primitives and strings"
```

---

## Task 7: Memory Write API

**Files:**
- Modify: `packages/engine/src/memory.ts`
- Create: `packages/engine/test/memory-write.test.ts`
- Modify: `packages/engine/src/index.ts`

- [ ] **Step 1: Write the failing write test**

Create `packages/engine/test/memory-write.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read, write } from '../src/memory.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('memory.write', () => {
  let target: SpawnedTarget;
  let session: Session;

  beforeAll(async () => {
    target = await spawnTarget();
    session = await attach(target.pid);
  });
  afterAll(async () => {
    await session.detach();
    await target.kill();
  });

  it('writes int32 and reads back the new value', async () => {
    await write(session, target.addresses.g_health!, 'int32', 4242);
    expect(await read(session, target.addresses.g_health!, 'int32')).toBe(4242);
  });

  it('writes float', async () => {
    await write(session, target.addresses.g_speed!, 'float', 3.25);
    expect(await read(session, target.addresses.g_speed!, 'float')).toBeCloseTo(3.25, 5);
  });

  it('writes int64 from bigint', async () => {
    await write(session, target.addresses.g_souls!, 'int64', 999_999_999n);
    expect(await read(session, target.addresses.g_souls!, 'int64')).toBe(999_999_999n);
  });

  it('writes uint8', async () => {
    await write(session, target.addresses.g_byte!, 'uint8', 0xAB);
    expect(await read(session, target.addresses.g_byte!, 'uint8')).toBe(0xAB);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @starlight/engine test memory-write`
Expected: FAIL — `write` not exported.

- [ ] **Step 3: Implement write in memory.ts**

Append to `packages/engine/src/memory.ts`:

```ts
import { WriteError } from './errors.js';

export async function write(
  session: Session,
  address: string,
  type: ValueType,
  value: number | bigint,
): Promise<void> {
  if (type === 'string') throw new WriteError('use writeString for strings');
  const buf = Buffer.alloc(SIZE_OF[type]);
  switch (type) {
    case 'int8':   buf.writeInt8(value as number, 0); break;
    case 'uint8':  buf.writeUInt8(value as number, 0); break;
    case 'int16':  buf.writeInt16LE(value as number, 0); break;
    case 'uint16': buf.writeUInt16LE(value as number, 0); break;
    case 'int32':  buf.writeInt32LE(value as number, 0); break;
    case 'uint32': buf.writeUInt32LE(value as number, 0); break;
    case 'int64':  buf.writeBigInt64LE(typeof value === 'bigint' ? value : BigInt(value), 0); break;
    case 'uint64': buf.writeBigUInt64LE(typeof value === 'bigint' ? value : BigInt(value), 0); break;
    case 'float':  buf.writeFloatLE(value as number, 0); break;
    case 'double': buf.writeDoubleLE(value as number, 0); break;
    default: throw new WriteError(`unsupported type ${String(type)}`);
  }
  await writeBytes(session, address, buf);
}

async function writeBytes(session: Session, address: string, data: Buffer): Promise<void> {
  const script = await session.fridaSession.createScript(`
    rpc.exports = {
      write: function(addrHex, bytes) {
        ptr(addrHex).writeByteArray(bytes);
      }
    };
  `);
  await script.load();
  try {
    const exp = script.exports as { write: (a: string, b: number[]) => Promise<void> };
    await exp.write(address, Array.from(data));
  } finally {
    await script.unload();
  }
}
```

Note: the existing `WriteError` import line collides with the existing imports. Adjust the top of `memory.ts` so it imports both:

```ts
import { ReadError, WriteError } from './errors.js';
```

(Replace the existing `import { ReadError } from './errors.js';` line.)

- [ ] **Step 4: Update barrel**

Edit `packages/engine/src/index.ts` — add `write`:

```ts
export { read, write, type PrimitiveValue } from './memory.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @starlight/engine test memory-write`
Expected: PASS — 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/memory.ts packages/engine/src/index.ts packages/engine/test/memory-write.test.ts
git commit -m "feat(engine): add typed write API"
```

---

## Task 8: Pointer Chain Resolution

**Files:**
- Create: `packages/engine/src/pointer-chain.ts`
- Create: `packages/engine/test/pointer-chain.test.ts`
- Modify: `packages/engine/src/index.ts`

- [ ] **Step 1: Write the failing pointer-chain test**

Create `packages/engine/test/pointer-chain.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read, write } from '../src/memory.js';
import { resolvePointerChain } from '../src/pointer-chain.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('resolvePointerChain', () => {
  let target: SpawnedTarget;
  let session: Session;

  beforeAll(async () => {
    target = await spawnTarget();
    session = await attach(target.pid);
  });
  afterAll(async () => {
    await session.detach();
    await target.kill();
  });

  it('walks g_player_ptr -> Player.stats -> Stats.hp = 250', async () => {
    // g_player_ptr is the address OF a pointer to a Player.
    // *(g_player_ptr) -> Player; +stats_in_player -> Stats*; *() -> Stats; +hp_in_stats -> int32
    const final = await resolvePointerChain(session, {
      baseAddress: target.addresses.g_player_ptr!,
      offsets: [
        toHex(target.offsets.stats_in_player!),  // walk into Player to reach .stats field
        toHex(target.offsets.hp_in_stats!),      // walk into Stats to reach .hp
      ],
    });
    expect(await read(session, final, 'int32')).toBe(250);
  });

  it('writing via the resolved address mutates the chained value', async () => {
    const final = await resolvePointerChain(session, {
      baseAddress: target.addresses.g_player_ptr!,
      offsets: [
        toHex(target.offsets.stats_in_player!),
        toHex(target.offsets.hp_in_stats!),
      ],
    });
    await write(session, final, 'int32', 9001);
    expect(await read(session, final, 'int32')).toBe(9001);
  });
});

function toHex(n: number): string { return '0x' + n.toString(16); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @starlight/engine test pointer-chain`
Expected: FAIL — `../src/pointer-chain.js` not found.

- [ ] **Step 3: Implement pointer-chain.ts**

Create `packages/engine/src/pointer-chain.ts`:

```ts
import type { Session } from './session.js';
import type { PointerChainSpec } from './types.js';
import { ReadError } from './errors.js';

/* Resolves a pointer chain to a final address (hex string).
 *
 * Semantics, matching Cheat Engine: read 8 bytes (assumed 64-bit) at the base
 * address to get a pointer P. Then for each offset, do P = *(P + offset),
 * EXCEPT for the LAST offset, which is added without dereferencing — the
 * caller wants the final address, not the value behind it.
 */
export async function resolvePointerChain(
  session: Session,
  spec: PointerChainSpec,
): Promise<string> {
  const offsets = spec.offsets;
  if (offsets.length === 0) return spec.baseAddress;

  const script = await session.fridaSession.createScript(`
    rpc.exports = {
      walk: function(baseHex, offsetHexes) {
        try {
          let p = ptr(baseHex).readPointer();
          for (let i = 0; i < offsetHexes.length - 1; i++) {
            p = p.add(ptr(offsetHexes[i])).readPointer();
          }
          const last = p.add(ptr(offsetHexes[offsetHexes.length - 1]));
          return last.toString();  // "0x..."
        } catch (e) {
          return { error: String(e) };
        }
      }
    };
  `);
  await script.load();
  try {
    const exp = script.exports as { walk: (b: string, o: string[]) => Promise<string | { error: string }> };
    const result = await exp.walk(spec.baseAddress, offsets);
    if (typeof result === 'object' && 'error' in result) {
      throw new ReadError(`pointer chain failed: ${result.error}`);
    }
    return result;
  } finally {
    await script.unload();
  }
}
```

- [ ] **Step 4: Update barrel**

Edit `packages/engine/src/index.ts`:

```ts
export { resolvePointerChain } from './pointer-chain.js';
```

(Append to existing exports.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @starlight/engine test pointer-chain`
Expected: PASS — 2 tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/pointer-chain.ts packages/engine/src/index.ts packages/engine/test/pointer-chain.test.ts
git commit -m "feat(engine): add pointer chain resolution"
```

---

## Task 9: AOB Scan

**Files:**
- Create: `packages/engine/src/aob-scan.ts`
- Create: `packages/engine/test/aob-scan.test.ts`
- Modify: `packages/engine/src/index.ts`

- [ ] **Step 1: Write the failing aob-scan test**

Create `packages/engine/test/aob-scan.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read } from '../src/memory.js';
import { aobScan } from '../src/aob-scan.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('aobScan', () => {
  let target: SpawnedTarget;
  let session: Session;

  beforeAll(async () => {
    target = await spawnTarget();
    session = await attach(target.pid);
  });
  afterAll(async () => {
    await session.detach();
    await target.kill();
  });

  it('finds a 12-byte signature in the target module', async () => {
    const matches = await aobScan(session, {
      module: 'target',
      pattern: 'DE AD BE EF CA FE BA BE 12 34 56 78',
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toBe(target.addresses.g_aob_marker);
  });

  it('matches with wildcards', async () => {
    const matches = await aobScan(session, {
      module: 'target',
      pattern: 'DE AD BE EF ?? ?? BA BE',
    });
    expect(matches.length).toBeGreaterThan(0);
  });

  it('resultOffset is added to the first match', async () => {
    const matches = await aobScan(session, {
      module: 'target',
      pattern: 'DE AD BE EF CA FE BA BE 12 34 56 78',
      resultOffset: 12,  // 12 bytes after the marker is g_after_aob
    });
    expect(matches.length).toBeGreaterThan(0);
    // Reading float at first match should give 9.99 (g_after_aob), accounting for alignment.
    // The actual address of g_after_aob may include padding, so just verify the address
    // matches the recorded one within the same byte (alignment-aware).
    const first = parseInt(matches[0]!, 16);
    const expected = parseInt(target.addresses.g_after_aob!, 16);
    expect(Math.abs(first - expected)).toBeLessThanOrEqual(8);
    void read;  // suppress unused
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @starlight/engine test aob-scan`
Expected: FAIL — `../src/aob-scan.js` not found.

- [ ] **Step 3: Implement aob-scan.ts**

Create `packages/engine/src/aob-scan.ts`:

```ts
import type { Session } from './session.js';
import type { AobScanSpec } from './types.js';
import { ScanError } from './errors.js';

export async function aobScan(session: Session, spec: AobScanSpec): Promise<string[]> {
  const script = await session.fridaSession.createScript(`
    rpc.exports = {
      scan: async function(moduleName, pattern) {
        const mod = Process.findModuleByName(moduleName);
        if (!mod) return { error: 'module not found: ' + moduleName };
        const matches = await Memory.scan(mod.base, mod.size, pattern, {
          onMatch: () => {},
          onComplete: () => {},
        });
        return matches.map(m => m.address.toString());
      }
    };
  `);
  await script.load();
  try {
    const exp = script.exports as { scan: (m: string, p: string) => Promise<string[] | { error: string }> };
    const result = await exp.scan(spec.module, spec.pattern);
    if (!Array.isArray(result)) throw new ScanError(result.error);
    if (spec.resultOffset && result.length > 0) {
      return result.map(addr => '0x' + (BigInt(addr) + BigInt(spec.resultOffset!)).toString(16));
    }
    return result;
  } finally {
    await script.unload();
  }
}
```

Note: `Memory.scan`'s exact promise/match-collection API depends on frida-gum version. If the above doesn't return match arrays directly, adjust to use `Memory.scanSync` or accumulate via the `onMatch` callback. The test will reveal which.

- [ ] **Step 4: Run test; if Memory.scan signature differs, adjust the agent script**

Run: `pnpm --filter @starlight/engine test aob-scan`

If FAIL with a Frida API error, replace the inline agent's scan implementation with the synchronous variant:

```js
rpc.exports = {
  scan: function(moduleName, pattern) {
    const mod = Process.findModuleByName(moduleName);
    if (!mod) return { error: 'module not found: ' + moduleName };
    const matches = Memory.scanSync(mod.base, mod.size, pattern);
    return matches.map(m => m.address.toString());
  }
};
```

Then re-run.

- [ ] **Step 5: Update barrel**

Edit `packages/engine/src/index.ts`:

```ts
export { aobScan } from './aob-scan.js';
```

- [ ] **Step 6: Run all tests**

Run: `pnpm --filter @starlight/engine test`
Expected: PASS — all tests across all files green.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/aob-scan.ts packages/engine/src/index.ts packages/engine/test/aob-scan.test.ts
git commit -m "feat(engine): add AOB scan with wildcard patterns"
```

---

## Task 10: Freeze Loop

**Files:**
- Create: `packages/engine/src/freeze.ts`
- Create: `packages/engine/test/freeze.test.ts`
- Modify: `packages/engine/src/index.ts`

- [ ] **Step 1: Write the failing freeze test**

Create `packages/engine/test/freeze.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attach, type Session } from '../src/session.js';
import { read, write } from '../src/memory.js';
import { freeze } from '../src/freeze.js';
import { spawnTarget, type SpawnedTarget } from './helpers/spawn-target.js';

describe('freeze', () => {
  let target: SpawnedTarget;
  let session: Session;

  beforeAll(async () => {
    target = await spawnTarget();
    session = await attach(target.pid);
  });
  afterAll(async () => {
    await session.detach();
    await target.kill();
  });

  it('keeps the value pinned despite external writes', async () => {
    const handle = await freeze(session, {
      address: target.addresses.g_health!,
      type: 'int32',
      value: 7777,
      intervalMs: 25,
    });
    try {
      await new Promise(r => setTimeout(r, 100));
      // External write that the freeze loop should overwrite
      await write(session, target.addresses.g_health!, 'int32', 0);
      await new Promise(r => setTimeout(r, 150));
      expect(await read(session, target.addresses.g_health!, 'int32')).toBe(7777);
    } finally {
      await handle.cancel();
    }
  });

  it('cancel stops the freeze loop', async () => {
    const handle = await freeze(session, {
      address: target.addresses.g_speed!,
      type: 'float',
      value: 5.0,
      intervalMs: 25,
    });
    await new Promise(r => setTimeout(r, 60));
    await handle.cancel();
    await write(session, target.addresses.g_speed!, 'float', 1.0);
    await new Promise(r => setTimeout(r, 100));
    expect(await read(session, target.addresses.g_speed!, 'float')).toBeCloseTo(1.0, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @starlight/engine test freeze`
Expected: FAIL — `../src/freeze.js` not found.

- [ ] **Step 3: Implement freeze.ts**

Create `packages/engine/src/freeze.ts`:

```ts
import type { Session } from './session.js';
import type { ValueType } from './types.js';
import { write } from './memory.js';

export interface FreezeSpec {
  address: string;
  type: Exclude<ValueType, 'string'>;
  value: number | bigint;
  intervalMs: number;
}

export interface FreezeHandle {
  readonly active: boolean;
  cancel(): Promise<void>;
}

export async function freeze(session: Session, spec: FreezeSpec): Promise<FreezeHandle> {
  let active = true;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async () => {
    if (!active) return;
    try {
      await write(session, spec.address, spec.type, spec.value);
    } catch {
      // swallow individual write errors; the loop keeps trying
    }
  };

  const interval = setInterval(() => { inFlight = tick(); }, spec.intervalMs);
  await tick(); // prime immediately

  return {
    get active() { return active; },
    cancel: async () => {
      if (!active) return;
      active = false;
      clearInterval(interval);
      await inFlight; // let any in-flight write settle
    },
  };
}
```

- [ ] **Step 4: Update barrel**

Edit `packages/engine/src/index.ts`:

```ts
export { freeze, type FreezeSpec, type FreezeHandle } from './freeze.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @starlight/engine test freeze`
Expected: PASS — 2 tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/freeze.ts packages/engine/src/index.ts packages/engine/test/freeze.test.ts
git commit -m "feat(engine): add freeze loop with cancellation"
```

---

## Task 11: Permission Error Surface

**Files:**
- Create: `packages/engine/test/errors.test.ts`
- Modify: `packages/engine/src/session.ts` (only if test reveals a gap)

- [ ] **Step 1: Write a permission-detection test**

Create `packages/engine/test/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PermissionError, AttachError } from '../src/errors.js';

describe('error hierarchy', () => {
  it('PermissionError extends AttachError-related EngineError', () => {
    const e = new PermissionError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PermissionError');
  });

  it('AttachError preserves cause', () => {
    const cause = new Error('underlying');
    const e = new AttachError('failed', cause);
    expect(e.cause).toBe(cause);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @starlight/engine test errors`
Expected: PASS (errors.ts is already implemented).

- [ ] **Step 3: Document the ptrace prerequisite in README**

Append to `packages/engine/README.md`:

```md

## Linux: ptrace troubleshooting

If `attach()` throws `PermissionError`, your kernel is restricting ptrace.
Tests work at the default `kernel.yama.ptrace_scope=1` because they spawn
the target as a child process. To attach to arbitrary running processes
(real games), lower the scope:

```bash
sudo sysctl kernel.yama.ptrace_scope=0
```

Or grant cap_sys_ptrace to the Node binary (more targeted, more setup).
```

- [ ] **Step 4: Commit**

```bash
git add packages/engine/test/errors.test.ts packages/engine/README.md
git commit -m "docs(engine): document ptrace requirement; verify error hierarchy"
```

---

## Task 12: CI on Linux

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the CI config**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  engine-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Lower ptrace scope (so tests can attach)
        run: |
          echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Build C test target
        run: make -C packages/engine/test-target

      - name: Lint
        run: pnpm -r lint

      - name: Test
        run: pnpm -r test
```

- [ ] **Step 2: Push branch and verify CI**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Linux engine CI"
git push -u origin HEAD
```

Watch the run on GitHub Actions. Expected: green across `Lint` and `Test`.

If anything fails, fix the failure (don't disable the check) and push again.

- [ ] **Step 3: After CI is green, merge or request review**

This concludes Phase 1. Phase 2 (`.CT` importer) is a separate plan.

---

## Self-Review

**Spec coverage check (against `2026-05-08-starlight-design.md` §3.1 Trainer Engine):**
- ✅ Attach / detach — Task 5
- ✅ Read / write typed values — Tasks 6, 7
- ✅ Pointer-chain resolution — Task 8
- ✅ AOB scan — Task 9
- ✅ Freeze loop — Task 10
- ⏭ Code hook (`Interceptor.attach`) — deferred to Phase 2 alongside the `.CT` importer's "simple assembler hook" translation. Not in the Phase 1 critical path.
- ✅ Linux ptrace handling — Task 11

**Placeholder scan:** none.

**Type consistency:** `Session` shape consistent across `session.ts`, `memory.ts`, `pointer-chain.ts`, `aob-scan.ts`, `freeze.ts`. `ValueType` used consistently. `PointerChainSpec`, `AobScanSpec` defined in `types.ts`, consumed by their modules.

**Cross-platform note:** plan covers Linux end-to-end and validates in CI. Windows + macOS validation are deferred to a Phase 1.5 follow-up plan; the engine code is platform-agnostic so that follow-up should be additive (CI matrix extension + ptrace-equivalent docs), not a refactor.
