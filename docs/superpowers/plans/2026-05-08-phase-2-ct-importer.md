# Phase 2 — `.CT` Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, tested TypeScript package (`@starlight/ct-importer`) that parses Cheat Engine `.CT` XML files and converts them into Starlight Trainer JSON, preserving categories and hotkeys, recognising the convertible subset of cheat entries, and gracefully flagging Lua scripts and complex assembler hooks as unsupported.

**Architecture:** New workspace package `packages/ct-importer/`, depends on `@starlight/engine` only for shared types (`ValueType`, `PointerChainSpec`, `AobScanSpec`). Pure data transformation — no Frida, no IPC, no UI. Exposes a programmatic API (`importCt(xmlString): ImportResult`) and a thin CLI (`pnpm import <file.ct> [-o out.json]`) for ad-hoc conversion.

**Tech Stack:** TypeScript 5, Vitest, `fast-xml-parser` for `.CT` XML, `zod` for runtime schema validation of the output, `commander` for the CLI.

---

## File Structure

```
packages/ct-importer/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts                 (public API barrel)
│   ├── starlight-format.ts      (Starlight Trainer JSON schema + types + zod)
│   ├── xml-parser.ts            (thin wrapper over fast-xml-parser configured for .CT)
│   ├── type-mapper.ts           (CT VariableType strings → engine ValueType)
│   ├── address-parser.ts        (parses CT `<Address>` and `<Offsets>` elements)
│   ├── hotkey-parser.ts         (parses CT `<Hotkeys>` into Starlight hotkey strings)
│   ├── entry-converter.ts       (converts a single CT <CheatEntry> to a Starlight cheat or unsupported placeholder)
│   ├── script-classifier.ts     (decides whether a CT assembler/lua script is convertible, partially convertible, or unsupported)
│   ├── ct-importer.ts           (top-level: parse XML → walk entries → emit Starlight document with stats)
│   ├── stats.ts                 (ImportStats type + reporting helpers)
│   └── cli.ts                   (commander-based CLI entrypoint; wired in package.json `bin`)
├── test/
│   ├── fixtures/
│   │   ├── synthetic/           (hand-authored .CT files exercising each conversion path)
│   │   │   ├── basic-static.ct
│   │   │   ├── pointer-chain.ct
│   │   │   ├── aob-scan.ct
│   │   │   ├── grouped.ct
│   │   │   ├── hotkeys.ct
│   │   │   ├── lua-script.ct
│   │   │   └── mixed-real-shape.ct
│   │   └── README.md            (where to drop real .CT files for ad-hoc testing; gitignored)
│   ├── xml-parser.test.ts
│   ├── type-mapper.test.ts
│   ├── address-parser.test.ts
│   ├── hotkey-parser.test.ts
│   ├── entry-converter.test.ts
│   ├── script-classifier.test.ts
│   ├── ct-importer.test.ts
│   └── cli.test.ts
```

**Boundaries:**
- `xml-parser.ts` is the only module that knows about XML → object shape. Everything else takes parsed objects.
- `address-parser.ts`, `hotkey-parser.ts`, `type-mapper.ts`, `script-classifier.ts` are pure functions over already-parsed structures.
- `entry-converter.ts` orchestrates the small parsers to convert one CheatEntry.
- `ct-importer.ts` is the top of the pipeline: XML in, `ImportResult` out.
- `starlight-format.ts` is the canonical Starlight schema. Both this importer and downstream consumers (the future desktop app, the catalog indexer) use it.
- `cli.ts` is a thin shell over `ct-importer.ts` for command-line use.

---

## Background: The `.CT` XML Shape

Real Cheat Engine table files look like (simplified):

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>0</ID>
      <Description>"Player"</Description>
      <Options moHideChildren="1"/>
      <GroupHeader>1</GroupHeader>
      <CheatEntries>
        <CheatEntry>
          <ID>1</ID>
          <Description>"Health"</Description>
          <VariableType>4 Bytes</VariableType>
          <Address>"game.exe"+1A2B3C</Address>
          <Offsets>
            <Offset>10</Offset>
            <Offset>20</Offset>
          </Offsets>
          <Hotkeys>
            <Hotkey>
              <Action>Toggle Activation</Action>
              <Keys><Key>112</Key></Keys>
              <ID>0</ID>
            </Hotkey>
          </Hotkeys>
        </CheatEntry>
        <CheatEntry>
          <ID>2</ID>
          <Description>"Auto-Block"</Description>
          <LastState Activated="0" RealAddress="0"/>
          <AssemblerScript>{ Lua-driven AOB+inject script ... }</AssemblerScript>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
  </CheatEntries>
  <UserdefinedSymbols/>
</CheatTable>
```

Notes that drive the implementation:

- Descriptions are wrapped in extra double quotes — strip them.
- `<GroupHeader>1</GroupHeader>` marks an entry as a folder/category (it has no own value; its children are the real cheats).
- `<Address>` may be an absolute hex (`0x4A2B3C`), a module-relative literal (`"game.exe"+1A2B3C`), or a Lua-evaluated expression. We recognise the first two and flag the third.
- `<Offsets>` lists offsets *outermost-first* in some CE versions and *innermost-first* in others. We default to the CE 7+ convention (outermost-first) and document it.
- `<VariableType>` is one of: `Byte`, `2 Bytes`, `4 Bytes`, `8 Bytes`, `Float`, `Double`, `String`, `Array of byte`, etc.
- `<Hotkey>` keys are Windows virtual-key codes (numbers). We map common ones (F1=112, etc.) to the strings our engine accepts.
- `<AssemblerScript>` and `<LuaScript>` indicate code injection; `script-classifier.ts` decides which (if any) we can translate.

---

## Task 1: Package Scaffold

**Files:**
- Create: `packages/ct-importer/package.json`
- Create: `packages/ct-importer/tsconfig.json`
- Create: `packages/ct-importer/vitest.config.ts`
- Create: `packages/ct-importer/src/index.ts`
- Create: `packages/ct-importer/README.md`
- Create: `packages/ct-importer/test/fixtures/README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Create package.json**

Create `packages/ct-importer/package.json`:

```json
{
  "name": "@starlight/ct-importer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "bin": { "starlight-import-ct": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@starlight/engine": "workspace:*",
    "commander": "^12.1.0",
    "fast-xml-parser": "^4.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig**

Create `packages/ct-importer/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["test", "dist"]
}
```

- [ ] **Step 3: Create vitest config**

Create `packages/ct-importer/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 5000,
  },
});
```

- [ ] **Step 4: Create empty barrel and README**

Create `packages/ct-importer/src/index.ts`:

```ts
export {};
```

Create `packages/ct-importer/README.md`:

```md
# @starlight/ct-importer

Parses Cheat Engine `.CT` files and emits Starlight Trainer JSON.

## Programmatic use

\`\`\`ts
import { importCt } from '@starlight/ct-importer';
import { readFileSync } from 'node:fs';

const xml = readFileSync('Elden Ring.CT', 'utf8');
const result = importCt(xml);
console.log(result.stats);          // { total: 32, supported: 28, unsupported: 4 }
console.log(result.trainer);        // Starlight Trainer JSON
\`\`\`

## CLI

\`\`\`bash
pnpm --filter @starlight/ct-importer build
node packages/ct-importer/dist/cli.js path/to/file.CT -o out.json
\`\`\`

## Conversion coverage

| .CT construct | Status |
|---|---|
| Static / module-relative address | Supported |
| Pointer chains | Supported |
| AOB scans | Supported |
| Hotkeys (toggle / inc / dec) | Supported |
| Group/category nesting | Supported |
| Simple assembler patterns | Supported (recognised whitelist) |
| Complex assembler with `aobscanmodule` + alloc + label | Flagged unsupported |
| Lua scripts (`{$lua}`) | Flagged unsupported |

Unsupported entries are preserved in the output with the original source so the user can open the original `.CT` in Cheat Engine.
```

Create `packages/ct-importer/test/fixtures/README.md`:

```md
# Test fixtures

`synthetic/` contains hand-authored `.CT` files exercising every conversion path. These are committed and used by integration tests.

To test against real community tables, drop them in `real/` (gitignored). Run:

\`\`\`bash
pnpm --filter @starlight/ct-importer build
for f in test/fixtures/real/*.CT; do
  node dist/cli.js "$f" -o "/tmp/$(basename "$f" .CT).json"
done
\`\`\`

We do not commit real .CT files because:
- Licensing is unclear for community-uploaded tables.
- Parsing must work on arbitrary input we have not seen.
```

- [ ] **Step 5: Update root .gitignore**

Append to root `.gitignore`:

```
# ct-importer real-table fixtures (uncommitted, ad-hoc only)
packages/ct-importer/test/fixtures/real/
```

- [ ] **Step 6: Install + smoke**

Run: `pnpm install`
Expected: dependencies resolve, no errors. `fast-xml-parser`, `zod`, `commander` downloaded.

Run smoke check: `node -e "import('fast-xml-parser').then(m => console.log(typeof m.XMLParser))"`
Expected: `function`.

- [ ] **Step 7: Commit**

```bash
git add packages/ct-importer/ .gitignore pnpm-lock.yaml
git commit -m "chore(ct-importer): scaffold @starlight/ct-importer package"
```

---

## Task 2: Starlight Trainer Format Schema

**Files:**
- Create: `packages/ct-importer/src/starlight-format.ts`
- Create: `packages/ct-importer/test/starlight-format.test.ts`
- Modify: `packages/ct-importer/src/index.ts`

This task locks down the canonical Starlight Trainer JSON schema using zod, derived from §4 of the design spec. Other modules will produce values that conform to this schema; the validator is exposed for downstream consumers (catalog indexer, desktop app loader).

- [ ] **Step 1: Write the failing schema test**

Create `packages/ct-importer/test/starlight-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StarlightTrainerSchema, type StarlightTrainer } from '../src/starlight-format.js';

describe('StarlightTrainerSchema', () => {
  it('accepts a minimal valid trainer', () => {
    const t: StarlightTrainer = {
      schemaVersion: 1,
      id: 'starlight-elden-ring-frx-1',
      game: {
        name: 'Elden Ring',
        steamAppId: 1245620,
        processName: ['eldenring.exe'],
        platform: ['windows'],
      },
      metadata: { author: 'FLiNG', source: { convertedFrom: '.CT' } },
      categories: [
        {
          name: 'Player',
          cheats: [
            {
              id: 'infinite-hp',
              name: 'Infinite HP',
              type: 'freeze',
              valueType: 'int32',
              value: 999999,
              address: { kind: 'absolute', address: '0x12345678' },
            },
          ],
        },
      ],
    };
    expect(StarlightTrainerSchema.parse(t)).toEqual(t);
  });

  it('rejects unknown valueType', () => {
    const t = {
      schemaVersion: 1, id: 'x',
      game: { name: 'X', processName: ['x.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' } },
      categories: [{ name: 'C', cheats: [{
        id: 'c', name: 'c', type: 'freeze',
        valueType: 'banana', value: 0,
        address: { kind: 'absolute', address: '0x0' },
      }] }],
    };
    expect(() => StarlightTrainerSchema.parse(t)).toThrow();
  });

  it('accepts an unsupported entry without address', () => {
    const t = {
      schemaVersion: 1, id: 'x',
      game: { name: 'X', processName: ['x.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' } },
      categories: [{ name: 'C', cheats: [{
        id: 'lua-cheat',
        name: 'Lua Cheat',
        unsupported: true,
        unsupportedReason: 'Uses Cheat Engine Lua API.',
        originalSource: '<lua>...</lua>',
      }] }],
    };
    expect(() => StarlightTrainerSchema.parse(t)).not.toThrow();
  });

  it('accepts a value cheat with stepper config', () => {
    const t = {
      schemaVersion: 1, id: 'x',
      game: { name: 'X', processName: ['x.exe'], platform: ['windows'] },
      metadata: { source: { convertedFrom: '.CT' } },
      categories: [{ name: 'C', cheats: [{
        id: 'speed',
        name: 'Speed',
        type: 'set',
        valueType: 'float',
        default: 1.0,
        step: 0.1,
        min: 0.1,
        max: 10.0,
        address: { kind: 'absolute', address: '0x0' },
        hotkeys: { toggle: 'F4', inc: 'F4+Up', dec: 'F4+Down' },
      }] }],
    };
    expect(() => StarlightTrainerSchema.parse(t)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test (will fail — module does not exist)**

Run: `pnpm --filter @starlight/ct-importer test starlight-format`
Expected: FAIL with "Failed to load url ../src/starlight-format.js".

- [ ] **Step 3: Implement the schema**

Create `packages/ct-importer/src/starlight-format.ts`:

```ts
import { z } from 'zod';

const ValueType = z.enum([
  'int8','uint8','int16','uint16','int32','uint32','int64','uint64','float','double','string',
]);

const PointerAddress = z.object({
  kind: z.literal('pointer'),
  module: z.string().optional(),
  baseOffset: z.string(),         // hex literal "0x..."
  offsets: z.array(z.string()),   // hex literals
});

const AbsoluteAddress = z.object({
  kind: z.literal('absolute'),
  address: z.string(),            // hex literal "0x..."
});

const ModuleRelativeAddress = z.object({
  kind: z.literal('module'),
  module: z.string(),
  offset: z.string(),             // hex literal "0x..."
});

const AobAddress = z.object({
  kind: z.literal('aob'),
  module: z.string(),
  pattern: z.string(),
  offset: z.string().optional(),  // hex; bytes added to first match
});

const Address = z.discriminatedUnion('kind', [
  AbsoluteAddress, ModuleRelativeAddress, PointerAddress, AobAddress,
]);

const Hotkeys = z.object({
  toggle: z.string().optional(),
  inc: z.string().optional(),
  dec: z.string().optional(),
}).optional();

const SupportedCheat = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(['freeze', 'set', 'toggle']),
  valueType: ValueType,
  /* type === 'freeze': value is the frozen value */
  value: z.union([z.number(), z.string()]).optional(),
  /* type === 'set': default/step/min/max wired into the stepper UI */
  default: z.number().optional(),
  step: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  address: Address,
  hotkeys: Hotkeys,
  unsupported: z.literal(false).optional(),
});

const UnsupportedCheat = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  unsupported: z.literal(true),
  unsupportedReason: z.string(),
  originalSource: z.string().optional(),
});

const Cheat = z.union([SupportedCheat, UnsupportedCheat]);

const Category = z.object({
  name: z.string(),
  cheats: z.array(Cheat),
});

export const StarlightTrainerSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  game: z.object({
    name: z.string(),
    steamAppId: z.number().int().optional(),
    processName: z.array(z.string()).min(1),
    version: z.string().optional(),
    platform: z.array(z.enum(['windows', 'linux', 'linux-proton', 'macos'])).min(1),
  }),
  metadata: z.object({
    author: z.string().optional(),
    source: z.object({
      url: z.string().url().optional(),
      convertedFrom: z.literal('.CT'),
    }),
    convertedAt: z.string().datetime().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  categories: z.array(Category),
});

export type StarlightTrainer = z.infer<typeof StarlightTrainerSchema>;
export type StarlightCheat = z.infer<typeof Cheat>;
export type StarlightSupportedCheat = z.infer<typeof SupportedCheat>;
export type StarlightUnsupportedCheat = z.infer<typeof UnsupportedCheat>;
export type StarlightCategory = z.infer<typeof Category>;
export type StarlightAddress = z.infer<typeof Address>;
export type StarlightValueType = z.infer<typeof ValueType>;
```

- [ ] **Step 4: Update barrel**

Replace `packages/ct-importer/src/index.ts`:

```ts
export {
  StarlightTrainerSchema,
  type StarlightTrainer,
  type StarlightCheat,
  type StarlightSupportedCheat,
  type StarlightUnsupportedCheat,
  type StarlightCategory,
  type StarlightAddress,
  type StarlightValueType,
} from './starlight-format.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @starlight/ct-importer test starlight-format`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/ct-importer/src/index.ts packages/ct-importer/src/starlight-format.ts packages/ct-importer/test/starlight-format.test.ts
git commit -m "feat(ct-importer): add Starlight Trainer JSON schema with zod validation"
```

---

## Task 3: Synthetic Test Fixtures

**Files:**
- Create: `packages/ct-importer/test/fixtures/synthetic/basic-static.ct`
- Create: `packages/ct-importer/test/fixtures/synthetic/pointer-chain.ct`
- Create: `packages/ct-importer/test/fixtures/synthetic/aob-scan.ct`
- Create: `packages/ct-importer/test/fixtures/synthetic/grouped.ct`
- Create: `packages/ct-importer/test/fixtures/synthetic/hotkeys.ct`
- Create: `packages/ct-importer/test/fixtures/synthetic/lua-script.ct`
- Create: `packages/ct-importer/test/fixtures/synthetic/mixed-real-shape.ct`

These are hand-authored `.CT` XML files that each exercise one conversion path. They follow the real `.CT` schema closely but stay minimal.

- [ ] **Step 1: Write `basic-static.ct`**

Create `packages/ct-importer/test/fixtures/synthetic/basic-static.ct`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"Health"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"target"+0040303C</Address>
    </CheatEntry>
    <CheatEntry>
      <ID>2</ID>
      <Description>"Speed"</Description>
      <VariableType>Float</VariableType>
      <Address>"target"+00403040</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
```

- [ ] **Step 2: Write `pointer-chain.ct`**

Create `packages/ct-importer/test/fixtures/synthetic/pointer-chain.ct`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"Player HP"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"target"+00403090</Address>
      <Offsets>
        <Offset>0</Offset>
        <Offset>0</Offset>
      </Offsets>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
```

- [ ] **Step 3: Write `aob-scan.ct`**

Create `packages/ct-importer/test/fixtures/synthetic/aob-scan.ct`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"After AOB Marker"</Description>
      <VariableType>Float</VariableType>
      <Address>aobscanmodule(SIG, target, DE AD BE EF CA FE BA BE 12 34 56 78)+0C</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
```

- [ ] **Step 4: Write `grouped.ct`**

Create `packages/ct-importer/test/fixtures/synthetic/grouped.ct`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>10</ID>
      <Description>"Player"</Description>
      <Options moHideChildren="1"/>
      <GroupHeader>1</GroupHeader>
      <CheatEntries>
        <CheatEntry>
          <ID>11</ID>
          <Description>"Health"</Description>
          <VariableType>4 Bytes</VariableType>
          <Address>"target"+0040303C</Address>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
    <CheatEntry>
      <ID>20</ID>
      <Description>"Stats"</Description>
      <Options moHideChildren="1"/>
      <GroupHeader>1</GroupHeader>
      <CheatEntries>
        <CheatEntry>
          <ID>21</ID>
          <Description>"Souls"</Description>
          <VariableType>8 Bytes</VariableType>
          <Address>"target"+00403048</Address>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
```

- [ ] **Step 5: Write `hotkeys.ct`**

Create `packages/ct-importer/test/fixtures/synthetic/hotkeys.ct`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"Infinite HP"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"target"+0040303C</Address>
      <Hotkeys>
        <Hotkey>
          <Action>Toggle Activation</Action>
          <Keys><Key>112</Key></Keys>
          <ID>0</ID>
        </Hotkey>
      </Hotkeys>
    </CheatEntry>
    <CheatEntry>
      <ID>2</ID>
      <Description>"Speed Multiplier"</Description>
      <VariableType>Float</VariableType>
      <Address>"target"+00403040</Address>
      <Hotkeys>
        <Hotkey>
          <Action>Toggle Activation</Action>
          <Keys><Key>115</Key></Keys>
          <ID>0</ID>
        </Hotkey>
        <Hotkey>
          <Action>Increase Value</Action>
          <Keys><Key>33</Key></Keys>
          <Value>0.1</Value>
          <ID>1</ID>
        </Hotkey>
        <Hotkey>
          <Action>Decrease Value</Action>
          <Keys><Key>34</Key></Keys>
          <Value>0.1</Value>
          <ID>2</ID>
        </Hotkey>
      </Hotkeys>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
```

VK 112 = F1, 115 = F4, 33 = PageUp, 34 = PageDown.

- [ ] **Step 6: Write `lua-script.ct`**

Create `packages/ct-importer/test/fixtures/synthetic/lua-script.ct`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"Auto-Block (Lua)"</Description>
      <LastState Activated="0" RealAddress="0"/>
      <LuaScript>
        function blockLoop() while true do print("blocking"); sleep(100) end end
        return blockLoop
      </LuaScript>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
```

- [ ] **Step 7: Write `mixed-real-shape.ct`**

Create `packages/ct-importer/test/fixtures/synthetic/mixed-real-shape.ct` — combines all above patterns into one file resembling a real community table:

```xml
<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="42">
  <CheatEntries>
    <CheatEntry>
      <ID>100</ID>
      <Description>"Player"</Description>
      <Options moHideChildren="1"/>
      <GroupHeader>1</GroupHeader>
      <CheatEntries>
        <CheatEntry>
          <ID>101</ID>
          <Description>"Infinite HP"</Description>
          <VariableType>4 Bytes</VariableType>
          <Address>"target"+0040303C</Address>
          <Hotkeys>
            <Hotkey><Action>Toggle Activation</Action><Keys><Key>112</Key></Keys><ID>0</ID></Hotkey>
          </Hotkeys>
        </CheatEntry>
        <CheatEntry>
          <ID>102</ID>
          <Description>"Speed (1.0=normal)"</Description>
          <VariableType>Float</VariableType>
          <Address>"target"+00403040</Address>
          <Hotkeys>
            <Hotkey><Action>Toggle Activation</Action><Keys><Key>115</Key></Keys><ID>0</ID></Hotkey>
            <Hotkey><Action>Increase Value</Action><Keys><Key>33</Key></Keys><Value>0.1</Value><ID>1</ID></Hotkey>
            <Hotkey><Action>Decrease Value</Action><Keys><Key>34</Key></Keys><Value>0.1</Value><ID>2</ID></Hotkey>
          </Hotkeys>
        </CheatEntry>
        <CheatEntry>
          <ID>103</ID>
          <Description>"Player HP (chained)"</Description>
          <VariableType>4 Bytes</VariableType>
          <Address>"target"+00403090</Address>
          <Offsets><Offset>0</Offset><Offset>0</Offset></Offsets>
        </CheatEntry>
      </CheatEntries>
    </CheatEntry>
    <CheatEntry>
      <ID>200</ID>
      <Description>"Auto-Block"</Description>
      <LuaScript>function blockLoop() end</LuaScript>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
```

- [ ] **Step 8: Commit**

```bash
git add packages/ct-importer/test/fixtures/
git commit -m "test(ct-importer): add synthetic .CT fixtures for each conversion path"
```

---

## Task 4: XML Parser Wrapper

**Files:**
- Create: `packages/ct-importer/src/xml-parser.ts`
- Create: `packages/ct-importer/test/xml-parser.test.ts`

`fast-xml-parser` is configurable in many ways. We standardise on a config that produces predictable shapes for the `.CT` cases we care about, then expose one function `parseCt(xml)`.

- [ ] **Step 1: Write the failing parser test**

Create `packages/ct-importer/test/xml-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCt, type CtRoot } from '../src/xml-parser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(HERE, 'fixtures/synthetic', name), 'utf8');

describe('parseCt', () => {
  it('parses basic-static.ct into nested entries', () => {
    const root: CtRoot = parseCt(fixture('basic-static.ct'));
    expect(root.CheatTable).toBeDefined();
    const entries = root.CheatTable.CheatEntries.CheatEntry;
    const list = Array.isArray(entries) ? entries : [entries];
    expect(list).toHaveLength(2);
    expect(list[0]!.Description).toBe('"Health"');
    expect(list[0]!.VariableType).toBe('4 Bytes');
    expect(list[0]!.Address).toBe('"target"+0040303C');
  });

  it('parses grouped.ct preserving nested CheatEntries', () => {
    const root = parseCt(fixture('grouped.ct'));
    const entries = root.CheatTable.CheatEntries.CheatEntry;
    const list = Array.isArray(entries) ? entries : [entries];
    expect(list).toHaveLength(2);
    expect(list[0]!.GroupHeader).toBe(1);
    expect(list[0]!.CheatEntries).toBeDefined();
  });

  it('parses hotkeys.ct preserving array semantics for multiple hotkeys', () => {
    const root = parseCt(fixture('hotkeys.ct'));
    const entries = root.CheatTable.CheatEntries.CheatEntry as any[];
    const speed = entries[1];
    const hks = speed.Hotkeys.Hotkey;
    expect(Array.isArray(hks)).toBe(true);
    expect(hks).toHaveLength(3);
  });

  it('returns a single Hotkey as an array (forced)', () => {
    const root = parseCt(fixture('hotkeys.ct'));
    const entries = root.CheatTable.CheatEntries.CheatEntry as any[];
    const hp = entries[0];
    const hks = hp.Hotkeys.Hotkey;
    expect(Array.isArray(hks)).toBe(true);
    expect(hks).toHaveLength(1);
  });

  it('throws on malformed XML', () => {
    expect(() => parseCt('<not really xml')).toThrow();
  });
});
```

- [ ] **Step 2: Run test (fails — module missing)**

Run: `pnpm --filter @starlight/ct-importer test xml-parser`
Expected: FAIL "Failed to load url ../src/xml-parser.js".

- [ ] **Step 3: Implement the parser**

Create `packages/ct-importer/src/xml-parser.ts`:

```ts
import { XMLParser } from 'fast-xml-parser';

/* Shape of a parsed .CT root. We type only the fields the importer reads;
 * everything else is allowed via index signatures. */
export interface CtRoot {
  CheatTable: {
    CheatEntries: { CheatEntry: CtEntry | CtEntry[] };
    [k: string]: unknown;
  };
}

export interface CtEntry {
  ID?: number;
  Description?: string;
  VariableType?: string;
  Address?: string;
  Offsets?: { Offset: number | number[] };
  Hotkeys?: { Hotkey: CtHotkey | CtHotkey[] };
  GroupHeader?: number;
  CheatEntries?: { CheatEntry: CtEntry | CtEntry[] };
  AssemblerScript?: string;
  LuaScript?: string;
  [k: string]: unknown;
}

export interface CtHotkey {
  Action?: string;
  Keys?: { Key: number | number[] };
  Value?: string | number;
  ID?: number;
}

const ALWAYS_ARRAY = new Set([
  'CheatTable.CheatEntries.CheatEntry',
  'CheatTable.CheatEntries.CheatEntry.CheatEntries.CheatEntry',
  'CheatTable.CheatEntries.CheatEntry.Hotkeys.Hotkey',
  'CheatTable.CheatEntries.CheatEntry.Offsets.Offset',
  'CheatTable.CheatEntries.CheatEntry.Hotkeys.Hotkey.Keys.Key',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
  isArray: (_name, jpath) => ALWAYS_ARRAY.has(jpath) || jpath.endsWith('.CheatEntry'),
});

export function parseCt(xml: string): CtRoot {
  const parsed = parser.parse(xml);
  if (!parsed || typeof parsed !== 'object' || !('CheatTable' in parsed)) {
    throw new Error('parseCt: input does not look like a Cheat Engine table (no <CheatTable> root)');
  }
  return parsed as CtRoot;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @starlight/ct-importer test xml-parser`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer/src/xml-parser.ts packages/ct-importer/test/xml-parser.test.ts
git commit -m "feat(ct-importer): add XML parser wrapper for .CT files"
```

---

## Task 5: Type Mapper

**Files:**
- Create: `packages/ct-importer/src/type-mapper.ts`
- Create: `packages/ct-importer/test/type-mapper.test.ts`

Maps Cheat Engine `<VariableType>` strings to Starlight `ValueType`.

- [ ] **Step 1: Write the failing test**

Create `packages/ct-importer/test/type-mapper.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapCtType } from '../src/type-mapper.js';

describe('mapCtType', () => {
  it.each([
    ['Byte', 'uint8'],
    ['2 Bytes', 'int16'],
    ['4 Bytes', 'int32'],
    ['8 Bytes', 'int64'],
    ['Float', 'float'],
    ['Double', 'double'],
    ['String', 'string'],
  ])('maps %s to %s', (ctType, expected) => {
    expect(mapCtType(ctType)).toBe(expected);
  });

  it('returns undefined for unknown types', () => {
    expect(mapCtType('Array of byte')).toBeUndefined();
    expect(mapCtType('Binary')).toBeUndefined();
    expect(mapCtType('')).toBeUndefined();
  });

  it('is case-insensitive on the leading word', () => {
    expect(mapCtType('float')).toBe('float');
    expect(mapCtType('FLOAT')).toBe('float');
  });
});
```

- [ ] **Step 2: Run (fails)**

Run: `pnpm --filter @starlight/ct-importer test type-mapper`
Expected: FAIL "Failed to load url ../src/type-mapper.js".

- [ ] **Step 3: Implement**

Create `packages/ct-importer/src/type-mapper.ts`:

```ts
import type { StarlightValueType } from './starlight-format.js';

const TABLE: Record<string, StarlightValueType> = {
  'byte': 'uint8',
  '2 bytes': 'int16',
  '4 bytes': 'int32',
  '8 bytes': 'int64',
  'float': 'float',
  'double': 'double',
  'string': 'string',
};

export function mapCtType(ctType: string): StarlightValueType | undefined {
  return TABLE[ctType.toLowerCase()];
}
```

- [ ] **Step 4: Run (passes)**

Run: `pnpm --filter @starlight/ct-importer test type-mapper`
Expected: PASS — 9 tests (7 from `it.each`, 1 unknown, 1 case).

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer/src/type-mapper.ts packages/ct-importer/test/type-mapper.test.ts
git commit -m "feat(ct-importer): map CT VariableType strings to Starlight ValueType"
```

---

## Task 6: Address Parser

**Files:**
- Create: `packages/ct-importer/src/address-parser.ts`
- Create: `packages/ct-importer/test/address-parser.test.ts`

Parses the `<Address>` and `<Offsets>` elements into a Starlight `Address` discriminated union.

Recognised forms:
- `0x4A2B3C` → absolute
- `4A2B3C` → absolute (no `0x` prefix; CE common)
- `"game.exe"+1A2B3C` → module-relative
- `aobscanmodule(NAME, MODULE, BYTES)[+offset]` → AOB
- Anything with a Lua-eval expression (e.g. `getAddress(...)`) → return `null` so caller flags unsupported

When `<Offsets>` is present, the address kind becomes `pointer` regardless of the base form. The `baseOffset` of a `pointer` is the absolute or module-relative resolved hex string — for module-relative bases we keep the module name in `module` and emit just the offset in `baseOffset`.

- [ ] **Step 1: Write the failing test**

Create `packages/ct-importer/test/address-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseAddress, type ParsedAddress } from '../src/address-parser.js';

describe('parseAddress', () => {
  it('parses absolute hex with 0x prefix', () => {
    expect(parseAddress('0x4A2B3C')).toEqual<ParsedAddress>({
      kind: 'absolute', address: '0x4a2b3c',
    });
  });

  it('parses absolute hex without prefix', () => {
    expect(parseAddress('4A2B3C')).toEqual<ParsedAddress>({
      kind: 'absolute', address: '0x4a2b3c',
    });
  });

  it('parses quoted-module-relative', () => {
    expect(parseAddress('"game.exe"+1A2B3C')).toEqual<ParsedAddress>({
      kind: 'module', module: 'game.exe', offset: '0x1a2b3c',
    });
  });

  it('parses unquoted-module-relative', () => {
    expect(parseAddress('game.exe+1A2B3C')).toEqual<ParsedAddress>({
      kind: 'module', module: 'game.exe', offset: '0x1a2b3c',
    });
  });

  it('parses aobscanmodule with offset', () => {
    const r = parseAddress('aobscanmodule(SIG, target, DE AD BE EF)+0C');
    expect(r).toEqual<ParsedAddress>({
      kind: 'aob',
      module: 'target',
      pattern: 'DE AD BE EF',
      offset: '0xc',
    });
  });

  it('parses aobscanmodule without offset', () => {
    const r = parseAddress('aobscanmodule(SIG, target, DE AD BE EF)');
    expect(r).toEqual<ParsedAddress>({
      kind: 'aob',
      module: 'target',
      pattern: 'DE AD BE EF',
    });
  });

  it('returns null for Lua-eval style expressions', () => {
    expect(parseAddress('getAddress("foo") + 0x10')).toBeNull();
  });

  it('promotes to pointer when offsets are provided', () => {
    expect(parseAddress('"game.exe"+1A2B3C', [0, 16, 32])).toEqual<ParsedAddress>({
      kind: 'pointer',
      module: 'game.exe',
      baseOffset: '0x1a2b3c',
      offsets: ['0x0', '0x10', '0x20'],
    });
  });

  it('promotes absolute base to pointer with no module', () => {
    expect(parseAddress('0x4A2B3C', [16])).toEqual<ParsedAddress>({
      kind: 'pointer',
      baseOffset: '0x4a2b3c',
      offsets: ['0x10'],
    });
  });
});
```

- [ ] **Step 2: Run (fails)**

Run: `pnpm --filter @starlight/ct-importer test address-parser`
Expected: FAIL "Failed to load url ../src/address-parser.js".

- [ ] **Step 3: Implement**

Create `packages/ct-importer/src/address-parser.ts`:

```ts
import type { StarlightAddress } from './starlight-format.js';

export type ParsedAddress = StarlightAddress;

const HEX_ONLY = /^[0-9a-fA-F]+$/;
const HEX_WITH_PREFIX = /^0x([0-9a-fA-F]+)$/i;

const QUOTED_MODULE = /^"([^"]+)"\s*\+\s*([0-9a-fA-F]+)$/;
const UNQUOTED_MODULE = /^([A-Za-z_][A-Za-z0-9_.]*\.(exe|dll))\s*\+\s*([0-9a-fA-F]+)$/i;

const AOBSCAN = /^aobscanmodule\s*\(\s*[^,]+\s*,\s*([^,]+?)\s*,\s*([^)]+?)\s*\)(?:\s*\+\s*([0-9a-fA-F]+))?$/i;

function toHex(n: number | string): string {
  if (typeof n === 'number') return '0x' + n.toString(16);
  const stripped = n.toLowerCase().replace(/^0x/, '');
  return '0x' + stripped;
}

export function parseAddress(addr: string, offsets?: number[]): ParsedAddress | null {
  const trimmed = addr.trim();

  let base:
    | { kind: 'absolute'; address: string }
    | { kind: 'module'; module: string; offset: string }
    | null = null;

  let aobMatch: { kind: 'aob'; module: string; pattern: string; offset?: string } | null = null;

  const m = AOBSCAN.exec(trimmed);
  if (m) {
    aobMatch = {
      kind: 'aob',
      module: m[1]!.trim(),
      pattern: m[2]!.trim(),
      ...(m[3] ? { offset: toHex(m[3]) } : {}),
    };
  } else if (QUOTED_MODULE.test(trimmed)) {
    const q = QUOTED_MODULE.exec(trimmed)!;
    base = { kind: 'module', module: q[1]!, offset: toHex(q[2]!) };
  } else if (UNQUOTED_MODULE.test(trimmed)) {
    const q = UNQUOTED_MODULE.exec(trimmed)!;
    base = { kind: 'module', module: q[1]!, offset: toHex(q[3]!) };
  } else if (HEX_WITH_PREFIX.test(trimmed)) {
    base = { kind: 'absolute', address: toHex(trimmed) };
  } else if (HEX_ONLY.test(trimmed)) {
    base = { kind: 'absolute', address: toHex(trimmed) };
  } else {
    return null; // unrecognised — caller should flag unsupported
  }

  if (aobMatch) {
    if (offsets && offsets.length > 0) {
      // We don't model AOB-with-pointer-chain in v1; flag as unsupported.
      return null;
    }
    return aobMatch;
  }

  if (offsets && offsets.length > 0) {
    if (base!.kind === 'module') {
      return {
        kind: 'pointer',
        module: base.module,
        baseOffset: base.offset,
        offsets: offsets.map(toHex),
      };
    }
    return {
      kind: 'pointer',
      baseOffset: base!.address,
      offsets: offsets.map(toHex),
    };
  }

  return base!;
}
```

- [ ] **Step 4: Run (passes)**

Run: `pnpm --filter @starlight/ct-importer test address-parser`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer/src/address-parser.ts packages/ct-importer/test/address-parser.test.ts
git commit -m "feat(ct-importer): parse CT Address and Offsets into Starlight address spec"
```

---

## Task 7: Hotkey Parser

**Files:**
- Create: `packages/ct-importer/src/hotkey-parser.ts`
- Create: `packages/ct-importer/test/hotkey-parser.test.ts`

Cheat Engine encodes hotkeys as Windows virtual-key codes. We map the common ones to Electron-friendly accelerator strings (e.g. `F1`, `PageUp`, `Ctrl+F1`). Unknown keys produce `undefined` for that hotkey slot.

CE actions we recognise:
- `Toggle Activation` → `toggle`
- `Increase Value` → `inc`
- `Decrease Value` → `dec`

- [ ] **Step 1: Write the failing test**

Create `packages/ct-importer/test/hotkey-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHotkeys } from '../src/hotkey-parser.js';
import type { CtHotkey } from '../src/xml-parser.js';

describe('parseHotkeys', () => {
  it('returns undefined for empty input', () => {
    expect(parseHotkeys(undefined)).toBeUndefined();
    expect(parseHotkeys([])).toBeUndefined();
  });

  it('parses a single Toggle Activation with F1 (VK 112)', () => {
    const input: CtHotkey[] = [{ Action: 'Toggle Activation', Keys: { Key: 112 } }];
    expect(parseHotkeys(input)).toEqual({ toggle: 'F1' });
  });

  it('parses Increase / Decrease Value with PageUp/PageDown', () => {
    const input: CtHotkey[] = [
      { Action: 'Toggle Activation', Keys: { Key: 115 } }, // F4
      { Action: 'Increase Value', Keys: { Key: 33 } },     // PageUp
      { Action: 'Decrease Value', Keys: { Key: 34 } },     // PageDown
    ];
    expect(parseHotkeys(input)).toEqual({ toggle: 'F4', inc: 'PageUp', dec: 'PageDown' });
  });

  it('combines modifiers Ctrl/Shift/Alt with the main key', () => {
    const input: CtHotkey[] = [
      { Action: 'Toggle Activation', Keys: { Key: [17, 112] } }, // Ctrl + F1
    ];
    expect(parseHotkeys(input)).toEqual({ toggle: 'Ctrl+F1' });
  });

  it('returns undefined toggle for unmapped keys', () => {
    const input: CtHotkey[] = [{ Action: 'Toggle Activation', Keys: { Key: 99999 } }];
    expect(parseHotkeys(input)).toBeUndefined();
  });

  it('ignores actions we do not recognise', () => {
    const input: CtHotkey[] = [
      { Action: 'Toggle Activation', Keys: { Key: 112 } },
      { Action: 'Set Value to', Keys: { Key: 113 } }, // not in our action set
    ];
    expect(parseHotkeys(input)).toEqual({ toggle: 'F1' });
  });
});
```

- [ ] **Step 2: Run (fails)**

Run: `pnpm --filter @starlight/ct-importer test hotkey-parser`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/ct-importer/src/hotkey-parser.ts`:

```ts
import type { CtHotkey } from './xml-parser.js';

const VK_TO_ACCEL: Record<number, string> = {
  // Modifiers — handled separately, mapped to '' so they don't leak into the result key
  16: '',  17: '',  18: '',
  // F-keys
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6',
  118: 'F7', 119: 'F8', 120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12',
  // Navigation
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down',
  45: 'Insert', 46: 'Delete',
  // Letters/numbers (subset; expand as needed)
  48: '0', 49: '1', 50: '2', 51: '3', 52: '4',
  53: '5', 54: '6', 55: '7', 56: '8', 57: '9',
};

const MODIFIERS: Record<number, string> = { 16: 'Shift', 17: 'Ctrl', 18: 'Alt' };

const ACTION_TO_SLOT: Record<string, 'toggle' | 'inc' | 'dec'> = {
  'Toggle Activation': 'toggle',
  'Increase Value': 'inc',
  'Decrease Value': 'dec',
};

interface ParsedHotkeys { toggle?: string; inc?: string; dec?: string }

function keysToAccel(keys: number | number[]): string | undefined {
  const arr = Array.isArray(keys) ? keys : [keys];
  const mods: string[] = [];
  let main: string | undefined;
  for (const k of arr) {
    if (MODIFIERS[k]) { mods.push(MODIFIERS[k]); continue; }
    const m = VK_TO_ACCEL[k];
    if (m) main = m;
  }
  if (!main) return undefined;
  return mods.length ? `${mods.join('+')}+${main}` : main;
}

export function parseHotkeys(hotkeys: CtHotkey[] | undefined): ParsedHotkeys | undefined {
  if (!hotkeys || hotkeys.length === 0) return undefined;
  const out: ParsedHotkeys = {};
  for (const hk of hotkeys) {
    const slot = hk.Action ? ACTION_TO_SLOT[hk.Action] : undefined;
    if (!slot) continue;
    const accel = hk.Keys ? keysToAccel(hk.Keys.Key) : undefined;
    if (accel) out[slot] = accel;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
```

- [ ] **Step 4: Run (passes)**

Run: `pnpm --filter @starlight/ct-importer test hotkey-parser`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer/src/hotkey-parser.ts packages/ct-importer/test/hotkey-parser.test.ts
git commit -m "feat(ct-importer): convert CT VK-coded hotkeys to accelerator strings"
```

---

## Task 8: Script Classifier

**Files:**
- Create: `packages/ct-importer/src/script-classifier.ts`
- Create: `packages/ct-importer/test/script-classifier.test.ts`

Decides whether a `<LuaScript>` or `<AssemblerScript>` field can be converted to an executable Starlight cheat. v1 policy:

- Any `<LuaScript>` → unsupported (we don't run Lua).
- `<AssemblerScript>` is unsupported in v1. Phase 2 doesn't translate assembler hooks — Phase 3+ may. We mark them unsupported with a recognisable reason so the desktop app's UI can show "open in Cheat Engine".

This module is intentionally thin in v1 but isolated so its policy can grow without rewriting `entry-converter`.

- [ ] **Step 1: Write the failing test**

Create `packages/ct-importer/test/script-classifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyScript } from '../src/script-classifier.js';

describe('classifyScript', () => {
  it('flags Lua scripts as unsupported', () => {
    const r = classifyScript({ luaScript: 'function blockLoop() end' });
    expect(r).toEqual({
      supported: false,
      reason: 'Uses Cheat Engine Lua API. Open the original .CT in Cheat Engine to use this entry.',
    });
  });

  it('flags assembler scripts as unsupported in v1', () => {
    const r = classifyScript({ assemblerScript: '[ENABLE]\naobscanmodule(...)\n' });
    expect(r).toEqual({
      supported: false,
      reason: 'Cheat Engine assembler script. Open the original .CT in Cheat Engine.',
    });
  });

  it('returns supported=true when there is no script field', () => {
    expect(classifyScript({})).toEqual({ supported: true });
  });

  it('prefers the Lua message when both are present (rare but possible)', () => {
    const r = classifyScript({ luaScript: 'x', assemblerScript: 'y' });
    expect(r.supported).toBe(false);
    expect(r.reason).toContain('Lua');
  });
});
```

- [ ] **Step 2: Run (fails)**

Run: `pnpm --filter @starlight/ct-importer test script-classifier`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/ct-importer/src/script-classifier.ts`:

```ts
export interface ScriptInput {
  luaScript?: string;
  assemblerScript?: string;
}

export type ScriptClassification =
  | { supported: true }
  | { supported: false; reason: string };

export function classifyScript(input: ScriptInput): ScriptClassification {
  if (input.luaScript && input.luaScript.trim().length > 0) {
    return {
      supported: false,
      reason: 'Uses Cheat Engine Lua API. Open the original .CT in Cheat Engine to use this entry.',
    };
  }
  if (input.assemblerScript && input.assemblerScript.trim().length > 0) {
    return {
      supported: false,
      reason: 'Cheat Engine assembler script. Open the original .CT in Cheat Engine.',
    };
  }
  return { supported: true };
}
```

- [ ] **Step 4: Run (passes)**

Run: `pnpm --filter @starlight/ct-importer test script-classifier`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer/src/script-classifier.ts packages/ct-importer/test/script-classifier.test.ts
git commit -m "feat(ct-importer): classify Lua/assembler scripts as unsupported in v1"
```

---

## Task 9: Entry Converter

**Files:**
- Create: `packages/ct-importer/src/entry-converter.ts`
- Create: `packages/ct-importer/test/entry-converter.test.ts`

Converts one `CtEntry` to either a `StarlightSupportedCheat`, a `StarlightUnsupportedCheat`, or a category (when `GroupHeader` is set). Returns a discriminated result.

- [ ] **Step 1: Write the failing test**

Create `packages/ct-importer/test/entry-converter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { convertEntry, type ConvertedEntry } from '../src/entry-converter.js';
import type { CtEntry } from '../src/xml-parser.js';

describe('convertEntry', () => {
  it('converts a simple static entry to a freeze cheat', () => {
    const entry: CtEntry = {
      ID: 1,
      Description: '"Health"',
      VariableType: '4 Bytes',
      Address: '"target"+0040303C',
    };
    const r = convertEntry(entry);
    expect(r.kind).toBe('cheat');
    if (r.kind !== 'cheat') return;
    expect(r.cheat).toMatchObject({
      id: 'cheat-1',
      name: 'Health',
      type: 'freeze',
      valueType: 'int32',
      address: { kind: 'module', module: 'target', offset: '0x40303c' },
    });
  });

  it('converts pointer-chain entries', () => {
    const entry: CtEntry = {
      ID: 2,
      Description: '"Player HP"',
      VariableType: '4 Bytes',
      Address: '"target"+00403090',
      Offsets: { Offset: [0, 0] },
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || r.cheat.unsupported) throw new Error('expected supported cheat');
    expect(r.cheat.address).toMatchObject({
      kind: 'pointer',
      module: 'target',
      baseOffset: '0x403090',
      offsets: ['0x0', '0x0'],
    });
  });

  it('converts AOB scan entries', () => {
    const entry: CtEntry = {
      ID: 3,
      Description: '"AOB Hit"',
      VariableType: 'Float',
      Address: 'aobscanmodule(SIG, target, DE AD BE EF)+0C',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || r.cheat.unsupported) throw new Error('expected supported cheat');
    expect(r.cheat.address).toMatchObject({
      kind: 'aob', module: 'target', pattern: 'DE AD BE EF', offset: '0xc',
    });
  });

  it('converts entries with a single Toggle Activation hotkey', () => {
    const entry: CtEntry = {
      ID: 4,
      Description: '"Infinite HP"',
      VariableType: '4 Bytes',
      Address: '"target"+0040303C',
      Hotkeys: { Hotkey: [{ Action: 'Toggle Activation', Keys: { Key: 112 } }] },
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || r.cheat.unsupported) throw new Error('expected supported cheat');
    expect(r.cheat.hotkeys).toEqual({ toggle: 'F1' });
  });

  it('returns a category for GroupHeader entries', () => {
    const entry: CtEntry = {
      ID: 10,
      Description: '"Player"',
      GroupHeader: 1,
      CheatEntries: { CheatEntry: [{
        ID: 11, Description: '"Health"', VariableType: '4 Bytes', Address: '"target"+0040303C',
      }] },
    };
    const r = convertEntry(entry);
    expect(r.kind).toBe('category');
    if (r.kind !== 'category') return;
    expect(r.name).toBe('Player');
    expect(r.children).toHaveLength(1);
  });

  it('flags Lua scripts as unsupported', () => {
    const entry: CtEntry = {
      ID: 5,
      Description: '"Auto-Block"',
      LuaScript: 'function blockLoop() end',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || !r.cheat.unsupported) throw new Error('expected unsupported');
    expect(r.cheat.unsupportedReason).toMatch(/Lua/i);
    expect(r.cheat.originalSource).toContain('blockLoop');
  });

  it('flags entries with no usable VariableType+Address as unsupported', () => {
    const entry: CtEntry = {
      ID: 6,
      Description: '"Nothing"',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || !r.cheat.unsupported) throw new Error('expected unsupported');
    expect(r.cheat.unsupportedReason).toMatch(/missing/i);
  });

  it('flags Lua-eval addresses as unsupported with the original source', () => {
    const entry: CtEntry = {
      ID: 7,
      Description: '"Computed"',
      VariableType: '4 Bytes',
      Address: 'getAddress("foo") + 0x10',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || !r.cheat.unsupported) throw new Error('expected unsupported');
    expect(r.cheat.unsupportedReason).toMatch(/address/i);
    expect(r.cheat.originalSource).toBe('getAddress("foo") + 0x10');
  });

  it('strips wrapping quotes from Description', () => {
    const entry: CtEntry = {
      ID: 8, Description: '"Quoted"', VariableType: '4 Bytes', Address: '0x4A2B3C',
    };
    const r = convertEntry(entry);
    if (r.kind !== 'cheat' || r.cheat.unsupported) throw new Error('expected supported');
    expect(r.cheat.name).toBe('Quoted');
  });
});
```

- [ ] **Step 2: Run (fails)**

Run: `pnpm --filter @starlight/ct-importer test entry-converter`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/ct-importer/src/entry-converter.ts`:

```ts
import type { CtEntry, CtHotkey } from './xml-parser.js';
import { mapCtType } from './type-mapper.js';
import { parseAddress } from './address-parser.js';
import { parseHotkeys } from './hotkey-parser.js';
import { classifyScript } from './script-classifier.js';
import type { StarlightSupportedCheat, StarlightUnsupportedCheat } from './starlight-format.js';

export type ConvertedEntry =
  | { kind: 'cheat'; cheat: StarlightSupportedCheat | StarlightUnsupportedCheat }
  | { kind: 'category'; name: string; children: CtEntry[] };

function stripQuotes(s: string): string {
  return s.replace(/^"+|"+$/g, '');
}

function entryId(entry: CtEntry): string {
  return `cheat-${entry.ID ?? 'anon'}`;
}

function entryName(entry: CtEntry): string {
  return stripQuotes(entry.Description ?? 'Unnamed');
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function convertEntry(entry: CtEntry): ConvertedEntry {
  if (entry.GroupHeader === 1) {
    const children = asArray(entry.CheatEntries?.CheatEntry);
    return { kind: 'category', name: entryName(entry), children };
  }

  const script = classifyScript({
    luaScript: entry.LuaScript,
    assemblerScript: entry.AssemblerScript,
  });
  if (!script.supported) {
    return {
      kind: 'cheat',
      cheat: {
        id: entryId(entry),
        name: entryName(entry),
        unsupported: true,
        unsupportedReason: script.reason,
        ...(entry.LuaScript || entry.AssemblerScript
          ? { originalSource: (entry.LuaScript ?? entry.AssemblerScript)! }
          : {}),
      },
    };
  }

  const valueType = entry.VariableType ? mapCtType(entry.VariableType) : undefined;
  if (!valueType || !entry.Address) {
    return {
      kind: 'cheat',
      cheat: {
        id: entryId(entry),
        name: entryName(entry),
        unsupported: true,
        unsupportedReason: 'Entry is missing a usable VariableType or Address.',
      },
    };
  }

  const offsets = asArray(entry.Offsets?.Offset).map((n) => Number(n));
  const address = parseAddress(entry.Address, offsets.length > 0 ? offsets : undefined);

  if (!address) {
    return {
      kind: 'cheat',
      cheat: {
        id: entryId(entry),
        name: entryName(entry),
        unsupported: true,
        unsupportedReason: 'Address expression is not a literal Cheat Engine produces (possibly Lua-evaluated).',
        originalSource: entry.Address,
      },
    };
  }

  const hotkeyArr = asArray(entry.Hotkeys?.Hotkey) as CtHotkey[];
  const hotkeys = parseHotkeys(hotkeyArr);

  const cheat: StarlightSupportedCheat = {
    id: entryId(entry),
    name: entryName(entry),
    type: 'freeze',
    valueType,
    address,
    ...(hotkeys ? { hotkeys } : {}),
  };
  return { kind: 'cheat', cheat };
}
```

- [ ] **Step 4: Run (passes)**

Run: `pnpm --filter @starlight/ct-importer test entry-converter`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ct-importer/src/entry-converter.ts packages/ct-importer/test/entry-converter.test.ts
git commit -m "feat(ct-importer): convert one CT CheatEntry to Starlight cheat or category"
```

---

## Task 10: Stats Module + Top-Level Importer

**Files:**
- Create: `packages/ct-importer/src/stats.ts`
- Create: `packages/ct-importer/src/ct-importer.ts`
- Create: `packages/ct-importer/test/ct-importer.test.ts`
- Modify: `packages/ct-importer/src/index.ts`

Walks the parsed `.CT` tree, calls `convertEntry` per node, builds a `StarlightTrainer`, and tracks stats (total / supported / unsupported / categories).

The trainer's `game.name` and `game.processName` are NOT in the `.CT` file. We require the caller to provide them; otherwise we emit placeholders so the JSON is still valid for downstream tooling.

- [ ] **Step 1: Write the failing test**

Create `packages/ct-importer/test/ct-importer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCt } from '../src/ct-importer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(HERE, 'fixtures/synthetic', name), 'utf8');

describe('importCt', () => {
  it('imports basic-static.ct: 2 supported cheats in 1 default category', () => {
    const result = importCt(fixture('basic-static.ct'), {
      gameName: 'Test Target',
      processName: ['target'],
    });
    expect(result.stats).toEqual({ total: 2, supported: 2, unsupported: 0, categories: 1 });
    expect(result.trainer.categories).toHaveLength(1);
    expect(result.trainer.categories[0]!.cheats).toHaveLength(2);
    expect(result.trainer.game.name).toBe('Test Target');
  });

  it('imports grouped.ct: 2 categories with 1 cheat each', () => {
    const result = importCt(fixture('grouped.ct'), {
      gameName: 'Test Target',
      processName: ['target'],
    });
    expect(result.stats).toEqual({ total: 2, supported: 2, unsupported: 0, categories: 2 });
    expect(result.trainer.categories.map((c) => c.name)).toEqual(['Player', 'Stats']);
  });

  it('imports lua-script.ct as 1 unsupported entry', () => {
    const result = importCt(fixture('lua-script.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.stats).toEqual({ total: 1, supported: 0, unsupported: 1, categories: 1 });
    const cheat = result.trainer.categories[0]!.cheats[0]!;
    expect('unsupported' in cheat && cheat.unsupported).toBe(true);
  });

  it('imports mixed-real-shape.ct: counts stats correctly', () => {
    const result = importCt(fixture('mixed-real-shape.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.stats.total).toBe(4);
    expect(result.stats.supported).toBe(3);
    expect(result.stats.unsupported).toBe(1);
  });

  it('produced trainer validates against the schema', () => {
    const result = importCt(fixture('mixed-real-shape.ct'), {
      gameName: 'X', processName: ['x'],
    });
    // Importing the schema dynamically to keep this test self-contained.
    return import('../src/starlight-format.js').then((m) => {
      expect(() => m.StarlightTrainerSchema.parse(result.trainer)).not.toThrow();
    });
  });

  it('puts top-level non-grouped cheats in a single "General" category', () => {
    const result = importCt(fixture('hotkeys.ct'), {
      gameName: 'X', processName: ['x'],
    });
    expect(result.trainer.categories).toHaveLength(1);
    expect(result.trainer.categories[0]!.name).toBe('General');
  });
});
```

- [ ] **Step 2: Run (fails)**

Run: `pnpm --filter @starlight/ct-importer test ct-importer`
Expected: FAIL.

- [ ] **Step 3: Implement stats module**

Create `packages/ct-importer/src/stats.ts`:

```ts
export interface ImportStats {
  total: number;
  supported: number;
  unsupported: number;
  categories: number;
}

export function emptyStats(): ImportStats {
  return { total: 0, supported: 0, unsupported: 0, categories: 0 };
}
```

- [ ] **Step 4: Implement top-level importer**

Create `packages/ct-importer/src/ct-importer.ts`:

```ts
import { parseCt, type CtEntry } from './xml-parser.js';
import { convertEntry } from './entry-converter.js';
import { emptyStats, type ImportStats } from './stats.js';
import type {
  StarlightTrainer,
  StarlightCategory,
  StarlightCheat,
} from './starlight-format.js';

export interface ImportOptions {
  gameName: string;
  processName: string[];
  steamAppId?: number;
  version?: string;
  platform?: ('windows' | 'linux' | 'linux-proton' | 'macos')[];
  sourceUrl?: string;
}

export interface ImportResult {
  trainer: StarlightTrainer;
  stats: ImportStats;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function importCt(xml: string, opts: ImportOptions): ImportResult {
  const root = parseCt(xml);
  const top = asArray(root.CheatTable.CheatEntries.CheatEntry);
  const stats = emptyStats();
  const categories: StarlightCategory[] = [];
  const generalCheats: StarlightCheat[] = [];

  function walkAt(entry: CtEntry, intoCheats: StarlightCheat[]): void {
    const r = convertEntry(entry);
    if (r.kind === 'category') {
      const childCheats: StarlightCheat[] = [];
      for (const c of r.children) walkAt(c, childCheats);
      categories.push({ name: r.name, cheats: childCheats });
      stats.categories += 1;
    } else {
      intoCheats.push(r.cheat);
      stats.total += 1;
      if ('unsupported' in r.cheat && r.cheat.unsupported) stats.unsupported += 1;
      else stats.supported += 1;
    }
  }

  for (const entry of top) walkAt(entry, generalCheats);

  if (generalCheats.length > 0) {
    categories.unshift({ name: 'General', cheats: generalCheats });
    stats.categories += 1;
  }

  const trainer: StarlightTrainer = {
    schemaVersion: 1,
    id: `starlight-${slugify(opts.gameName)}-${Date.now()}`,
    game: {
      name: opts.gameName,
      processName: opts.processName,
      platform: opts.platform ?? ['windows'],
      ...(opts.steamAppId !== undefined ? { steamAppId: opts.steamAppId } : {}),
      ...(opts.version ? { version: opts.version } : {}),
    },
    metadata: {
      source: {
        convertedFrom: '.CT',
        ...(opts.sourceUrl ? { url: opts.sourceUrl } : {}),
      },
      convertedAt: new Date().toISOString(),
    },
    categories,
  };

  return { trainer, stats };
}
```

- [ ] **Step 5: Update barrel**

Replace `packages/ct-importer/src/index.ts`:

```ts
export {
  StarlightTrainerSchema,
  type StarlightTrainer,
  type StarlightCheat,
  type StarlightSupportedCheat,
  type StarlightUnsupportedCheat,
  type StarlightCategory,
  type StarlightAddress,
  type StarlightValueType,
} from './starlight-format.js';
export { importCt, type ImportOptions, type ImportResult } from './ct-importer.js';
export { type ImportStats } from './stats.js';
```

- [ ] **Step 6: Run (passes)**

Run: `pnpm --filter @starlight/ct-importer test ct-importer`
Expected: PASS — 6 tests.

- [ ] **Step 7: Run full suite**

Run: `pnpm --filter @starlight/ct-importer test`
Expected: PASS — all tests across all files.

- [ ] **Step 8: Commit**

```bash
git add packages/ct-importer/src/ packages/ct-importer/test/ct-importer.test.ts
git commit -m "feat(ct-importer): top-level importCt(xml, opts) with stats"
```

---

## Task 11: CLI Entrypoint

**Files:**
- Create: `packages/ct-importer/src/cli.ts`
- Create: `packages/ct-importer/test/cli.test.ts`

Thin commander-based CLI that reads a `.CT` file, calls `importCt`, and writes the JSON result. Required options: `--game-name`, `--process`. Optional: `--out`, `--steam-id`, `--platform`, `--source-url`.

- [ ] **Step 1: Write the failing CLI test**

Create `packages/ct-importer/test/cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures/synthetic');

/* The CLI is built into dist/cli.js. The test builds the package first
 * via pnpm and then invokes node on the built script. */
function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'node',
    [resolve(HERE, '../dist/cli.js'), ...args],
    { encoding: 'utf8' },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('cli', () => {
  it('prints --help with usage and exits 0', () => {
    const r = runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stdout).toMatch(/--game-name/);
  });

  it('imports a fixture file and writes JSON output', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ct-import-'));
    try {
      const out = join(tmp, 'out.json');
      const r = runCli([
        join(FIXTURES, 'basic-static.ct'),
        '--game-name', 'Test',
        '--process', 'target',
        '--out', out,
      ]);
      expect(r.code).toBe(0);
      const json = JSON.parse(readFileSync(out, 'utf8'));
      expect(json.schemaVersion).toBe(1);
      expect(json.game.name).toBe('Test');
      expect(json.categories[0].cheats).toHaveLength(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exits non-zero when game-name is missing', () => {
    const r = runCli([join(FIXTURES, 'basic-static.ct'), '--process', 'target']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/required|game-name/i);
  });

  it('prints stats summary to stdout', () => {
    const r = runCli([
      join(FIXTURES, 'mixed-real-shape.ct'),
      '--game-name', 'Test', '--process', 'target',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/total:\s*4/i);
    expect(r.stdout).toMatch(/supported:\s*3/i);
    expect(r.stdout).toMatch(/unsupported:\s*1/i);
  });
});
```

- [ ] **Step 2: Run (fails — `dist/cli.js` doesn't exist yet)**

Run: `pnpm --filter @starlight/ct-importer test cli`
Expected: FAIL — CLI not built / module missing. (`code` will be `null` or non-zero with ENOENT-style message.)

- [ ] **Step 3: Implement the CLI**

Create `packages/ct-importer/src/cli.ts`:

```ts
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { importCt } from './ct-importer.js';

interface CliOpts {
  gameName: string;
  process: string[];
  out?: string;
  steamId?: string;
  platform?: string[];
  sourceUrl?: string;
}

const program = new Command();
program
  .name('starlight-import-ct')
  .description('Convert a Cheat Engine .CT file to a Starlight Trainer JSON')
  .argument('<file>', 'Path to a .CT file')
  .requiredOption('-g, --game-name <name>', 'Display name of the game')
  .requiredOption('-p, --process <names...>', 'Process names that the trainer attaches to (e.g. eldenring.exe)')
  .option('-o, --out <path>', 'Write JSON to this file (otherwise printed to stdout)')
  .option('--steam-id <id>', 'Steam app id')
  .option('--platform <platforms...>', 'Platforms (windows, linux, linux-proton, macos)')
  .option('--source-url <url>', 'Original URL of the .CT file (e.g. fearlessrevolution.com link)')
  .action((file: string, opts: CliOpts) => {
    const xml = readFileSync(file, 'utf8');
    const result = importCt(xml, {
      gameName: opts.gameName,
      processName: opts.process,
      ...(opts.steamId ? { steamAppId: Number(opts.steamId) } : {}),
      ...(opts.platform ? { platform: opts.platform as ImportPlatforms } : {}),
      ...(opts.sourceUrl ? { sourceUrl: opts.sourceUrl } : {}),
    });

    const json = JSON.stringify(result.trainer, null, 2);
    if (opts.out) writeFileSync(opts.out, json);
    else process.stdout.write(json + '\n');

    process.stderr.write(
      `total: ${result.stats.total}\n` +
      `supported: ${result.stats.supported}\n` +
      `unsupported: ${result.stats.unsupported}\n` +
      `categories: ${result.stats.categories}\n`,
    );
  });

type ImportPlatforms = ('windows' | 'linux' | 'linux-proton' | 'macos')[];

program.parse();
```

Note: stats are written to **stderr** so a piped `node cli.js x.ct > out.json` is clean. The CLI test asserts stats on stdout — adjust the test to assert on `r.stderr`, not `r.stdout`. (See Step 4.)

- [ ] **Step 4: Update test to read stats from stderr**

Edit `packages/ct-importer/test/cli.test.ts` final test — change `expect(r.stdout).toMatch(...)` lines to `expect(r.stderr).toMatch(...)` for the stats assertions:

```ts
  it('prints stats summary to stderr', () => {
    const r = runCli([
      join(FIXTURES, 'mixed-real-shape.ct'),
      '--game-name', 'Test', '--process', 'target',
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/total:\s*4/i);
    expect(r.stderr).toMatch(/supported:\s*3/i);
    expect(r.stderr).toMatch(/unsupported:\s*1/i);
  });
```

(Also update the test name accordingly.)

- [ ] **Step 5: Build the CLI**

Run: `pnpm --filter @starlight/ct-importer build`
Expected: emits `dist/cli.js` and other dist artifacts.

- [ ] **Step 6: Run CLI tests (passes)**

Run: `pnpm --filter @starlight/ct-importer test cli`
Expected: PASS — 4 tests.

- [ ] **Step 7: Run full suite**

Run: `pnpm --filter @starlight/ct-importer test`
Expected: PASS — every test green across every file.

- [ ] **Step 8: Commit**

```bash
git add packages/ct-importer/src/cli.ts packages/ct-importer/test/cli.test.ts
git commit -m "feat(ct-importer): add CLI for ad-hoc .CT to Starlight conversion"
```

---

## Task 12: Lint, CI, Wire-Up

**Files:**
- Modify: `.github/workflows/ci.yml`

The Phase 1 CI workflow already runs `pnpm -r test` and `pnpm -r lint`, which will now pick up the new package automatically. We only need to ensure the build step exists (the CLI test depends on `dist/cli.js`) and that the lockfile is up to date.

- [ ] **Step 1: Add a build step to CI before lint+test**

Edit `.github/workflows/ci.yml` — add a new step after `Build C test target` and before `Lint`:

```yaml
      - name: Build TypeScript packages
        run: pnpm -r build
```

The full `Test` step will then have access to the built `dist/` directories.

- [ ] **Step 2: Verify locally**

Run from repo root:
- `pnpm -r build` — both packages build cleanly
- `pnpm -r lint` — clean
- `pnpm -r test` — every test green (engine: 22, ct-importer: 50+)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build TypeScript packages before lint+test"
```

---

## Self-Review

**Spec coverage check (against design spec §3.2 `.CT` Importer):**

| Spec construct | Task |
|---|---|
| Static address (`module+offset`) | Task 6 (address parser) + Task 9 (entry converter) |
| Pointer chains (`<Offsets>`) | Task 6 + Task 9 |
| AOB scan entries | Task 6 + Task 9 |
| Type info → ValueType | Task 5 (type mapper) |
| Group/folder structure → categories | Task 9 + Task 10 |
| Hotkey definitions | Task 7 (hotkey parser) |
| Simple "freeze value" entries | Task 9 (default cheat type='freeze') |
| Simple assembler hooks (best-effort translation) | Deferred — Task 8 flags all assembler scripts as unsupported in v1; Phase 3+ may revisit |
| Complex assembler with `aobscanmodule + alloc + label` flow | Task 8 (flagged unsupported) |
| Lua scripts (`{$lua}`) | Task 8 (flagged unsupported) |
| Unsupported entries preserved with `originalSource` | Task 9 |
| Top-level `importCt` with conversion stats | Task 10 |
| CLI for ad-hoc conversion | Task 11 |

**Placeholder scan:** none.

**Type consistency:** `StarlightTrainer`, `StarlightCheat`, `StarlightAddress`, `StarlightValueType` defined in Task 2 and consumed identically by every downstream module. `CtEntry` and `CtHotkey` defined in Task 4 and used by Tasks 7, 9. `ImportStats` defined in Task 10 and exposed via the barrel.

**Scope check:** This plan stays in Phase 2's lane (.CT → JSON conversion). It does NOT:
- Run any cheats (Phase 1 engine does that)
- Render any UI (Phase 3-4)
- Fetch from a catalog or scrape fearlessrevolution (Phase 5)
- Translate assembler scripts (deliberate v1 deferral)

**Coverage of v1 deferral:** Phase 2 v1 deliberately marks all `<AssemblerScript>` entries as unsupported. The design spec calls out simple assembler hooks as "best-effort translation" but the realistic scope for Phase 2 is the declarative subset (addresses + types + hotkeys). Translating CE assembler → Frida `Memory.patchCode` is itself a significant engineering effort and gets its own plan in Phase 3 if we choose to pursue it. The current implementation produces a clear "open in Cheat Engine" affordance for those entries, which matches the user-facing experience the design spec describes.
