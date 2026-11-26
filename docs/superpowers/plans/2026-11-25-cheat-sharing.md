# Cheat Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players share their own agent-made cheats in one click. Each submission becomes a GitHub pull request the maintainer approves. Approved cheats appear on every player's game page, adding the game to the catalog if it had no page.

**Architecture:** The share rules live in `@starlight/ct-importer/share`, one module the app, the relay and CI all import: the submission file format, rule checks, content hash, review flags and summary. The desktop app builds and previews a submission and posts it to a Cloudflare Worker (`apps/share-relay`). The Worker re-checks the submission, rate-limits it and opens a pull request through a GitHub App. On `main`, the Pages build turns `packages/catalog/community/**` into `catalog/community/index.json` plus catalog entries for new games. The app fetches these and runs community cheats through the existing user-cheats host.

**Tech Stack:**
- TypeScript, zod, vitest.
- Electron + React + zustand (desktop).
- Cloudflare Workers + KV with wrangler (relay).
- GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-25-cheat-sharing-design.md`

## Global Constraints

- **Nothing personal leaves the machine unseen.** No paths, user names, Steam ids or machine ids. The player sees the exact JSON before sending. No telemetry is sent.
- **Shared cheats never run without the player turning them on.** The existing anti-cheat refusal and verify check apply to them unchanged.
- **No Lua in shared cheats.** The cheat format has none; don't add it.
- **The relay can only open a pull request** that adds one file under `packages/catalog/community/`. It never merges and never writes any other path.
- **Share is only on the player's own cheats:** `provenance.kind` `agent` or `manual`, never `ct-import`.
- **Limits:**
  - 64 KB per submission;
  - 5 submissions per install per day and 20 per IP per day;
  - credit is 1–40 characters after trimming, and blank means anonymous.
- **File layout:**
  - each cheat lives at `packages/catalog/community/<steamAppId>/<hash12>.json`;
  - the branch is `community/<steamAppId>-<hash8>`;
  - pull requests get the label `community-cheat`.
- **Tests never contact the real Worker or GitHub.**
- **Copy is plain language,** matching the app's existing messages.
- **Test runs:**
  - vitest always runs with `--maxWorkers=2`;
  - the desktop app tests run via `pnpm --filter @starlight/desktop test -- --maxWorkers=2 <file>`;
  - filtered `ce-session` runs hang, so run that whole file.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Outward steps wait for an explicit yes from the maintainer:**
  - deploying the Worker;
  - creating the GitHub App;
  - setting secrets;
  - pushing.

  These steps are all in Task 9.

## Review Focus

1. **A path inside assembly comments.** Code like `// from C:\Users\mike\dump.txt` must be refused, but `//` comments without a path must still share. This is pinned in Task 1, in `share.test.ts › refuses_paths_in_assembly_but_allows_comments`.
2. **The same cheat with keys in a different order must hash the same,** or duplicate detection breaks. Pinned in Task 1, in `share.test.ts › hash_is_stable_across_key_order`.
3. **Relay sees GitHub fail midway (branch created, pull request call fails).** The player gets a clear error. A retry must not fail on "branch already exists", and the hash must not be recorded. Pinned in Task 5, in `relay.test.ts › retry_after_github_failure_reuses_branch`.
4. **A community-only game must not hit the FearlessRevolution fetch, or show "no table" as an error.** Pinned in Task 7, in `community-host.test.ts › community_only_entry_loads_no_trainer`.
5. **Unshareable cheats.** A cheat saved before this change has no `bits`. If the game isn't running, Share explains why it can't share yet instead of guessing. Pinned in Task 3, in `share-host.test.ts › old_cheat_without_bits_needs_the_game_running`.

---

### Task 1: Share core in ct-importer

**Files:**
- Create: `packages/ct-importer/src/share.ts`, `packages/ct-importer/test/share.test.ts`
- Modify:
  - `packages/ct-importer/src/starlight-format.ts`: add Provenance fields;
  - `packages/ct-importer/src/index.ts`: export share;
  - `packages/ct-importer/package.json`: add an `exports` entry `./share`, if the package uses `exports`.

**Interfaces:**
- Produces:
  - `Provenance` gains `bits?: 32 | 64` and `derivedFrom?: string` (a hash12).
  - `type SharePlatform = 'linux' | 'windows'`.
  - `sharePlatformOf(p: 'linux' | 'linux-proton' | string): SharePlatform`. `linux-proton` maps to `windows`; anything else maps to `linux`.
  - `CommunityCheatFileSchema` (zod) is
    `{ schemaVersion: 1, cheat: AgentCheatDraft, game: { steamAppId: number, name: string(1..120), platform: SharePlatform, bits: 32|64, buildId?: string, exeHash?: string }, agent?: string(..80), credit?: string(1..40), derivedFrom?: string(/^[0-9a-f]{12}$/), submittedAt: string(/^\d{4}-\d{2}-\d{2}$/) }`.
  - `type CommunityCheatFile`.
  - `checkShareRules(file: unknown): { ok: true; file: CommunityCheatFile } | { ok: false; errors: string[] }`. It:
    - parses with the schema;
    - runs `validateAgentCheat(file.cheat)`;
    - applies the path rule;
    - limits the serialized size to 65536 bytes (UTF-8).
  - `shareHash(file: CommunityCheatFile): Promise<string>`. It returns 64 hex characters: SHA-256 via `crypto.subtle`, over the canonical JSON (keys sorted recursively) of `{ cheat, platform: game.platform, bits: game.bits }`. `hash12` and `hash8` are prefixes of it.
  - `shareFlags(file: CommunityCheatFile): string[]`.
  - `shareSummary(file: CommunityCheatFile, flags: string[]): string`. It returns Markdown with no trailing whitespace.

- [ ] **Step 1: Write the failing tests** in `test/share.test.ts`. A `valueFile()` / `patchFile()` fixture builder makes valid files.
  - `accepts_a_valid_value_and_patch_file`: `checkShareRules(valueFile()).ok === true`, and likewise for `patchFile()`.
  - `refuses_absolute_addresses`: the address `{ kind: 'absolute', … }` gives `ok: false`.
  - `refuses_module_names_with_separators`: the module `"C:\\Games\\x.exe"` gives `ok: false`, and errors contains a string matching `/path/`.
  - `refuses_paths_in_assembly_but_allows_comments`:
    - the source `"nop // from C:\\Users\\mike\\a.txt"` is refused;
    - the source `"mov eax,1 // set to one"` is accepted;
    - `"/home/mike/x"` inside any string field is refused.
  - `refuses_oversize`: an assemble source padded so the file is over 65536 bytes is refused. Make it fail on size, not on the 16384-character source limit, by spreading it over several steps.
  - `credit_rules`: `credit: ''` and a 41-character credit are refused; `credit: 'Mika'` is accepted.
  - `hash_is_stable_across_key_order`: the same file built with reversed key insertion order gets an equal `shareHash`. A different `bits` gives a different hash.
  - `flags`:
    - an assemble step with 51 lines gives a flag containing `"51 lines"`;
    - a `writeBytes` of 65 bytes gives a flag containing `"65 bytes"`;
    - an alloc without `near` gives a flag containing `"near"`;
    - `call game.exe+1234` and `jmp 0x401000` each give a flag containing `"jumps or calls outside"`;
    - `jmp return` (where `return:` is a label in the source), `jmp site+5`, and `jmp newmem` (where `newmem` is an alloc name) give no such flag;
    - `syscall`, `int 0x80` and `sysenter` give a flag containing `"system call"`.
  - `summary_lists_every_step`: for `patchFile()`, the summary contains:
    - the game name, `Steam app 1234`, `Windows (Proton)`, `64-bit` and `build 555`;
    - every step's op in order;
    - writeBytes as `original → new`;
    - each assemble source inside a fenced ```` ```asm ```` block;
    - each flag under a `### Look closely` heading.

    When `derivedFrom` is set, it contains a "Based on" line with the hash12. For `valueFile()` it contains the pointer chain written as `game.exe+0x10 → 0x8 → 0x10`, the value type, the value and `range 0–9999`. Without a credit it shows `Anonymous`.
- [ ] **Step 2: Run** `pnpm --filter @starlight/ct-importer exec vitest run --maxWorkers=2 test/share.test.ts`. Expected: FAIL, because `share.js` is not found.
- [ ] **Step 3: Implement** `share.ts` and the Provenance fields.
  - **The path rule:** a module name must match `^[^/\\]+$`. Every string field, including assemble sources, is refused if it matches `/[A-Za-z]:\\|\\\\[^\\]|(^|[\s"'(=])\/(home|var|usr|tmp|mnt|run|media|opt|root|Users)\//`.
  - **The jump/call flag:**
    - take the operand of each `call|jmp|j[a-z]{1,4}` line;
    - strip a trailing `// comment`;
    - flag it if it is a hex literal or `module+…`;
    - don't flag it if it is `site`, `site±…`, a label defined in that source (`name:`), an alloc name, or a registered symbol.
  - **Bitness:** flags and the summary show `32-bit`/`64-bit` from `game.bits`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `pnpm --filter @starlight/ct-importer exec vitest run --maxWorkers=2`; expected: all pass.
- [ ] **Step 5: Commit:** `feat(ct-importer): shared-cheat file format, rules, hash, flags and summary`.

### Task 2: Record bitness when the agent saves a cheat

**Files:**
- Modify: `apps/desktop/src/main/agent/tools-library.ts` (the provenance block near line 114)
- Test: `apps/desktop/test/main/agent/tools-library.test.ts` (existing; add the cases)

**Interfaces:**
- Consumes: `Provenance.bits` (Task 1) and `Session.codeBits(): Promise<32|64|null>` from `@starlight/engine`.
- Produces: saved agent cheats carry `provenance.bits` whenever the session knows the game's bitness.

- [ ] **Step 1: Write the failing tests:**
  - `save_cheat_records_bits`: with a fake session whose `codeBits()` resolves `32`, the saved cheat's `provenance.bits === 32`.
  - With `codeBits()` resolving `null`, `bits` is absent.
- [ ] **Step 2: Run** `pnpm --filter @starlight/desktop test -- --maxWorkers=2 test/main/agent/tools-library.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Await `a.session.codeBits()` before building the provenance, and spread `bits` when it isn't null. If the fake session in the existing tests lacks `codeBits`, give it one that returns `64`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): saved agent cheats record the game's bitness`.

### Task 3: Desktop share host (main process + IPC)

**Files:**
- Create: `apps/desktop/src/main/share-host.ts`, `apps/desktop/test/main/share-host.test.ts`
- Modify:
  - `apps/desktop/src/shared/ipc.ts`: add types and channels;
  - `apps/desktop/src/preload/index.ts` (or whichever preload file defines `userCheatsList`): add the two calls;
  - `apps/desktop/src/main/index.ts`: register the handlers.

**Interfaces:**
- Consumes: Task 1 exports; `loadUserTrainer(dir, key)` from `user-cheats.ts`; `identifyGame` and `processInfo` for the live-bits fallback.
- Produces:
  - `SHARE_RELAY_URL` (exported const). It is set in Task 9; until then use `'https://starlight-share.invalid/submit'`.
  - `interface SharePreview { ok: true; json: string; summary: string; flags: string[]; already: { url: string } | null } | { ok: false; reason: string }`, in `shared/ipc.ts`.
  - `interface ShareSent { ok: true; url: string; state: 'open' | 'merged' | 'declined'; duplicate: boolean } | { ok: false; reason: string }`, in `shared/ipc.ts`.
  - `createShareHost(deps: { dir: string; userData: string; fetch?: typeof fetch; liveBits?(pid: number): Promise<32|64|null>; username?: string; now?(): Date }) => { preview(req: { key: string; id: string; pid: number | null; credit?: string }): Promise<SharePreview>; send(req: { key: string; id: string; pid: number | null; credit?: string }): Promise<ShareSent> }`.
  - IPC: `shareCheatPreview(req)` and `shareCheatSend(req)`.
  - Local state lives in `<userData>/share.json` as `{ installId: string, shared: Record<hash12, url> }`. `installId` is `crypto.randomUUID()`, created once.

- [ ] **Step 1: Write the failing tests** (temp dir, fake fetch):
  - `preview_builds_the_file`:
    - the agent cheat in a fixture trainer with `platform: ['linux-proton']` and `provenance.bits: 64` gives `ok: true`;
    - the parsed JSON has `game.platform === 'windows'` and `bits === 64`;
    - it has no `id` and no `provenance` inside `cheat`;
    - `submittedAt` is the date only;
    - `summary` equals `shareSummary(file, flags)`.
  - `ct_import_cheats_are_not_shareable`: gives `ok: false`, with a reason containing `"Cheat Engine table"`.
  - `old_cheat_without_bits_needs_the_game_running`:
    - with `pid: null`, it gives `ok: false`, with the reason `"Start the game once so Starlight can tell whether it's 32- or 64-bit."`;
    - with a pid and `liveBits` resolving `32`, it gives `ok: true` with `bits: 32`.
  - `refuses_the_username`: with `username: 'mstephens'` and a cheat whose assemble comment contains `mstephens`, it gives `ok: false`, with a reason containing `"your user name"`. The check is case-insensitive and applies only for user names of 3 or more characters.
  - `no_steam_id_not_shareable`: a trainer without `steamAppId` gives `ok: false`.
  - `send_posts_and_records`:
    - fake fetch returns `{ url, state: 'open', duplicate: false }`;
    - the POST body has `{ file, installId, appVersion }` and the URL is `SHARE_RELAY_URL`;
    - `share.json` then maps hash12 to the url;
    - a following `preview` returns `already: { url }`.
  - `send_shows_relay_errors`: a fake fetch 429 with `{ error: 'Too many submissions today.' }` gives `ok: false`, `reason: 'Too many submissions today.'`. A network failure gives `"Couldn't reach the sharing service."`.
  - `credit_is_trimmed_and_optional`: a credit of `'  Mika  '` becomes `credit: 'Mika'`, and `'   '` leaves no credit field.
- [ ] **Step 2: Run** `pnpm --filter @starlight/desktop test -- --maxWorkers=2 test/main/share-host.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `share-host.ts`, the ipc types, the preload and the handlers.
  - The game name comes from `trainer.game.name` and the Steam id from `trainer.game.steamAppId`.
  - `buildId`/`exeHash` come from the cheat's provenance.
  - The agent comes from `provenance.agent`, and `derivedFrom` from `provenance.derivedFrom`.
  - `liveBits` in `index.ts` uses `processInfo(client, pid)`'s code bits.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): build, preview and send shared cheats`.

### Task 4: Share button and preview dialog

**Files:**
- Create: `apps/desktop/src/renderer/components/ce/ShareDialog.tsx`, `apps/desktop/src/renderer/stores/share-store.ts`, `apps/desktop/test/components/ShareDialog.test.tsx`
- Modify: `apps/desktop/src/renderer/components/ce/MyCheatsSection.tsx`, adding a Share icon button (lucide `Share2`) per row whose `cheat.provenance?.kind` is `agent` or `manual`.

**Interfaces:**
- Consumes: `window.starlight.shareCheatPreview` and `window.starlight.shareCheatSend` (Task 3). Use the same bridge name the other renderer stores use.
- Produces: `useShareStore` with `{ open(key, id, pid), close(), setCredit(s), send() }` and state `{ target, preview, credit, sending, result }`.

- [ ] **Step 1: Write the failing tests:**
  - `share_button_only_on_own_cheats`: an agent cheat row has a button named "Share"; a ct-import row has none.
  - `dialog_shows_summary_and_exact_json`: after open, the dialog shows the summary text and a `<pre>` whose text equals `preview.json`, with buttons named "Send" and "Cancel".
  - `send_shows_link`: after Send resolves `{ ok: true, url, state: 'open' }`, it shows "Submitted for review" and a link with href `url`.
  - When `already` is set, it shows "Already submitted" and the link, with no Send button.
  - When `state` is `'declined'`, it shows "This cheat was reviewed and not accepted."
  - `preview_refusal_shown`: a preview `{ ok: false, reason }` shows the reason and no Send button.
  - `credit_reaches_send`: typing "Mika" in the "Credit as" box makes the `shareCheatSend` call carry `credit: 'Mika'`.
- [ ] **Step 2: Run** `pnpm --filter @starlight/desktop test -- --maxWorkers=2 test/components/ShareDialog.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the dialog in the style of the existing dialogs (`role="dialog"`, panel classes as in `MyCheatsSection`). Changing the credit re-requests the preview, so the JSON shown is what gets sent.
- [ ] **Step 4: Run** the same command plus `test/components/MyCheatsSection.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): Share button and preview on the player's own cheats`.

### Task 5: Share relay Worker

**Files:**
- Create in `apps/share-relay/`:
  - `package.json` (name `@starlight/share-relay`; deps `@starlight/ct-importer: workspace:*`; devDeps `wrangler`, `vitest`, `@cloudflare/workers-types`, `typescript`; scripts `test`, `build: tsc --noEmit`, `deploy: wrangler deploy`);
  - `wrangler.toml` (name `starlight-share`, `main = "src/index.ts"`, a KV binding `SHARE_KV`, vars `GITHUB_OWNER = "darkharasho"`, `GITHUB_REPO = "starlight"`, `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and `compatibility_flags = ["nodejs_compat"]`);
  - `tsconfig.json`;
  - `src/index.ts`, `src/github.ts`;
  - `test/relay.test.ts`.

**Interfaces:**
- Consumes: `checkShareRules`, `shareHash`, `shareFlags` and `shareSummary` (Task 1).
- Produces:
  - `POST /submit` with body `{ file, installId, appVersion }`. On success it answers `200 { url, state: 'open'|'merged'|'declined', duplicate: boolean }`. Errors are `400|413|429|502 { error: string }`.
  - `handle(req: Request, env: Env, deps?: { fetch?: typeof fetch; now?(): Date }): Promise<Response>`, exported for tests.
  - `Env = { SHARE_KV: KVNamespace; GITHUB_APP_ID: string; GITHUB_INSTALLATION_ID: string; GITHUB_APP_KEY: string (PKCS#8 PEM secret); GITHUB_OWNER: string; GITHUB_REPO: string }`.
  - The pull request body is `<!-- starlight-summary -->\n` + `shareSummary(...)` + `\n<!-- /starlight-summary -->`.
  - The pull request title is `Community cheat: <game.name> — <cheat.name>`.

- [ ] **Step 1: Write the failing tests.** Use a Map-backed fake KV and a fake GitHub that records calls to:
  - `POST /app/installations/:id/access_tokens`;
  - `GET /repos/o/r/git/ref/heads/main`;
  - `POST /repos/o/r/git/refs`;
  - `PUT /repos/o/r/contents/:path`;
  - `POST /repos/o/r/pulls`;
  - `POST /repos/o/r/issues/:n/labels`;
  - `GET /repos/o/r/pulls/:n`.

  The test key is generated per run with `crypto.subtle.generateKey` (RSASSA-PKCS1-v1_5) and exported as PEM.

  The tests:
  - `opens_a_pull_request`:
    - a valid file gives 200 with `{ url, state: 'open', duplicate: false }`;
    - the contents PUT path is `packages/catalog/community/1234/<hash12>.json`;
    - the branch is `community/1234-<hash8>`;
    - the body contains the summary between the markers;
    - the label is `community-cheat`.
  - `rejects_invalid`: an absolute address gives 400, and the error lists the rule.
  - `rejects_oversize_body`: a request body over 65536 bytes gives 413, and no GitHub calls are made.
  - `rate_limits`: the 6th submission from one installId on one day gives 429 `"Too many submissions today."`; a different installId still works. The 21st from one `CF-Connecting-IP` gives 429.
  - `duplicate_returns_existing`:
    - submitting the same file twice gives `duplicate: true` and the same url the second time, with no second pull request;
    - after the fake marks that pull request closed and unmerged, the answer is `state: 'declined'`;
    - after it marks it merged, the answer is `state: 'merged'`.
  - `retry_after_github_failure_reuses_branch`: the first try's `POST /pulls` returns 500, giving 502 `"GitHub didn't accept the submission. Try again later."`, and the hash is not stored. On the second try, `POST /git/refs` returns 422 ("Reference already exists"); the relay carries on and opens the pull request.
  - `only_writes_community_path`: across all tests, every contents PUT path starts with `packages/catalog/community/`.
  - Any non-POST or other path gives 404.
- [ ] **Step 2: Run** `pnpm install` (to add the new workspace package), then `pnpm --filter @starlight/share-relay exec vitest run --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The GitHub App JWT is RS256 via `crypto.subtle`, signed with `iat = now-60` and `exp = now+540`.
  - It's exchanged for an installation token per request.
  - KV keys:
    - `rl:i:<installId>:<YYYY-MM-DD>` and `rl:ip:<ip>:<YYYY-MM-DD>`, each with `expirationTtl` 172800;
    - `h:<hash>` → pull request number, stored only after the pull request is created.
  - Check order: size, then parse, then rules, then duplicate, then rate limit (a duplicate doesn't count), then GitHub.
  - The file is written with `JSON.stringify(file, null, 2) + '\n'`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `pnpm --filter @starlight/share-relay build`; expected: no type errors.
- [ ] **Step 5: Commit:** `feat(share-relay): Worker that turns shared cheats into pull requests`.

### Task 6: Repo side — check, publish, catalog entries

**Files:**
- Create:
  - `packages/catalog/src/community.ts`;
  - `packages/catalog/test/community.test.ts` (add `vitest` to catalog devDeps and `"test": "vitest run"`);
  - `scripts/build-community.mjs`;
  - `scripts/check-community-pr.mjs`;
  - `.github/workflows/community-check.yml`;
  - `.github/CODEOWNERS` (`/packages/catalog/community/ @darkharasho`);
  - `packages/catalog/community/.gitkeep`.
- Modify:
  - `packages/catalog/src/schema.ts`: `CatalogIndexEntrySchema` gains `communityOnly: z.boolean().optional()`;
  - `.github/workflows/publish-pages.yml`: build the indexer, run `build-community.mjs` after composing `_deploy`.

**Interfaces:**
- Consumes: Task 1 exports; `allocateId(name, taken)` from `@starlight/indexer` (`packages/indexer/src/slug.ts`).
- Produces:
  - `CommunityIndexSchema`:
    `{ schemaVersion: 1, generatedAt: string, games: Array<{ steamAppId: number, name: string, cheats: Array<{ file: string /* "<appId>/<hash12>.json" */, hash: string /* hash12 */, name: string, platform: SharePlatform, bits: 32|64, buildId?: string, submittedAt: string, credit?: string }> }> }`.
  - `buildCommunity(files: Array<{ path: string; text: string }>, catalog: CatalogIndex, now: Date): Promise<{ index: CommunityIndex; catalog: CatalogIndex; errors: string[] }>`. It:
    - checks each file with `checkShareRules`;
    - checks the file name equals `shareHash(file).slice(0,12)` and the folder equals `game.steamAppId`;
    - skips bad files, recording errors;
    - adds a catalog entry for each steamAppId with no existing entry. The entry has `id: allocateId(name, taken)`, `steamAppId`, `name`, `processName: []`, `platform` (`['windows']` if any cheat is windows, plus `'linux'` if any is linux) and `communityOnly: true`.
  - `checkCommunityPr(added: Array<{ status: string; path: string }>, files: Map<string,string>, prBody: string): Promise<string[]>`. It returns the problems; an empty list means OK. The rules:
    - exactly one change, status `A`, under `packages/catalog/community/`;
    - the file passes `buildCommunity`'s per-file checks;
    - the text between the summary markers equals `shareSummary(file, shareFlags(file))`.

- [ ] **Step 1: Write the failing tests:**
  - `builds_index_and_adds_new_games`:
    - two valid files for app 1234 (no catalog entry) and one for app 99 (with an existing entry) give `index.games` of length 2;
    - the catalog gains exactly one entry, with `communityOnly: true`, `steamAppId: 1234` and an id from `allocateId`;
    - app 99's entry is unchanged.
  - `skips_bad_files`: a wrong file name hash, a folder that doesn't match the steamAppId, or a rule failure each give an error that names the path, and the file is left out.
  - `pr_check_rules`:
    - two added files is a problem;
    - a modified (`M`) file is a problem;
    - a path outside `community/` is a problem;
    - a summary that doesn't match is a problem;
    - a good pull request gives `[]`.
- [ ] **Step 2: Run** `pnpm install && pnpm --filter @starlight/catalog exec vitest run --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement** `community.ts` and the two scripts.
  - The scripts are thin wrappers that import `packages/catalog/dist/community.js`:
    - `build-community.mjs <catalogDir> <deployCatalogDir>` reads `community/**/*.json` and writes `<deploy>/community/index.json`, the files and the merged `<deploy>/index.json`. It prints errors but doesn't fail the deploy.
    - `check-community-pr.mjs` gets the changes from `git diff --name-status origin/${GITHUB_BASE_REF}...HEAD`, takes the body from `$GITHUB_EVENT_PATH`, and exits 1 with the problems.
  - The workflow uses `on: pull_request` with `paths: ['packages/catalog/community/**']`, `permissions: contents: read`, `fetch-depth: 0`, and no secrets.
  - `publish-pages.yml`: add `pnpm --filter @starlight/indexer build`, then after composing run `node scripts/build-community.mjs packages/catalog _deploy/catalog`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `node scripts/build-community.mjs packages/catalog /tmp/sl-deploy` against the empty folder; expected: it writes an index with `games: []` and exits 0.
- [ ] **Step 5: Commit:** `feat(catalog): community cheats folder, PR check and publish step`.

### Task 7: App reads community cheats

**Files:**
- Create: `apps/desktop/src/main/community-host.ts`, `apps/desktop/test/main/community-host.test.ts`
- Modify:
  - `apps/desktop/src/main/user-cheats-host.ts`: add a `loadTrainer` dep and refuse remove for community keys;
  - `apps/desktop/src/main/game-matcher.ts:107`: also index `communityOnly` entries;
  - `apps/desktop/src/main/index.ts`: wire the loader, plus IPC `communityCheatsSave`;
  - `apps/desktop/src/main/user-cheats.ts`: no change, since `saveUserCheat` is reused;
  - `apps/desktop/src/shared/ipc.ts`: `UserCheatView` gains `community?: { credit: string | null; buildId: string | null; platform: SharePlatform; bits: 32|64; older: boolean }`.

**Interfaces:**
- Consumes: `CommunityIndex` and `CommunityCheatFile` (Tasks 1 and 6), `PROD_CATALOG_BASE` and the fetch/caching pattern of `catalog-host.ts`.
- Produces:
  - `communityKey(steamAppId: number): string`, which returns `community-<id>`. `isCommunityKey(key)`.
  - `pickCommunityCheats(cheats: CommunityIndex['games'][number]['cheats'], ctx: { platform: SharePlatform | null; bits: 32|64|null; buildId: string | null }): { current: typeof cheats; older: typeof cheats }`. It:
    - drops other platforms or bits when they are known in ctx;
    - groups by `name + platform + bits`;
    - picks as current the newest with `buildId === ctx.buildId`, else the newest by `submittedAt`;
    - puts the rest in older, newest first.
  - `createCommunityHost(deps: { cacheDir: string; baseUrl?: string; fetch?: typeof fetch }) => { index(): Promise<CommunityIndex>; trainer(steamAppId: number, ctx): Promise<{ trainer: StarlightTrainer; meta: Map<string /* cheat id */, NonNullable<UserCheatView['community']>> } | null> }`.
    - Cheat ids are `c-<hash12>`.
    - There is one category, `Community`.
    - Each cheat gets `provenance: { kind: 'manual', createdAt: submittedAt + 'T00:00:00.000Z', game: { steamAppId, buildId?, exeHash? }, bits, derivedFrom: hash12 }`.
  - `createUserCheatsHost` gets a dep `loadTrainer?(key: string, pid: number | null): Promise<StarlightTrainer | null>`, defaulting to `loadUserTrainer(dir, key)`. `list` puts `community` meta on views when the key is a community key, via an optional dep `communityMeta?(key, pid)`. `remove(communityKey, …)` returns `{ ok: false, error: "Community cheats can't be deleted here." }`.
  - IPC `communityCheatsSave({ key, id, game: UserCheatGame }) → IpcResult` copies the cheat into the player's library via `saveUserCheat`. The copy has `provenance.kind 'manual'` and `derivedFrom` set to the hash12.

- [ ] **Step 1: Write the failing tests:**
  - `pick_prefers_matching_build_then_newest`:
    - with versions on builds 100 (2026-01-01), 200 (2026-02-01) and 300 (2026-03-01), ctx `buildId: '200'` gives current = build 200 and older = [300, 100];
    - ctx `buildId: '999'` gives current = 300.
  - `pick_filters_platform_and_bits`: a windows/64 ctx drops linux and 32-bit versions. A `null` ctx keeps all of them, grouped separately per platform and bits.
  - `community_only_entry_loads_no_trainer`: for a catalog entry with `communityOnly: true` and no `trainerSource`, the trainer lookup used by `catalogTrainerFor` in `index.ts` (extract it to `trainerForEntry(entry)` in `catalog-host.ts`) returns `null` without calling fetch.
  - `matcher_indexes_community_only`: `identifyProcess` matches a process named like a `communityOnly` entry.
  - `host_lists_and_refuses_remove`: a user-cheats host with a community `loadTrainer` lists the `c-<hash>` cheats with `community.credit`, and `remove` gives the refusal message.
  - `index_is_cached_offline`: the first fetch is served; with the second fetch rejecting, `index()` still returns the cached copy.
  - `save_to_my_cheats_marks_derived`: after `communityCheatsSave`, the user trainer has the cheat with `provenance.derivedFrom === hash12`.
- [ ] **Step 2: Run** `pnpm --filter @starlight/desktop test -- --maxWorkers=2 test/main/community-host.test.ts test/main/user-cheats-host.test.ts test/main/game-matcher.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Context in `index.ts`:** when a pid is attached, `ctx` comes from `identifyGame(pid)`: proton gives windows, plus `buildId`, and `processInfo` gives the bits. Without a pid, all fields are `null`.
  - **When the index refreshes:** it is fetched when the app starts and when a game page opens, with a 10-minute minimum between fetches.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): load community cheats; community-only games get a page`.

### Task 8: Community group on the game page

**Files:**
- Create: `apps/desktop/src/renderer/components/ce/CommunitySection.tsx`, `apps/desktop/test/components/CommunitySection.test.tsx`
- Modify:
  - `apps/desktop/src/renderer/components/ce/CeSessionView.tsx`: render `CommunitySection` after the table list, keyed by `communityKey(steamAppId)` when the entry has a steamAppId. For `communityOnly` entries, the no-table line reads "Community cheats only — no Cheat Engine table for this game".
  - `apps/desktop/src/renderer/stores/user-cheats-store.ts`: if it holds one key, generalize it to hold items per key, so My cheats and Community can coexist.

**Interfaces:**
- Consumes: the `userCheatsList`/`userCheatsSetActive`/`userCheatsSetValue` IPCs with a community key, the `UserCheatView.community` meta, and the `communityCheatsSave` IPC (Task 7).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests:**
  - `shows_current_with_credit_and_build`: a heading "Community"; the row shows the cheat name, "by Mika" ("by Anonymous" when there's no credit) and "made on build 555".
  - `older_versions_toggle`: older rows are hidden until "Older versions" is pressed, then shown.
  - `nothing_turns_on_by_itself`: rendering never calls `userCheatsSetActive`; only clicking the toggle does.
  - `needs_update_state`: a view with `verify.status: 'needs-update'` shows the existing "needs updating" text.
  - `save_to_my_cheats`: clicking "Save to my cheats" calls `communityCheatsSave` with the key and id.
  - `hidden_when_empty`: zero items render nothing.
- [ ] **Step 2: Run** `pnpm --filter @starlight/desktop test -- --maxWorkers=2 test/components/CommunitySection.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, reusing `MyCheatsSection`'s row rendering. Extract a shared `CheatRow` if that keeps both small.
- [ ] **Step 4: Run** the same command plus `test/components/CeSessionView.test.tsx` (the whole file) and the user-cheats store tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): Community group on the game page`.

### Task 9: End-to-end check, then deploy (stops for the maintainer)

**Files:**
- Create: `scripts/share-e2e.mjs`
- Modify: `apps/desktop/src/main/share-host.ts` (`SHARE_RELAY_URL`, after deploy)

- [ ] **Step 1: Write and run a local end-to-end test.** `scripts/share-e2e.mjs` does the following:
  1. Starts `wrangler dev --local` for `apps/share-relay`, pointed at a local fake GitHub HTTP server that the script runs and that writes received files into a temp clone of `packages/catalog`.
  2. Posts a submission built by `createShareHost` from a fixture trainer.
  3. Runs `build-community.mjs` on the temp clone.
  4. Loads the result through `createCommunityHost` with `baseUrl` set to the temp deploy directory, served over a local HTTP server.

  Run: `node scripts/share-e2e.mjs`. Expected: prints `share-e2e: ok` (the cheat came back with the same hash12), and leaves no process running.
- [ ] **Step 2: Run the full suites:**
  - `pnpm --filter @starlight/ct-importer exec vitest run --maxWorkers=2`
  - `pnpm --filter @starlight/catalog exec vitest run --maxWorkers=2`
  - `pnpm --filter @starlight/share-relay exec vitest run --maxWorkers=2`
  - `pnpm --filter @starlight/desktop test -- --maxWorkers=2`

  Expected: all pass. The known `library-host.lutris.test.ts` better-sqlite3 failure is environmental.
- [ ] **Step 3: STOP and ask the maintainer** before each of these:
  - **The GitHub App:** create it on darkharasho with permissions Contents R/W and Pull requests R/W and no webhook, install it on `darkharasho/starlight` only, and note the app id and installation id.
  - **The label:** create the `community-cheat` label.
  - **The Worker secret:** `wrangler secret put GITHUB_APP_KEY` (the App's private key converted to PKCS#8).
  - **The KV namespace:** create it and fill in its id in `wrangler.toml`.
  - **Deploy:** `pnpm --filter @starlight/share-relay deploy`.
  - **The relay URL:** set `SHARE_RELAY_URL` to the deployed `…/submit` URL and commit.
  - **Push and release.**
- [ ] **Step 4: Commit:** `chore(share): point the app at the deployed relay`.
