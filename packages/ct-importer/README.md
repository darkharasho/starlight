# @starlight/ct-importer

Parses Cheat Engine `.CT` files and emits Starlight Trainer JSON.

## Programmatic use

```ts
import { importCt } from '@starlight/ct-importer';
import { readFileSync } from 'node:fs';

const xml = readFileSync('Elden Ring.CT', 'utf8');
const result = importCt(xml);
console.log(result.stats);          // { total: 32, supported: 28, unsupported: 4 }
console.log(result.trainer);        // Starlight Trainer JSON
```

## CLI

```bash
pnpm --filter @starlight/ct-importer build
node packages/ct-importer/dist/cli.js path/to/file.CT -o out.json
```

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
