# Sharing agent-made cheats — design

Project 2 of the native-engine work (see `2026-11-23-native-engine-agent-design.md`, which left sharing for "a separate brainstorm later").

## Intent

When a player's agent (Claude Code or Codex through Starlight's MCP tools) makes a working cheat, that work should help everyone who plays the game, not just the one machine that made it. A player shares a cheat in one click. The maintainer approves it. It then appears on that game's page for every Starlight user, next to the FearlessRevolution tables.

Success: a cheat made on one machine shows up on another player's game page after one approval, and it runs there through the existing verify check.

## Decided

- **Who can submit:** any Starlight player. No account needed.
- **Who approves:** the maintainer (darkharasho), personally. Nothing reaches the catalog without that approval.
- **Approach:** GitHub pull requests opened by a small relay (approach 1 below).

## Goals

- A "Share" action on the player's own cheats on the game page.
- A submission arrives as a pull request whose description lets the maintainer judge the cheat by reading it, without owning the game.
- Merging publishes it through the existing GitHub Pages build. Deleting the file unpublishes it.
- Approved community cheats appear on the game page labelled as community cheats, with the build they were made on.

## Non-goals

- Votes, comments, ratings, "worked for me" reports.
- Player accounts or profiles.
- Automatic approval of any kind.
- Editing a shared cheat after submission. A new version is a new submission.
- Sharing cheats imported from `.CT` tables. Those are their authors' work and already come from FearlessRevolution.

## Anti-goals (a failure even if it works)

- Anything personal leaving the player's machine without their seeing it first: paths, user names, Steam ids, machine ids.
- A shared cheat running without the player turning it on.
- A path for anti-cheat evasion or multiplayer cheats. The existing refusal rules apply unchanged.
- Lua or anything else that reaches beyond the game process. The Starlight cheat format has no Lua; it stays that way for shared cheats.
- A relay that lets anyone write to the repo beyond opening a pull request that adds one file in the community folder.

## Approaches considered

1. **Pull requests opened by a relay (chosen).** The app posts the cheat to a Cloudflare Worker, which opens a pull request on `darkharasho/starlight`. Players need no GitHub account. Review happens in GitHub, and merging publishes through the existing Pages build. There's very little server to look after.
2. **Pull requests without a relay.** The app opens the player's browser with a pre-filled pull request or issue. This is the least to build, but every submitter needs a GitHub account and has to finish the steps themselves, so few would.
3. **Our own server with a review page** (Worker, database, admin login). This is the most to build and secure, and it duplicates the publish step. Its main payoff, votes and reports, is a non-goal for now.

## How it works

### 1. Player side (desktop app)

- **Where Share appears:** on the game page, on cheats in the player's own library whose `provenance.kind` is `agent` or `manual`. It doesn't appear on `ct-import` cheats.
- **What it needs:** a cheat is shareable only if it carries a verify block and a non-absolute address or AOB site. That's already true of every `save_cheat` cheat. It also needs a game identity: `steamAppId`, `platform` (`linux` or `windows` under Proton, as the session saw it), `bits` (32 or 64, the game code's bitness), plus `buildId` and `exeHash` when known. *(My call: one Steam app can be native Linux on one machine and Proton on another, with different modules and code; and the relay needs the bitness to read the assembly.)*
- **The preview:** pressing Share opens it before anything is sent. It shows:
  - the plain-language summary the maintainer will see (below);
  - the exact JSON to be sent;
  - an optional "Credit as" name, blank by default, which means anonymous.

  Send and Cancel buttons follow.
- **Scrubbing:** the app removes anything that isn't needed before the preview: library ids and timestamps finer than the date. Module names are kept as plain file names. A path separator anywhere in the cheat refuses the share with a clear message.
- **After sending:** the result is shown as "Submitted for review", with a link to the pull request. The cheat stays in the player's library unchanged. The app keeps a local record of what was shared, so Share can show "already submitted".
- **Install id:** each install generates a random id once (not derived from the machine) and sends it with submissions, for rate limiting only.

### 2. Relay (Cloudflare Worker)

- **Endpoint:** `POST /submit` takes `{ cheat, game: { steamAppId, name, platform, bits, buildId?, exeHash? }, credit?, derivedFrom?, installId, appVersion }`.
- **Checks, in order:**
  1. Size limit (64 KB).
  2. Schema check with the same `@starlight/ct-importer` validation the app uses, bundled into the Worker.
  3. The share rules above: no absolute addresses, no paths, a verify block.
  4. Rate limits: 5 per install per day and 20 per IP per day.
  5. Duplicates: the same content hash (cheat + platform + bits) as an earlier submission returns that pull request's link and state instead of opening a new one — including closed, unmerged ones ("this cheat was reviewed and not accepted"). The Worker keeps its own record of hash → pull request, and reads the pull request's state from GitHub when answering. *(My call: a rejected cheat shouldn't come back the next day; a changed cheat has a new hash and can be submitted.)*
- **Opening the pull request:**
  - It creates a branch `community/<steamAppId>-<hash8>` with one new file, `packages/catalog/community/<steamAppId>/<hash12>.json`.
  - The file holds the cheat, the game identity, the credit, and the submission date.
  - The pull request is labelled `community-cheat`, and its description is the summary.
- **GitHub access:** through a GitHub App installed only on this repo, with contents and pull-requests write. Its private key is a Worker secret.
- **What it never does:** the Worker never merges, never touches any other path, and never sees the maintainer's personal token.
- **Answers:** success returns `{ url }`. Errors return a short reason the app shows as is.

### 3. The summary (pull request description)

The maintainer approves by reading, so the summary carries the judgement:

- **Game:** name, Steam app id, platform, 32/64-bit, build id and exe hash, or "unknown build".
- **Based on:** when `derivedFrom` is set, a link to the community cheat it repairs and its credit.
- **Cheat:** name and type (freeze/set/toggle/patch), plus the agent name from provenance and the credit.
- **For value cheats:** the address chain, written out (module + offset → offsets), the value type, the value held, and the verify range.
- **For patch cheats:**
  - the AOB site (module, pattern, offset);
  - every step in order, with:
    - bytes written, both original and new;
    - allocations, with their sizes;
    - the assembly source of each `assemble` step, in a code block;
    - registered symbols.
- **Flags** the maintainer should look at, worked out by the relay:
  - an assemble step with more than 50 lines;
  - a write larger than 64 bytes;
  - `near`-less allocations;
  - any instruction that calls or jumps outside the site and its own allocations (`call`/`jmp` to a module address or absolute address);
  - `int`/`syscall`/`sysenter`.

  These are prompts to read closely, not refusals.

### 4. Repo side

- **A check workflow (`community-check.yml`):** it runs on pull requests touching `packages/catalog/community/**`, without secrets (`pull_request`, not `pull_request_target`). It:
  - checks the pull request adds exactly one file under that folder;
  - checks the file against the schema and share rules;
  - recomputes the summary and fails if it differs from the description's.

  It never runs the cheat.
- **CODEOWNERS:** `packages/catalog/community/` is owned by the maintainer.
- **Publishing:** the Pages build (`publish-pages.yml`) generates `catalog/community/index.json`, which lists each game's community cheat files, and copies the folder into the deploy. `CatalogIndex` stays at `schemaVersion: 1`, so older app versions simply ignore community cheats.
- **Unpublishing:** the maintainer deletes the file on `main`, and it drops from the next publish.

### 5. Catalog side (desktop app)

- **New games:** a game in `community/index.json` with no catalog entry gets one. The Pages build adds a catalog entry for it (id from the existing slug rules, name and Steam app id from the submission, platform from its cheats), marked as community-only so the app doesn't try to fetch a FearlessRevolution table for it. It gets Steam art the same way every other game does. A game that later gets a table keeps one entry with both.
- **Fetching:** the app fetches `community/index.json` alongside `index.json`, with the same caching, and the game page's community cheats when the page opens.
- **Which ones show:** only cheats for the player's platform and bitness. For each cheat name, the newest version made on the player's build is shown; if none matches the build, the newest version is shown with "made on build N". Older versions sit behind a "Older versions" toggle. Old files are never removed automatically; the maintainer deletes them when they want. *(My call: every game update produces a new submission, so the page needs one cheat per name, not a pile.)* So `community/index.json` lists, per game, each file with its name, platform, bits, build id and date.
- **How they show:** community cheats appear in their own "Community" group on the game page, under the tables. Each shows its credit, or "Anonymous", and "made on build N".
  - On a build-id mismatch, or a failed verify, a cheat shows the existing "needs updating" state.
  - Nothing turns on by itself.
- **Engine:** a community cheat runs through the same native engine path as the player's own cheats, including the verify check and the anti-cheat refusal.
- **Removal:** a cheat that disappears from the community index disappears from the page. A player who copied it into their own library keeps their copy. A "Save to my cheats" action exists so their agent can repair it later. A saved copy records `derivedFrom` (the community file's hash) in its provenance. It can be shared again — a repair for a new build is useful — and the preview and summary say which cheat it's based on and keep the original credit alongside the new one. *(My call.)*

## Constraints

- **Privacy:** no user data goes to an outside service except what the player sees in the preview and sends. No telemetry rides along.
- **Wording:** messages are in plain language, matching the app's existing copy.
- **Deployment:** the Worker deploys to the maintainer's Cloudflare account, and the GitHub App is created on the maintainer's GitHub account. Both are outward-facing steps the maintainer confirms at the time.
- **Tests:** they never contact the real Worker or GitHub. The Worker is tested with a fake GitHub API.

## Left to the builder

- **Worker internals:** Worker storage for rate limits and duplicate hashes (KV or a Durable Object), and the exact error texts.
- **The Share preview:** its layout, following the existing dialogs.
- **Summary formatting** within the content listed above.
- **Content hash:** how the community index and the hash are computed. It must be stable across key order.
- **The game page:** how the Community group is fetched and cached.
