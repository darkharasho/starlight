# Test fixtures

`synthetic/` contains hand-authored `.CT` files exercising every conversion path. These are committed and used by integration tests.

To test against real community tables, drop them in `real/` (gitignored). Run:

```bash
pnpm --filter @starlight/ct-importer build
for f in test/fixtures/real/*.CT; do
  node dist/cli.js "$f" -o "/tmp/$(basename "$f" .CT).json"
done
```

We do not commit real .CT files because:
- Licensing is unclear for community-uploaded tables.
- Parsing must work on arbitrary input we have not seen.
