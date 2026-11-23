# Releasing Starlight

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds the desktop
app as a Linux AppImage and publishes it as a GitHub release.

The site and catalog aren't part of this: every push to `main` deploys them
to GitHub Pages (`publish-pages.yml`).

## Cutting a release

From an up-to-date, clean `main`:

```bash
pnpm release patch    # or minor / major / 1.2.3
```

`scripts/release.mjs` bumps `apps/desktop/package.json`, commits
`chore(release): v<version>`, tags `v<version>` and pushes both. The workflow
then:

1. checks the tag matches the app version, then builds, lints and tests everything;
2. creates a draft release for the tag;
3. builds `Starlight-<version>.AppImage` and uploads it into the draft;
4. writes the notes (GitHub's generated notes since the previous release) and
   publishes.

If a step fails, the release stays a draft and nothing is published. Fix the
problem, delete the draft and tag, then release again:

```bash
gh release delete v<version> --yes
git push --delete origin v<version> && git tag -d v<version>
```

## How users get updates

The AppImage updates itself (`apps/desktop/src/main/updater.ts`, using
electron-updater). It checks the latest published GitHub release on launch and
every 6 hours, downloads only the parts that changed, and installs the new
version when the user quits, or straight away from "Restart to update" in the
title bar or Settings. It reads `latest-linux.yml`, which electron-builder
uploads with each release. Drafts are never offered, so a release reaches users
only once the publish job has run.

Updates only work when Starlight runs from the AppImage, not in `pnpm dev` or
from `linux-unpacked`.

## Building locally

```bash
pnpm dist   # → apps/desktop/dist/Starlight-<version>.AppImage
```

It needs no extra setup: better-sqlite3 is already built for Electron (see below).

## How the package is put together

- `apps/desktop/electron-builder.yml` holds the packaging config.
- The main process bundles the `@starlight/*` workspace packages
  (`electron.vite.config.ts`). The app's `dependencies` are only the modules it
  loads at runtime. Anything the renderer uses is bundled by Vite and lives in
  `devDependencies`.
- Native modules: `pnpm install` builds better-sqlite3 for Electron
  (`apps/desktop/scripts/native-electron.mjs`, using the published Electron
  prebuild). That one build serves `pnpm dev`, packaging and the tests, because
  the desktop tests run under Electron's Node (`ELECTRON_RUN_AS_NODE`). If
  something rebuilds it for Node, run `pnpm --filter @starlight/desktop rebuild:native`.
  uiohook-napi is N-API, so it works as installed.
  electron-builder's own rebuild is off (`npmRebuild: false`), because it would
  compile uiohook-napi from source.

## starlightd

The release workflow builds the Rust daemon (`packages/starlightd`, `cargo
build --release`) and electron-builder bundles it as an extra resource; the
build fails if the AppImage doesn't contain it. CI and the release `test` job
run its cargo tests and build the debug binary the engine tests spawn. Nothing
to do by hand. Changing the daemon changes the binary, so users are asked for
the ptrace permission once more after updating (only when ptrace_scope > 0).

## Windows and macOS

Not built yet. Starlight runs Windows Cheat Engine under Proton or Wine (with
ceserver for native Linux games), so a Windows build would need its own
Cheat Engine path. When there is a
Windows path, add a `windows-latest` job with Azure Artifact Signing, as in
HML's `release.yml`. That job needs `win.azureSignOptions` in
`electron-builder.yml`, the `AZURE_*` secrets, and the step that verifies the
installer signature.
