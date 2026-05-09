# Phase 3 — Desktop Shell & Neon Arcade UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clickable Electron desktop app (`apps/desktop`) with the full five-route Neon Arcade UI, populated by hard-coded mock data, with no engine wiring. The output is a polished demo that proves the UX before Phase 4 connects it to the real `@starlight/engine` and `@starlight/ct-importer` packages.

**Architecture:** New workspace package `apps/desktop/` using `electron-vite` (which handles main, preload, and renderer with one tooling layer). React 18 + TypeScript renderer with `react-router-dom`. Tailwind CSS with custom Neon Arcade theme tokens. Zustand for latch state. Vitest + `@testing-library/react` for component tests.

**Tech Stack:** Electron 32, electron-vite, React 18, TypeScript 5, Tailwind 3, react-router-dom 6, Zustand 4, Vitest, @testing-library/react, jsdom.

**Deliberately deferred to Phase 4:** Real process detection, Frida attach, real catalog fetch, real `.CT` import. Latch button just flips an in-memory state machine. Active Trainer consumes a hand-crafted Starlight Trainer JSON fixture.

---

## File Structure

```
apps/desktop/
├── package.json
├── tsconfig.json              (extends base; covers main + preload + renderer)
├── tsconfig.node.json         (for electron-vite config)
├── electron.vite.config.ts
├── vitest.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── index.html                 (renderer entry)
├── README.md
├── src/
│   ├── main/
│   │   └── index.ts           (Electron BrowserWindow setup, dev/prod URLs)
│   ├── preload/
│   │   └── index.ts           (exposes nothing yet — placeholder for Phase 4 IPC)
│   └── renderer/
│       ├── main.tsx           (React root, BrowserRouter)
│       ├── App.tsx            (routes + global shell)
│       ├── index.css          (Tailwind directives + global Neon Arcade base)
│       │
│       ├── components/
│       │   ├── Sidebar.tsx
│       │   ├── TopBar.tsx
│       │   ├── LatchPill.tsx
│       │   ├── GameTile.tsx
│       │   ├── BoxartGrid.tsx
│       │   ├── PageHeader.tsx
│       │   └── cheat-cards/
│       │       ├── ToggleCheatCard.tsx
│       │       ├── ValueCheatCard.tsx
│       │       └── UnsupportedCheatCard.tsx
│       │
│       ├── routes/
│       │   ├── HomeRoute.tsx
│       │   ├── LibraryRoute.tsx
│       │   ├── BrowseRoute.tsx
│       │   ├── SearchRoute.tsx
│       │   └── ActiveTrainerRoute.tsx
│       │
│       ├── stores/
│       │   └── latch-store.ts (Zustand: idle | waiting | detected | latched)
│       │
│       └── data/
│           ├── catalog.ts      (mock catalog: array of {steamAppId, name, processName, coverUrl, hasTrainer, installed})
│           └── elden-ring-trainer.ts  (mock StarlightTrainer JSON object)
│
└── test/
    ├── setup.ts               (jsdom + Tailwind no-op stubs)
    ├── components/
    │   ├── LatchPill.test.tsx
    │   ├── GameTile.test.tsx
    │   └── cheat-cards.test.tsx
    └── routes/
        └── ActiveTrainerRoute.test.tsx
```

**Boundaries:**
- `main/` is Electron-only Node; cannot import from renderer.
- `preload/` is the bridge; in Phase 3 it exports nothing — just exists.
- `renderer/components/` are pure presentational pieces. They take props and call callbacks; they don't read from stores directly (except `Sidebar` and `TopBar` which need latch state).
- `renderer/routes/` compose components and read from stores or mock data.
- `renderer/stores/` — Zustand stores. v3 has only `latch-store`.
- `renderer/data/` — hard-coded mock fixtures. Replaced by IPC results in Phase 4.

---

## Important Note on Trainer Fixture Type

`apps/desktop` does NOT currently have `@starlight/ct-importer` as a runtime dependency, since renderer code shouldn't import zod just to consume types. The simplest approach in Phase 3 is to **inline a trimmed type definition** in `src/renderer/data/elden-ring-trainer.ts` that matches the shape produced by the importer. Phase 4 will replace this with importing the type from `@starlight/ct-importer` once IPC plumbing is in place. The plan flags this explicitly so future-you doesn't get confused why we're duplicating the shape.

---

## Task 1: Scaffold the Electron app

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsconfig.node.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/main.tsx`
- Create: `apps/desktop/src/renderer/App.tsx`
- Create: `apps/desktop/README.md`
- Modify: `pnpm-workspace.yaml` (already includes `apps/*` from Phase 1 — verify)
- Modify: `.gitignore` (add `apps/*/out`, `apps/*/dist`)

- [ ] **Step 1: Create package.json**

Create `apps/desktop/package.json`:

```json
{
  "name": "@starlight/desktop",
  "version": "0.0.0",
  "private": true,
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/node": "^20.12.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.20",
    "electron": "^32.0.0",
    "electron-vite": "^2.3.0",
    "jsdom": "^24.1.0",
    "postcss": "^8.4.40",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler",
    "types": ["node", "vite/client"],
    "noEmit": true,
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["test", "out", "dist"]
}
```

- [ ] **Step 3: Create tsconfig.node.json (for electron-vite config file)**

Create `apps/desktop/tsconfig.node.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["electron.vite.config.ts", "vitest.config.ts", "tailwind.config.ts", "postcss.config.js"]
}
```

- [ ] **Step 4: Create electron.vite.config.ts**

Create `apps/desktop/electron.vite.config.ts`:

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: { outDir: 'out/main', lib: { entry: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    build: { outDir: 'out/preload', lib: { entry: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
    plugins: [react()],
  },
});
```

- [ ] **Step 5: Create index.html**

Create `apps/desktop/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'" />
    <title>Starlight</title>
  </head>
  <body class="bg-bg text-ink antialiased">
    <div id="root"></div>
    <script type="module" src="/src/renderer/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create main process**

Create `apps/desktop/src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#07070b',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 7: Create preload (placeholder)**

Create `apps/desktop/src/preload/index.ts`:

```ts
// Phase 4 will expose IPC bridges here via contextBridge.exposeInMainWorld.
// In Phase 3, the preload is intentionally empty — the renderer uses
// hard-coded mock data only.
export {};
```

- [ ] **Step 8: Create renderer entry + App stub**

Create `apps/desktop/src/renderer/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.js';
import './index.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
```

`HashRouter` (not `BrowserRouter`) — Electron loads files via `file://` URLs in production, where path-based routing breaks.

Create `apps/desktop/src/renderer/App.tsx`:

```tsx
export default function App(): JSX.Element {
  return (
    <div className="flex h-screen items-center justify-center text-neon-cyan">
      <h1 className="text-2xl font-bold tracking-widest">★ STARLIGHT</h1>
    </div>
  );
}
```

(Real shell comes in Task 3. This is just a render-smoke placeholder.)

Create `apps/desktop/src/renderer/index.css` (placeholder — Tailwind directives go in Task 2):

```css
/* Tailwind directives are added in Task 2. */
body { margin: 0; }
```

- [ ] **Step 9: README**

Create `apps/desktop/README.md`:

```md
# @starlight/desktop

Electron desktop app for Starlight. Phase 3: clickable UI shell with hard-coded data. Phase 4 will wire the engine and importer.

## Develop

\`\`\`bash
pnpm --filter @starlight/desktop dev
\`\`\`

Opens the dev window with HMR.

## Build

\`\`\`bash
pnpm --filter @starlight/desktop build
\`\`\`

Produces `out/{main,preload,renderer}/`.

## Test

\`\`\`bash
pnpm --filter @starlight/desktop test
\`\`\`

Component tests run in jsdom via Vitest. No Electron is started.
```

- [ ] **Step 10: Update root .gitignore**

Append to root `.gitignore`:

```
# desktop app build output
apps/*/out
apps/*/dist
```

- [ ] **Step 11: Install dependencies**

Run from repo root: `pnpm install`
Expected: dependencies resolve. Electron downloads its prebuilt binary (~80MB; takes a minute on first install).

- [ ] **Step 12: Smoke check the dev workflow**

Run: `pnpm --filter @starlight/desktop dev`

Expected behavior: a window opens showing the centered "★ STARLIGHT" header. Close it.

If Electron complains about missing GTK/X server libs (rare), surface in your report and stop.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/ pnpm-lock.yaml .gitignore
git commit -m "chore(desktop): scaffold Electron + Vite + React app shell"
```

---

## Task 2: Tailwind + Neon Arcade theme

**Files:**
- Create: `apps/desktop/tailwind.config.ts`
- Create: `apps/desktop/postcss.config.js`
- Modify: `apps/desktop/src/renderer/index.css`

- [ ] **Step 1: PostCSS config**

Create `apps/desktop/postcss.config.js`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 2: Tailwind config**

Create `apps/desktop/tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:        '#07070b',
        panel:     '#0d0d18',
        line:      '#1a1a2e',
        ink:       '#e6e6f0',
        muted:     '#7a7a92',
        'neon-cyan':  '#00ffc8',
        'neon-pink':  '#ff00b4',
        'neon-green': '#00ff7a',
        'neon-amber': '#ffb86b',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'monospace'],
      },
      letterSpacing: {
        widest: '0.18em',
        wider:  '0.16em',
      },
      backgroundImage: {
        'neon-grid':
          'linear-gradient(rgba(255,0,180,0.05) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgba(0,255,200,0.05) 1px, transparent 1px)',
      },
      backgroundSize: {
        'grid-26': '26px 26px',
      },
      keyframes: {
        pulse: { '50%': { opacity: '0.35' } },
      },
      animation: {
        'pulse-slow': 'pulse 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
```

- [ ] **Step 3: Replace index.css with Tailwind directives + base**

Replace `apps/desktop/src/renderer/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root {
  height: 100%;
}

body {
  background-color: theme('colors.bg');
  background-image: theme('backgroundImage.neon-grid');
  background-size: theme('backgroundSize.grid-26');
  color: theme('colors.ink');
  font-family: theme('fontFamily.sans');
  margin: 0;
}

/* Neon utility — used on active/glowing elements */
@layer utilities {
  .glow-cyan  { box-shadow: 0 0 12px rgba(0,255,200,0.30); }
  .glow-pink  { box-shadow: 0 0 12px rgba(255,0,180,0.30); }
  .glow-green { box-shadow: 0 0 12px rgba(0,255,122,0.30); }
}
```

- [ ] **Step 4: Verify Tailwind applies**

Run: `pnpm --filter @starlight/desktop dev`

Expected: the window now shows a dark background with the subtle neon grid pattern; the "★ STARLIGHT" text is in cyan with the right tracking.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tailwind.config.ts apps/desktop/postcss.config.js apps/desktop/src/renderer/index.css
git commit -m "feat(desktop): wire Tailwind with Neon Arcade theme tokens"
```

---

## Task 3: App shell — Sidebar + TopBar + Routing skeleton

**Files:**
- Create: `apps/desktop/src/renderer/components/Sidebar.tsx`
- Create: `apps/desktop/src/renderer/components/TopBar.tsx`
- Create: `apps/desktop/src/renderer/components/LatchPill.tsx`
- Create: `apps/desktop/src/renderer/components/PageHeader.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`

The shell is fixed: 220px sidebar on the left, 52px top bar at top, content area fills the rest. Five routes wired in `App.tsx` but their components are empty placeholders for now (filled in Tasks 7–11).

- [ ] **Step 1: Sidebar**

Create `apps/desktop/src/renderer/components/Sidebar.tsx`:

```tsx
import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/',          label: 'Home' },
  { to: '/library',   label: 'Library' },
  { to: '/browse',    label: 'Browse' },
  { to: '/search',    label: 'Search' },
  { to: '/active',    label: 'Active Trainer' },
];

export function Sidebar(): JSX.Element {
  return (
    <aside className="w-[220px] shrink-0 border-r border-line bg-panel px-2.5 py-4 flex flex-col gap-1">
      <div className="px-3 pb-4 pt-1 font-bold text-sm text-neon-cyan tracking-widest"
           style={{ textShadow: '0 0 8px rgba(0,255,200,0.5)' }}>
        ★ STARLIGHT
      </div>
      <nav className="flex flex-col gap-0.5 flex-1">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              [
                'flex items-center gap-2.5 rounded px-3 py-2.5 text-[13px] border',
                isActive
                  ? 'bg-neon-cyan/[0.06] border-neon-cyan text-neon-cyan glow-cyan'
                  : 'border-transparent text-ink hover:bg-line/40',
              ].join(' ')
            }
          >
            <span className="block size-1.5 rounded-full bg-[#3a3a55]" />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="px-2 pt-2 text-[11px] text-muted border-t border-line">
        v0.1 · phase 3 · mock data
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: LatchPill**

Create `apps/desktop/src/renderer/components/LatchPill.tsx`:

```tsx
type LatchState = 'idle' | 'waiting' | 'detected' | 'latched';

interface Props { state: LatchState }

const LABELS: Record<LatchState, string> = {
  idle:      'Idle',
  waiting:   'Waiting for game',
  detected:  'Game detected — click to Latch',
  latched:   'LATCHED',
};

export function LatchPill({ state }: Props): JSX.Element {
  const styles =
    state === 'latched'
      ? 'border-neon-green text-neon-green bg-neon-green/[0.08] glow-green'
      : state === 'detected'
      ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/[0.08] glow-cyan'
      : 'border-neon-pink text-neon-pink bg-neon-pink/[0.08] glow-pink';

  return (
    <div className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs border ${styles}`} role="status">
      <span className={`block size-2 rounded-full ${state === 'latched' ? 'bg-neon-green' : state === 'detected' ? 'bg-neon-cyan' : 'bg-neon-pink animate-pulse-slow'}`} />
      <span>{LABELS[state]}</span>
    </div>
  );
}

export type { LatchState };
```

- [ ] **Step 3: TopBar**

Create `apps/desktop/src/renderer/components/TopBar.tsx`:

```tsx
import { LatchPill, type LatchState } from './LatchPill.js';

interface Props {
  latchState: LatchState;
}

export function TopBar({ latchState }: Props): JSX.Element {
  return (
    <header className="h-[52px] shrink-0 border-b border-line bg-panel/60 backdrop-blur flex items-center px-4 gap-3">
      <input
        type="text"
        placeholder="⌕  Search games or trainers…"
        className="flex-1 max-w-[420px] h-[30px] rounded bg-panel border border-line px-2.5 text-xs text-muted placeholder:text-muted/80 focus:outline-none focus:border-neon-cyan"
      />
      <div className="ml-auto">
        <LatchPill state={latchState} />
      </div>
    </header>
  );
}
```

- [ ] **Step 4: PageHeader**

Create `apps/desktop/src/renderer/components/PageHeader.tsx`:

```tsx
interface Props {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}

export function PageHeader({ title, subtitle, right }: Props): JSX.Element {
  return (
    <div className="flex items-baseline justify-between mb-4">
      <div>
        <h2 className="text-base font-semibold m-0">{title}</h2>
        {subtitle && <p className="text-xs text-muted m-0 mt-0.5">{subtitle}</p>}
      </div>
      {right && <div>{right}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Wire routes in App**

Replace `apps/desktop/src/renderer/App.tsx`:

```tsx
import { Routes, Route } from 'react-router-dom';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { useLatchState } from './stores/latch-store.js';

import { HomeRoute } from './routes/HomeRoute.js';
import { LibraryRoute } from './routes/LibraryRoute.js';
import { BrowseRoute } from './routes/BrowseRoute.js';
import { SearchRoute } from './routes/SearchRoute.js';
import { ActiveTrainerRoute } from './routes/ActiveTrainerRoute.js';

export default function App(): JSX.Element {
  const latchState = useLatchState((s) => s.state);
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar latchState={latchState} />
        <main className="flex-1 overflow-y-auto p-5">
          <Routes>
            <Route path="/"        element={<HomeRoute />} />
            <Route path="/library" element={<LibraryRoute />} />
            <Route path="/browse"  element={<BrowseRoute />} />
            <Route path="/search"  element={<SearchRoute />} />
            <Route path="/active"  element={<ActiveTrainerRoute />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
```

(Tasks 4 and 7–11 will create the imported modules. For now `tsc --noEmit` will fail until they exist; that's OK — we'll create them in the next tasks.)

- [ ] **Step 6: Stub the missing modules so this commit compiles**

Create temporary stubs (each file is a single line of `export function FooRoute(): JSX.Element { return <div>Foo</div>; }` to make the imports resolve):

`apps/desktop/src/renderer/routes/HomeRoute.tsx`:

```tsx
export function HomeRoute(): JSX.Element { return <div>Home (stub)</div>; }
```

`apps/desktop/src/renderer/routes/LibraryRoute.tsx`:

```tsx
export function LibraryRoute(): JSX.Element { return <div>Library (stub)</div>; }
```

`apps/desktop/src/renderer/routes/BrowseRoute.tsx`:

```tsx
export function BrowseRoute(): JSX.Element { return <div>Browse (stub)</div>; }
```

`apps/desktop/src/renderer/routes/SearchRoute.tsx`:

```tsx
export function SearchRoute(): JSX.Element { return <div>Search (stub)</div>; }
```

`apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx`:

```tsx
export function ActiveTrainerRoute(): JSX.Element { return <div>Active Trainer (stub)</div>; }
```

Also create the latch store stub so `useLatchState` resolves (full impl in Task 4):

`apps/desktop/src/renderer/stores/latch-store.ts`:

```ts
import { create } from 'zustand';

interface LatchStore { state: 'idle' | 'waiting' | 'detected' | 'latched' }

export const useLatchState = create<LatchStore>(() => ({ state: 'waiting' }));
```

- [ ] **Step 7: Lint + run dev**

Run: `pnpm --filter @starlight/desktop lint`
Expected: clean.

Run: `pnpm --filter @starlight/desktop dev`
Expected: window opens; sidebar shows the five nav items; clicking each shows the corresponding stub text in the main area; the top bar shows a magenta-pulsing "Waiting for game" pill.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/
git commit -m "feat(desktop): app shell with sidebar nav, top bar, and route skeleton"
```

---

## Task 4: Latch state store

**Files:**
- Replace: `apps/desktop/src/renderer/stores/latch-store.ts` (full implementation)
- Create: `apps/desktop/test/setup.ts`
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/test/components/LatchPill.test.tsx`

The latch state is a simple state machine: `idle → waiting → detected → latched`. v3 advances it manually (timer / dev button); Phase 4 wires it to real process detection.

- [ ] **Step 1: Vitest config**

Create `apps/desktop/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 2: Test setup**

Create `apps/desktop/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

Add to `apps/desktop/package.json` devDependencies if not already present:

```json
"@testing-library/jest-dom": "^6.5.0"
```

Then run `pnpm install` to pick up the new dep.

- [ ] **Step 3: Write the failing LatchPill test**

Create `apps/desktop/test/components/LatchPill.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LatchPill } from '../../src/renderer/components/LatchPill.js';

describe('LatchPill', () => {
  it('renders the "Waiting" label when state is waiting', () => {
    render(<LatchPill state="waiting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for game');
  });

  it('renders LATCHED when state is latched', () => {
    render(<LatchPill state="latched" />);
    expect(screen.getByRole('status')).toHaveTextContent('LATCHED');
  });

  it('uses the green palette when latched', () => {
    render(<LatchPill state="latched" />);
    const pill = screen.getByRole('status');
    expect(pill.className).toMatch(/border-neon-green/);
    expect(pill.className).toMatch(/text-neon-green/);
  });

  it('uses the pink palette when waiting', () => {
    render(<LatchPill state="waiting" />);
    const pill = screen.getByRole('status');
    expect(pill.className).toMatch(/border-neon-pink/);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @starlight/desktop test`
Expected: PASS — 4 tests (LatchPill component already exists from Task 3).

If a test fails because of @testing-library/jest-dom not loaded, ensure step 2 dep was installed.

- [ ] **Step 5: Replace the latch-store stub with the real implementation**

Replace `apps/desktop/src/renderer/stores/latch-store.ts`:

```ts
import { create } from 'zustand';

export type LatchState = 'idle' | 'waiting' | 'detected' | 'latched';

interface LatchStore {
  state: LatchState;
  /** The game currently associated with this latch — null until detected. */
  detectedGame: { name: string; coverUrl: string; processName: string } | null;
  setState: (state: LatchState) => void;
  detect: (game: { name: string; coverUrl: string; processName: string }) => void;
  latch: () => void;
  detach: () => void;
}

export const useLatchState = create<LatchStore>((set) => ({
  state: 'waiting',
  detectedGame: null,
  setState: (state) => set({ state }),
  detect: (game) => set({ state: 'detected', detectedGame: game }),
  latch: () => set({ state: 'latched' }),
  detach: () => set({ state: 'waiting', detectedGame: null }),
}));
```

- [ ] **Step 6: Re-run tests + dev**

Run: `pnpm --filter @starlight/desktop test`
Expected: PASS — still 4 tests green.

Run: `pnpm --filter @starlight/desktop dev`
Expected: window shows the magenta "Waiting for game" pill (default state).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/stores/ apps/desktop/test/ apps/desktop/vitest.config.ts apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(desktop): latch state store and component tests"
```

---

## Task 5: Mock data fixtures

**Files:**
- Create: `apps/desktop/src/renderer/data/catalog.ts`
- Create: `apps/desktop/src/renderer/data/elden-ring-trainer.ts`

Hard-coded data used by every route. The catalog drives Home/Library/Browse/Search; the trainer fixture drives Active Trainer.

- [ ] **Step 1: Catalog fixture**

Create `apps/desktop/src/renderer/data/catalog.ts`:

```ts
export interface CatalogGame {
  steamAppId: number;
  name: string;
  processName: string[];
  /** Steam CDN library cover (600x900). */
  coverUrl: string;
  hasTrainer: boolean;
  installed: boolean;
}

const cover = (id: number): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`;

export const CATALOG: CatalogGame[] = [
  { steamAppId: 1245620, name: 'Elden Ring',         processName: ['eldenring.exe'],     coverUrl: cover(1245620), hasTrainer: true,  installed: true  },
  { steamAppId: 1091500, name: 'Cyberpunk 2077',     processName: ['Cyberpunk2077.exe'], coverUrl: cover(1091500), hasTrainer: true,  installed: true  },
  { steamAppId: 413150,  name: 'Stardew Valley',     processName: ['Stardew Valley.exe'],coverUrl: cover(413150),  hasTrainer: false, installed: true  },
  { steamAppId: 1145350, name: 'Hades II',           processName: ['Hades2.exe'],        coverUrl: cover(1145350), hasTrainer: true,  installed: false },
  { steamAppId: 367520,  name: 'Hollow Knight',      processName: ['hollow_knight.exe'], coverUrl: cover(367520),  hasTrainer: false, installed: false },
  { steamAppId: 814380,  name: 'Sekiro',             processName: ['sekiro.exe'],        coverUrl: cover(814380),  hasTrainer: false, installed: false },
  { steamAppId: 1086940, name: "Baldur's Gate 3",    processName: ['bg3.exe'],           coverUrl: cover(1086940), hasTrainer: true,  installed: false },
  { steamAppId: 1716740, name: 'Starfield',          processName: ['Starfield.exe'],     coverUrl: cover(1716740), hasTrainer: true,  installed: false },
  { steamAppId: 553850,  name: 'Helldivers 2',       processName: ['helldivers2.exe'],   coverUrl: cover(553850),  hasTrainer: true,  installed: false },
  { steamAppId: 2694490, name: 'Path of Exile 2',    processName: ['PathOfExile.exe'],   coverUrl: cover(2694490), hasTrainer: true,  installed: false },
  { steamAppId: 374320,  name: 'Dark Souls III',     processName: ['DarkSoulsIII.exe'],  coverUrl: cover(374320),  hasTrainer: true,  installed: false },
  { steamAppId: 2050650, name: 'Resident Evil 4',    processName: ['re4.exe'],           coverUrl: cover(2050650), hasTrainer: true,  installed: false },
];
```

- [ ] **Step 2: Trainer fixture**

Create `apps/desktop/src/renderer/data/elden-ring-trainer.ts`:

```ts
/* Hand-crafted Starlight Trainer JSON for Phase 3 demo purposes.
 * Phase 4 will replace this with real importer output via IPC.
 *
 * The shape mirrors what @starlight/ct-importer emits — keep the field
 * names in sync with packages/ct-importer/src/starlight-format.ts. */

export interface MockAddress {
  kind: 'absolute' | 'module' | 'pointer' | 'aob';
  address?: string;
  module?: string;
  offset?: string;
  baseOffset?: string;
  offsets?: string[];
  pattern?: string;
}

export interface MockSupportedCheat {
  id: string;
  name: string;
  description?: string;
  type: 'freeze' | 'set' | 'toggle';
  valueType: 'int8'|'uint8'|'int16'|'uint16'|'int32'|'uint32'|'int64'|'uint64'|'float'|'double'|'string';
  value?: number;
  default?: number;
  step?: number;
  min?: number;
  max?: number;
  address: MockAddress;
  hotkeys?: { toggle?: string; inc?: string; dec?: string };
  unsupported?: false;
}

export interface MockUnsupportedCheat {
  id: string;
  name: string;
  description?: string;
  unsupported: true;
  unsupportedReason: string;
  originalSource?: string;
}

export type MockCheat = MockSupportedCheat | MockUnsupportedCheat;

export interface MockCategory { name: string; cheats: MockCheat[] }

export interface MockTrainer {
  schemaVersion: 1;
  id: string;
  game: { name: string; processName: string[]; steamAppId?: number; platform: string[]; coverUrl: string };
  metadata: { author?: string; source: { url?: string; convertedFrom: '.CT' }; warnings?: string[] };
  categories: MockCategory[];
}

export const ELDEN_RING_TRAINER: MockTrainer = {
  schemaVersion: 1,
  id: 'starlight-elden-ring-frx-1',
  game: {
    name: 'Elden Ring',
    processName: ['eldenring.exe', 'start_protected_game.exe'],
    steamAppId: 1245620,
    platform: ['windows'],
    coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900.jpg',
  },
  metadata: {
    author: 'FLiNG (FRX)',
    source: { url: 'https://fearlessrevolution.com/...', convertedFrom: '.CT' },
    warnings: ['4 entries unsupported (Lua scripts)'],
  },
  categories: [
    {
      name: 'Player',
      cheats: [
        {
          id: 'infinite-hp',
          name: 'Infinite HP',
          description: 'Freezes current HP at maximum. Compatible with all weapons.',
          type: 'freeze',
          valueType: 'int32',
          value: 999999,
          address: { kind: 'pointer', module: 'eldenring.exe', baseOffset: '0x4a2b3c', offsets: ['0x10', '0x20'] },
          hotkeys: { toggle: 'F1' },
        },
        {
          id: 'infinite-stamina',
          name: 'Infinite Stamina',
          description: "Stamina won't decrease while active.",
          type: 'freeze',
          valueType: 'float',
          value: 100.0,
          address: { kind: 'pointer', module: 'eldenring.exe', baseOffset: '0x4a2b40', offsets: ['0x10', '0x24'] },
          hotkeys: { toggle: 'F2' },
        },
        {
          id: 'one-hit-kills',
          name: 'One-Hit Kills',
          description: 'Multiplies outgoing damage by 100×.',
          type: 'freeze',
          valueType: 'float',
          value: 100,
          address: { kind: 'aob', module: 'eldenring.exe', pattern: 'F3 0F 11 ?? ?? ?? ?? F3 0F 10', offset: '0x3' },
          hotkeys: { toggle: 'F3' },
        },
        {
          id: 'movement-speed',
          name: 'Movement Speed Multiplier',
          description: '1.0 = normal · step 0.1 · clamped to 0.1–10.0',
          type: 'set',
          valueType: 'float',
          default: 1.5,
          step: 0.1,
          min: 0.1,
          max: 10.0,
          address: { kind: 'aob', module: 'eldenring.exe', pattern: 'F3 0F 10 35 ?? ?? ?? ??', offset: '0x4' },
          hotkeys: { toggle: 'F4', inc: 'PageUp', dec: 'PageDown' },
        },
        {
          id: 'no-fall-damage',
          name: 'No Fall Damage',
          description: 'Disables fall damage calculation.',
          type: 'freeze',
          valueType: 'float',
          value: 0,
          address: { kind: 'pointer', module: 'eldenring.exe', baseOffset: '0x4a2b80', offsets: ['0x18'] },
          hotkeys: { toggle: 'F5' },
        },
        {
          id: 'auto-block-script',
          name: 'Auto-Block Script',
          description: 'Uses Cheat Engine Lua API — open the original .CT in CE to use this entry.',
          unsupported: true,
          unsupportedReason: 'Uses Cheat Engine Lua API. Open the original .CT in Cheat Engine to use this entry.',
        },
      ],
    },
    {
      name: 'Stats',
      cheats: [
        {
          id: 'set-souls',
          name: 'Set Runes',
          description: 'Integer · step 1000.',
          type: 'set',
          valueType: 'int32',
          default: 50000,
          step: 1000,
          min: 0,
          max: 999999999,
          address: { kind: 'pointer', module: 'eldenring.exe', baseOffset: '0x4b1000', offsets: ['0x40'] },
          hotkeys: { toggle: 'F7', inc: 'F7+Up', dec: 'F7+Down' },
        },
      ],
    },
  ],
};
```

- [ ] **Step 3: Verify lint clean**

Run: `pnpm --filter @starlight/desktop lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/data/
git commit -m "feat(desktop): mock catalog and Elden Ring trainer fixtures"
```

---

## Task 6: GameTile and BoxartGrid components

**Files:**
- Create: `apps/desktop/src/renderer/components/GameTile.tsx`
- Create: `apps/desktop/src/renderer/components/BoxartGrid.tsx`
- Create: `apps/desktop/test/components/GameTile.test.tsx`

`GameTile` is a single boxart tile with badges. `BoxartGrid` lays them out in an 8-column grid. Used by Home/Library/Browse/Search.

- [ ] **Step 1: Write the failing GameTile test**

Create `apps/desktop/test/components/GameTile.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameTile } from '../../src/renderer/components/GameTile.js';

const game = {
  steamAppId: 1245620,
  name: 'Elden Ring',
  processName: ['eldenring.exe'],
  coverUrl: 'https://example.com/eldenring.jpg',
  hasTrainer: true,
  installed: true,
};

describe('GameTile', () => {
  it('renders an accessible label with the game name', () => {
    render(<GameTile game={game} />);
    expect(screen.getByRole('button', { name: /Elden Ring/i })).toBeInTheDocument();
  });

  it('shows INSTALLED badge when installed', () => {
    render(<GameTile game={game} />);
    expect(screen.getByText(/installed/i)).toBeInTheDocument();
  });

  it('shows TRAINER badge when hasTrainer', () => {
    render(<GameTile game={game} />);
    expect(screen.getByText(/^trainer$/i)).toBeInTheDocument();
  });

  it('omits TRAINER badge when hasTrainer is false', () => {
    render(<GameTile game={{ ...game, hasTrainer: false }} />);
    expect(screen.queryByText(/^trainer$/i)).not.toBeInTheDocument();
  });

  it('calls onClick with the game when clicked', async () => {
    const handler = vi.fn();
    render(<GameTile game={game} onClick={handler} />);
    await userEvent.click(screen.getByRole('button'));
    expect(handler).toHaveBeenCalledWith(game);
  });
});
```

- [ ] **Step 2: Run test (fails — module missing)**

Run: `pnpm --filter @starlight/desktop test GameTile`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement GameTile**

Create `apps/desktop/src/renderer/components/GameTile.tsx`:

```tsx
import type { CatalogGame } from '../data/catalog.js';

interface Props {
  game: CatalogGame;
  onClick?: (game: CatalogGame) => void;
}

export function GameTile({ game, onClick }: Props): JSX.Element {
  const hasTrainerBorder = game.hasTrainer ? 'border-neon-cyan/60 glow-cyan' : 'border-line';
  return (
    <button
      type="button"
      aria-label={game.name}
      onClick={() => onClick?.(game)}
      className={`relative aspect-[2/3] rounded-sm overflow-hidden border ${hasTrainerBorder} transition-transform duration-150 hover:-translate-y-0.5 hover:border-neon-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan`}
      style={{ backgroundImage: `url(${game.coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
    >
      {game.installed && (
        <span className="absolute top-1.5 left-1.5 text-[8px] tracking-wider text-neon-pink bg-bg/70 px-1.5 py-[2px] rounded-sm">
          ● INSTALLED
        </span>
      )}
      {game.hasTrainer && (
        <span className="absolute bottom-1.5 right-1.5 text-[8px] tracking-wider text-neon-cyan bg-bg/70 px-1.5 py-[2px] rounded-sm uppercase">
          Trainer
        </span>
      )}
      <span className="sr-only">{game.name}</span>
    </button>
  );
}
```

- [ ] **Step 4: Implement BoxartGrid**

Create `apps/desktop/src/renderer/components/BoxartGrid.tsx`:

```tsx
import type { CatalogGame } from '../data/catalog.js';
import { GameTile } from './GameTile.js';

interface Props {
  games: CatalogGame[];
  onSelect?: (game: CatalogGame) => void;
  /** Tailwind grid-cols class (default: 8). */
  cols?: string;
}

export function BoxartGrid({ games, onSelect, cols = 'grid-cols-8' }: Props): JSX.Element {
  return (
    <div className={`grid ${cols} gap-3`}>
      {games.map((g) => (
        <GameTile key={g.steamAppId} game={g} onClick={onSelect} />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run tests (passes)**

Run: `pnpm --filter @starlight/desktop test`
Expected: PASS — 5 GameTile tests + the 4 prior LatchPill tests = 9.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/components/GameTile.tsx apps/desktop/src/renderer/components/BoxartGrid.tsx apps/desktop/test/components/GameTile.test.tsx
git commit -m "feat(desktop): GameTile and BoxartGrid components"
```

---

## Task 7: Home route

**Files:**
- Replace: `apps/desktop/src/renderer/routes/HomeRoute.tsx`

Home shows two horizontal sections of tiles: "Recently Played" (installed games) and "Featured Trainers" (everything with `hasTrainer`). Title bar shows a count of installed-with-trainer games.

- [ ] **Step 1: Implement HomeRoute**

Replace `apps/desktop/src/renderer/routes/HomeRoute.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { CATALOG, type CatalogGame } from '../data/catalog.js';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useLatchState } from '../stores/latch-store.js';

export function HomeRoute(): JSX.Element {
  const navigate = useNavigate();
  const detect = useLatchState((s) => s.detect);

  const installed = CATALOG.filter((g) => g.installed);
  const featured = CATALOG.filter((g) => g.hasTrainer);
  const installedWithTrainer = CATALOG.filter((g) => g.installed && g.hasTrainer).length;

  function selectGame(g: CatalogGame): void {
    if (g.hasTrainer) {
      detect({ name: g.name, coverUrl: g.coverUrl, processName: g.processName[0]! });
      navigate('/active');
    }
  }

  return (
    <>
      <PageHeader
        title="Home"
        right={
          <span className="text-[11px] text-muted">
            <span className="inline-block size-1.5 rounded-full bg-neon-cyan glow-cyan mr-1.5 align-middle" />
            {installedWithTrainer} installed games have trainers
          </span>
        }
      />
      <Section label="Recently Played" games={installed} onSelect={selectGame} />
      <Section label="Featured Trainers" games={featured} onSelect={selectGame} />
    </>
  );
}

function Section({ label, games, onSelect }: { label: string; games: CatalogGame[]; onSelect: (g: CatalogGame) => void }): JSX.Element {
  return (
    <section className="mb-5">
      <div className="text-[10px] tracking-wider uppercase text-muted mb-2.5">{label}</div>
      <BoxartGrid games={games} onSelect={onSelect} />
    </section>
  );
}
```

- [ ] **Step 2: Run dev to verify**

Run: `pnpm --filter @starlight/desktop dev`
Expected: Home route shows two rows of boxart. Clicking an installed-with-trainer game navigates to /active and the latch pill flips to "Game detected — click to Latch" (cyan).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/routes/HomeRoute.tsx
git commit -m "feat(desktop): Home route with Recently Played and Featured sections"
```

---

## Task 8: Library, Browse, Search routes

**Files:**
- Replace: `apps/desktop/src/renderer/routes/LibraryRoute.tsx`
- Replace: `apps/desktop/src/renderer/routes/BrowseRoute.tsx`
- Replace: `apps/desktop/src/renderer/routes/SearchRoute.tsx`

These three routes share the boxart-grid pattern but differ in filtering and the controls above the grid.

- [ ] **Step 1: LibraryRoute (only installed games)**

Replace `apps/desktop/src/renderer/routes/LibraryRoute.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { CATALOG, type CatalogGame } from '../data/catalog.js';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useLatchState } from '../stores/latch-store.js';

export function LibraryRoute(): JSX.Element {
  const navigate = useNavigate();
  const detect = useLatchState((s) => s.detect);
  const installed = CATALOG.filter((g) => g.installed);

  function onSelect(g: CatalogGame): void {
    if (g.hasTrainer) {
      detect({ name: g.name, coverUrl: g.coverUrl, processName: g.processName[0]! });
      navigate('/active');
    }
  }

  return (
    <>
      <PageHeader
        title="Library"
        subtitle={`${installed.length} games detected from Steam, Epic, Heroic, Lutris`}
      />
      <BoxartGrid games={installed} onSelect={onSelect} />
    </>
  );
}
```

- [ ] **Step 2: BrowseRoute (filter toggles)**

Replace `apps/desktop/src/renderer/routes/BrowseRoute.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CATALOG, type CatalogGame } from '../data/catalog.js';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useLatchState } from '../stores/latch-store.js';

export function BrowseRoute(): JSX.Element {
  const navigate = useNavigate();
  const detect = useLatchState((s) => s.detect);
  const [hasTrainerOnly, setHasTrainerOnly] = useState(true);

  const games = CATALOG.filter((g) => !hasTrainerOnly || g.hasTrainer);

  function onSelect(g: CatalogGame): void {
    if (g.hasTrainer) {
      detect({ name: g.name, coverUrl: g.coverUrl, processName: g.processName[0]! });
      navigate('/active');
    }
  }

  return (
    <>
      <PageHeader
        title="Browse"
        subtitle={`${games.length} games in the catalog`}
        right={
          <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={hasTrainerOnly}
              onChange={(e) => setHasTrainerOnly(e.target.checked)}
              className="accent-neon-cyan"
            />
            Has trainer only
          </label>
        }
      />
      <BoxartGrid games={games} onSelect={onSelect} />
    </>
  );
}
```

- [ ] **Step 3: SearchRoute (text query)**

Replace `apps/desktop/src/renderer/routes/SearchRoute.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CATALOG, type CatalogGame } from '../data/catalog.js';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useLatchState } from '../stores/latch-store.js';

export function SearchRoute(): JSX.Element {
  const navigate = useNavigate();
  const detect = useLatchState((s) => s.detect);
  const [query, setQuery] = useState('');

  const matches = query.trim()
    ? CATALOG.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  function onSelect(g: CatalogGame): void {
    if (g.hasTrainer) {
      detect({ name: g.name, coverUrl: g.coverUrl, processName: g.processName[0]! });
      navigate('/active');
    }
  }

  return (
    <>
      <PageHeader title="Search" />
      <input
        autoFocus
        type="text"
        placeholder="Type a game name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full max-w-[480px] h-9 rounded bg-panel border border-line px-3 text-sm text-ink placeholder:text-muted/80 focus:outline-none focus:border-neon-cyan mb-4"
      />
      {query.trim() && matches.length === 0 ? (
        <div className="text-xs text-muted">No games match. (Phase 4 will show a "request a trainer" CTA.)</div>
      ) : (
        <BoxartGrid games={matches} onSelect={onSelect} />
      )}
    </>
  );
}
```

- [ ] **Step 4: Verify dev**

Run: `pnpm --filter @starlight/desktop dev`

Click through all four nav items: Home, Library, Browse, Search. Confirm each renders correctly. In Browse, toggling the "Has trainer only" checkbox shows/hides games. In Search, typing "elden" filters down to Elden Ring.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/routes/LibraryRoute.tsx apps/desktop/src/renderer/routes/BrowseRoute.tsx apps/desktop/src/renderer/routes/SearchRoute.tsx
git commit -m "feat(desktop): Library, Browse, Search routes with filters"
```

---

## Task 9: Cheat card components

**Files:**
- Create: `apps/desktop/src/renderer/components/cheat-cards/ToggleCheatCard.tsx`
- Create: `apps/desktop/src/renderer/components/cheat-cards/ValueCheatCard.tsx`
- Create: `apps/desktop/src/renderer/components/cheat-cards/UnsupportedCheatCard.tsx`
- Create: `apps/desktop/test/components/cheat-cards.test.tsx`

Three card variants matching the Active Trainer mockup. They take props (no store access) and emit callbacks.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/test/components/cheat-cards.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToggleCheatCard } from '../../src/renderer/components/cheat-cards/ToggleCheatCard.js';
import { ValueCheatCard } from '../../src/renderer/components/cheat-cards/ValueCheatCard.js';
import { UnsupportedCheatCard } from '../../src/renderer/components/cheat-cards/UnsupportedCheatCard.js';

describe('ToggleCheatCard', () => {
  it('shows the cheat name and description', () => {
    render(<ToggleCheatCard id="x" name="Infinite HP" description="Freezes HP." active={false} hotkey="F1" onToggle={() => {}} />);
    expect(screen.getByText('Infinite HP')).toBeInTheDocument();
    expect(screen.getByText('Freezes HP.')).toBeInTheDocument();
  });

  it('shows the hotkey badge', () => {
    render(<ToggleCheatCard id="x" name="X" active={false} hotkey="F1" onToggle={() => {}} />);
    expect(screen.getByText('F1')).toBeInTheDocument();
  });

  it('calls onToggle when the toggle is clicked', async () => {
    const handler = vi.fn();
    render(<ToggleCheatCard id="x" name="X" active={false} hotkey="F1" onToggle={handler} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(handler).toHaveBeenCalledWith('x', true);
  });

  it('renders as active when active=true', () => {
    render(<ToggleCheatCard id="x" name="X" active hotkey="F1" onToggle={() => {}} />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
});

describe('ValueCheatCard', () => {
  const props = {
    id: 'speed', name: 'Speed', description: '1.0 = normal',
    active: false, value: 1.5, step: 0.1, min: 0.1, max: 10,
    hotkeys: { toggle: 'F4', inc: 'PageUp', dec: 'PageDown' },
  };

  it('renders the current value', () => {
    render(<ValueCheatCard {...props} onToggle={() => {}} onValueChange={() => {}} />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('1.5');
  });

  it('clamps when the user clicks +', async () => {
    const handler = vi.fn();
    render(<ValueCheatCard {...{ ...props, value: 9.95 }} onToggle={() => {}} onValueChange={handler} />);
    await userEvent.click(screen.getByRole('button', { name: '+' }));
    expect(handler).toHaveBeenCalledWith('speed', 10);
  });

  it('renders all three hotkeys', () => {
    render(<ValueCheatCard {...props} onToggle={() => {}} onValueChange={() => {}} />);
    expect(screen.getByText('F4')).toBeInTheDocument();
    expect(screen.getByText('PageUp')).toBeInTheDocument();
    expect(screen.getByText('PageDown')).toBeInTheDocument();
  });
});

describe('UnsupportedCheatCard', () => {
  it('shows the UNSUPPORTED badge and reason', () => {
    render(<UnsupportedCheatCard id="x" name="Auto-Block" reason="Uses Cheat Engine Lua API." />);
    expect(screen.getByText(/UNSUPPORTED/)).toBeInTheDocument();
    expect(screen.getByText(/Lua/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run (fails — modules missing)**

Run: `pnpm --filter @starlight/desktop test cheat-cards`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement ToggleCheatCard**

Create `apps/desktop/src/renderer/components/cheat-cards/ToggleCheatCard.tsx`:

```tsx
interface Props {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  hotkey?: string;
  onToggle: (id: string, next: boolean) => void;
}

export function ToggleCheatCard({ id, name, description, active, hotkey, onToggle }: Props): JSX.Element {
  const containerCls = active
    ? 'border-neon-green bg-neon-green/[0.04] glow-green'
    : 'border-line hover:border-neon-cyan';
  const titleCls = active ? 'text-neon-green' : '';

  return (
    <div className={`grid grid-cols-[1fr_auto_auto] gap-3.5 items-center px-4 py-3.5 rounded-sm bg-panel border transition-colors ${containerCls}`}>
      <div>
        <div className={`text-[13px] font-semibold ${titleCls}`}>{name}</div>
        {description && <div className="text-[11px] text-muted mt-0.5">{description}</div>}
      </div>
      {hotkey ? (
        <span className={`text-[10px] tracking-wider px-2 py-1 rounded-sm border font-mono ${active ? 'border-neon-green text-neon-green' : 'border-line text-muted'}`}>
          {hotkey}
        </span>
      ) : <span />}
      <button
        type="button"
        role="switch"
        aria-checked={active}
        onClick={() => onToggle(id, !active)}
        className={`w-9 h-[18px] rounded-[10px] border relative transition-colors ${active ? 'bg-neon-green/[0.15] border-neon-green' : 'bg-line border-line'}`}
      >
        <span
          className={`absolute top-px size-[14px] rounded-full transition-all ${active ? 'left-[19px] bg-neon-green glow-green' : 'left-px bg-[#3a3a55]'}`}
        />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Implement ValueCheatCard**

Create `apps/desktop/src/renderer/components/cheat-cards/ValueCheatCard.tsx`:

```tsx
interface Props {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  value: number;
  step: number;
  min?: number;
  max?: number;
  hotkeys?: { toggle?: string; inc?: string; dec?: string };
  onToggle: (id: string, next: boolean) => void;
  onValueChange: (id: string, value: number) => void;
}

function clamp(v: number, min?: number, max?: number): number {
  let r = v;
  if (min !== undefined && r < min) r = min;
  if (max !== undefined && r > max) r = max;
  return Number(r.toFixed(6));
}

export function ValueCheatCard(props: Props): JSX.Element {
  const { id, name, description, active, value, step, min, max, hotkeys, onToggle, onValueChange } = props;
  const containerCls = active
    ? 'border-neon-green bg-neon-green/[0.04] glow-green'
    : 'border-line hover:border-neon-cyan';
  const titleCls = active ? 'text-neon-green' : '';

  return (
    <div className={`grid grid-cols-[1fr_140px_120px_auto] gap-3.5 items-center px-4 py-3.5 rounded-sm bg-panel border transition-colors ${containerCls}`}>
      <div>
        <div className={`text-[13px] font-semibold ${titleCls}`}>{name}</div>
        {description && <div className="text-[11px] text-muted mt-0.5">{description}</div>}
      </div>

      <div className={`flex h-7 rounded-sm border overflow-hidden ${active ? 'border-neon-green' : 'border-line'}`}>
        <button
          type="button"
          aria-label="-"
          onClick={() => onValueChange(id, clamp(value - step, min, max))}
          className="w-7 bg-panel border-r border-line text-ink hover:bg-neon-cyan/10 hover:text-neon-cyan font-mono"
        >−</button>
        <input
          type="number"
          aria-label={`${name} value`}
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => onValueChange(id, clamp(Number(e.target.value), min, max))}
          className={`flex-1 min-w-0 bg-transparent text-center font-mono text-xs px-1 outline-none ${active ? 'text-neon-green' : 'text-ink'}`}
        />
        <button
          type="button"
          aria-label="+"
          onClick={() => onValueChange(id, clamp(value + step, min, max))}
          className="w-7 bg-panel border-l border-line text-ink hover:bg-neon-cyan/10 hover:text-neon-cyan font-mono"
        >+</button>
      </div>

      {hotkeys ? (
        <div className="flex flex-col gap-0.5 items-end font-mono text-[9px] text-muted">
          {hotkeys.toggle && <Hotkey label="on" keyName={hotkeys.toggle} active={active} />}
          {hotkeys.inc    && <Hotkey label="+"  keyName={hotkeys.inc}    active={active} />}
          {hotkeys.dec    && <Hotkey label="−"  keyName={hotkeys.dec}    active={active} />}
        </div>
      ) : <span />}

      <button
        type="button"
        role="switch"
        aria-checked={active}
        onClick={() => onToggle(id, !active)}
        className={`w-9 h-[18px] rounded-[10px] border relative transition-colors justify-self-end ${active ? 'bg-neon-green/[0.15] border-neon-green' : 'bg-line border-line'}`}
      >
        <span className={`absolute top-px size-[14px] rounded-full transition-all ${active ? 'left-[19px] bg-neon-green glow-green' : 'left-px bg-[#3a3a55]'}`} />
      </button>
    </div>
  );
}

function Hotkey({ label, keyName, active }: { label: string; keyName: string; active: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="tracking-wider uppercase opacity-70">{label}</span>
      <span className={`border px-1.5 py-px rounded-sm min-w-[38px] text-center ${active ? 'border-neon-green/50 text-neon-green' : 'border-line'}`}>
        {keyName}
      </span>
    </div>
  );
}
```

- [ ] **Step 5: Implement UnsupportedCheatCard**

Create `apps/desktop/src/renderer/components/cheat-cards/UnsupportedCheatCard.tsx`:

```tsx
interface Props { id: string; name: string; reason: string; description?: string }

export function UnsupportedCheatCard({ name, reason, description }: Props): JSX.Element {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-3.5 items-center px-4 py-3.5 rounded-sm bg-panel border border-line opacity-55">
      <div>
        <div className="text-[13px] font-semibold">
          {name}
          <span className="ml-1.5 inline-block text-[8px] tracking-wider px-1.5 py-px rounded-sm border border-neon-amber text-neon-amber align-middle">
            UNSUPPORTED
          </span>
        </div>
        {(description || reason) && <div className="text-[11px] text-muted mt-0.5">{description ?? reason}</div>}
      </div>
      <span className="text-[10px] tracking-wider px-2 py-1 rounded-sm border border-line text-muted font-mono">—</span>
      <span className="w-9 h-[18px] rounded-[10px] border border-line bg-line block" />
    </div>
  );
}
```

- [ ] **Step 6: Run tests (passes)**

Run: `pnpm --filter @starlight/desktop test`
Expected: PASS — 9 prior tests + 9 new cheat-card tests = 18.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/components/cheat-cards/ apps/desktop/test/components/cheat-cards.test.tsx
git commit -m "feat(desktop): cheat card components (toggle/value/unsupported)"
```

---

## Task 10: Active Trainer route

**Files:**
- Replace: `apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx`
- Create: `apps/desktop/test/routes/ActiveTrainerRoute.test.tsx`

The most complex route. Categories sidebar + cheats list. Reads from the trainer fixture; tracks per-cheat active state and current value in local component state. The latch pill in TopBar is driven by the global store: this route also exposes a "Latch / Detach" header button that flips the store between `detected` and `latched`.

- [ ] **Step 1: Write the failing route test**

Create `apps/desktop/test/routes/ActiveTrainerRoute.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ActiveTrainerRoute } from '../../src/renderer/routes/ActiveTrainerRoute.js';
import { useLatchState } from '../../src/renderer/stores/latch-store.js';

beforeEach(() => {
  useLatchState.setState({
    state: 'latched',
    detectedGame: { name: 'Elden Ring', coverUrl: 'https://example.com/x.jpg', processName: 'eldenring.exe' },
  });
});

describe('ActiveTrainerRoute', () => {
  it('renders the latched game name and category list', () => {
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
    expect(screen.getByText('Player')).toBeInTheDocument();
    expect(screen.getByText('Stats')).toBeInTheDocument();
  });

  it('shows toggle, value, and unsupported variants in the Player category', () => {
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText('Infinite HP')).toBeInTheDocument();          // toggle
    expect(screen.getByText('Movement Speed Multiplier')).toBeInTheDocument(); // value
    expect(screen.getByText('Auto-Block Script')).toBeInTheDocument();    // unsupported
  });

  it('toggling a cheat updates the active count', async () => {
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText(/0 active/)).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    await userEvent.click(switches[0]!);
    expect(screen.getByText(/1 active/)).toBeInTheDocument();
  });

  it('shows a placeholder when not latched', () => {
    useLatchState.setState({ state: 'waiting', detectedGame: null });
    render(<MemoryRouter><ActiveTrainerRoute /></MemoryRouter>);
    expect(screen.getByText(/no game latched/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run (fails — current route is just a stub)**

Run: `pnpm --filter @starlight/desktop test ActiveTrainerRoute`
Expected: FAIL — content not present.

- [ ] **Step 3: Implement ActiveTrainerRoute**

Replace `apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx`:

```tsx
import { useState } from 'react';
import { useLatchState } from '../stores/latch-store.js';
import { ELDEN_RING_TRAINER, type MockCheat, type MockSupportedCheat } from '../data/elden-ring-trainer.js';
import { ToggleCheatCard } from '../components/cheat-cards/ToggleCheatCard.js';
import { ValueCheatCard } from '../components/cheat-cards/ValueCheatCard.js';
import { UnsupportedCheatCard } from '../components/cheat-cards/UnsupportedCheatCard.js';

function isSupported(c: MockCheat): c is MockSupportedCheat {
  return !('unsupported' in c) || c.unsupported !== true;
}

function isValueCheat(c: MockSupportedCheat): boolean {
  return c.type === 'set';
}

export function ActiveTrainerRoute(): JSX.Element {
  const { state, detectedGame, latch, detach } = useLatchState();

  if (!detectedGame) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted">
        <p className="text-sm">No game latched.</p>
        <p className="text-xs mt-2">Open a game and click its tile from Home or Library.</p>
      </div>
    );
  }

  return <TrainerView state={state} game={detectedGame} onLatch={latch} onDetach={detach} />;
}

interface TrainerViewProps {
  state: ReturnType<typeof useLatchState.getState>['state'];
  game: NonNullable<ReturnType<typeof useLatchState.getState>['detectedGame']>;
  onLatch: () => void;
  onDetach: () => void;
}

function TrainerView({ state, game, onLatch, onDetach }: TrainerViewProps): JSX.Element {
  const trainer = ELDEN_RING_TRAINER;
  const [activeCategory, setActiveCategory] = useState<string>(trainer.categories[0]!.name);

  // Per-cheat state: active + current value (for value cheats)
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const cat of trainer.categories) {
      for (const c of cat.cheats) {
        if (isSupported(c) && isValueCheat(c) && c.default !== undefined) init[c.id] = c.default;
      }
    }
    return init;
  });

  const category = trainer.categories.find((c) => c.name === activeCategory)!;
  const activeCount = category.cheats.filter((c) => active[c.id]).length;
  const totalCheats = trainer.categories.reduce((acc, c) => acc + c.cheats.length, 0);
  const supportedCount = trainer.categories.reduce(
    (acc, c) => acc + c.cheats.filter((x) => isSupported(x)).length, 0,
  );

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 h-full">
      {/* Header band spans both columns */}
      <div className="col-span-2 flex items-center gap-3 -mt-2 mb-2">
        <div
          className="w-7 h-[42px] bg-cover bg-center rounded-sm border border-line"
          style={{ backgroundImage: `url(${game.coverUrl})` }}
        />
        <div>
          <div className="text-[13px] font-semibold">{game.name}</div>
          <div className="text-[10px] text-muted">PID 24081 · trainer by {trainer.metadata.author ?? 'unknown'}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {state === 'detected' && (
            <button
              type="button"
              onClick={onLatch}
              className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]"
            >
              Latch
            </button>
          )}
          {state === 'latched' && (
            <button
              type="button"
              onClick={onDetach}
              className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-pink hover:text-neon-pink"
            >
              Detach
            </button>
          )}
        </div>
      </div>

      {/* Categories sidebar */}
      <aside className="flex flex-col gap-1">
        <div className="text-[9px] tracking-wider uppercase text-muted px-2 pb-1">Categories</div>
        {trainer.categories.map((c) => {
          const isActive = c.name === activeCategory;
          return (
            <button
              key={c.name}
              type="button"
              onClick={() => setActiveCategory(c.name)}
              className={`text-left px-3 py-2 text-xs rounded-sm border flex justify-between items-center ${isActive ? 'bg-neon-pink/[0.06] border-neon-pink text-neon-pink glow-pink' : 'border-transparent text-ink hover:bg-line/30'}`}
            >
              <span>{c.name}</span>
              <span className={`text-[10px] ${isActive ? 'text-neon-pink' : 'text-muted'}`}>{c.cheats.length}</span>
            </button>
          );
        })}
        <div className="mt-auto pt-2.5 px-2 text-[10px] text-muted border-t border-line leading-relaxed">
          {supportedCount} of {totalCheats} entries supported<br />
          {totalCheats - supportedCount} unsupported (Lua scripts)
        </div>
      </aside>

      {/* Cheats list */}
      <section className="flex flex-col gap-2 overflow-y-auto">
        <div className="flex items-baseline justify-between mb-1">
          <h4 className="text-sm font-semibold m-0">{category.name}</h4>
          <span className="text-[11px] text-muted">{category.cheats.length} cheats · {activeCount} active</span>
        </div>
        {category.cheats.map((c) => {
          if (!isSupported(c)) {
            return <UnsupportedCheatCard key={c.id} id={c.id} name={c.name} reason={c.unsupportedReason} description={c.description} />;
          }
          if (isValueCheat(c)) {
            return (
              <ValueCheatCard
                key={c.id}
                id={c.id}
                name={c.name}
                description={c.description}
                active={!!active[c.id]}
                value={values[c.id] ?? c.default ?? 0}
                step={c.step ?? 1}
                {...(c.min !== undefined ? { min: c.min } : {})}
                {...(c.max !== undefined ? { max: c.max } : {})}
                {...(c.hotkeys ? { hotkeys: c.hotkeys } : {})}
                onToggle={(id, next) => setActive((p) => ({ ...p, [id]: next }))}
                onValueChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
              />
            );
          }
          return (
            <ToggleCheatCard
              key={c.id}
              id={c.id}
              name={c.name}
              description={c.description}
              active={!!active[c.id]}
              {...(c.hotkeys?.toggle ? { hotkey: c.hotkeys.toggle } : {})}
              onToggle={(id, next) => setActive((p) => ({ ...p, [id]: next }))}
            />
          );
        })}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run tests (passes)**

Run: `pnpm --filter @starlight/desktop test`
Expected: all tests pass (~22 total).

- [ ] **Step 5: Verify dev**

Run: `pnpm --filter @starlight/desktop dev`

Click an installed-with-trainer tile from Home → Active Trainer renders with the Elden Ring fixture. The pill shows "Game detected — click to Latch". Click the in-page Latch button — pill flips to green LATCHED. Toggle a cheat — it glows green. Click + on Movement Speed — value increments. Click Detach — pill returns to "Waiting for game" and route shows the placeholder.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/routes/ActiveTrainerRoute.tsx apps/desktop/test/routes/
git commit -m "feat(desktop): Active Trainer route with categories and cheat cards"
```

---

## Task 11: Build + smoke check

**Files:**
- Modify: `.github/workflows/ci.yml` (extend the existing build step to build the desktop app too — it already runs `pnpm -r build`)

The existing `pnpm -r build` step in CI will try to build the desktop app. `electron-vite build` requires a few platform deps that are present on `ubuntu-latest`, but the Electron binary download in `pnpm install` is a multi-megabyte download. Add a cache to keep CI fast.

- [ ] **Step 1: Verify production build works locally**

Run: `pnpm --filter @starlight/desktop build`
Expected: produces `apps/desktop/out/{main,preload,renderer}/`. No errors.

If `pnpm -r build` is now slow because of the desktop, that's expected.

- [ ] **Step 2: Add Electron binary cache to CI**

Edit `.github/workflows/ci.yml`. After the `Set up pnpm` step and before `Install`, add:

```yaml
      - name: Cache Electron binaries
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/electron
            ~/.cache/electron-builder
          key: electron-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
```

- [ ] **Step 3: Verify CI yaml is valid**

```bash
# Lightweight validity check via Python or yq if available; otherwise just review manually.
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "YAML OK"
```

- [ ] **Step 4: Re-run full local verification**

```bash
pnpm -r build      # all three packages build
pnpm -r lint       # all clean
pnpm -r test       # engine 22 + ct-importer 60 + desktop ~22 = ~104 tests
```

If any test fails, fix and re-run. Don't proceed until green.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: cache Electron binaries to keep desktop build fast"
```

---

## Task 12: Pre-Phase-4 polish + smoke

**Files:**
- Modify: `apps/desktop/README.md` (add a "What's mocked" callout)
- Optional: `apps/desktop/src/renderer/components/Sidebar.tsx` (add a dev-only pill state cycler if helpful for testing)

Final tidying. The Phase 3 deliverable is "the UI works end-to-end with mock data." Anyone running `pnpm --filter @starlight/desktop dev` should be able to:
1. See the Neon Arcade aesthetic
2. Navigate Home / Library / Browse / Search
3. Click a tile that has a trainer to land in Active Trainer
4. Click Latch → pill goes green, cheats interactive
5. Toggle / step a cheat
6. Click Detach → pill goes pink, return to placeholder

- [ ] **Step 1: Document what's mocked**

Append to `apps/desktop/README.md`:

```md

## What's mocked in Phase 3

- **Catalog** is hard-coded in `src/renderer/data/catalog.ts` (12 games).
- **Trainer** is hard-coded in `src/renderer/data/elden-ring-trainer.ts` (Elden Ring; matches `@starlight/ct-importer` shape).
- **Latch state** is in-memory Zustand. Clicking a tile sets state to "detected"; clicking the in-page Latch button sets "latched". No real process detection.
- **Cheats are visual only.** Toggling a cheat does not call Frida — Phase 4 will wire that.
- **Hotkeys are static labels.** Global shortcuts are not registered — Phase 4 will use Electron's globalShortcut.
```

- [ ] **Step 2: Final smoke**

Run `pnpm --filter @starlight/desktop dev` one more time. Walk through the six-step demo flow above. Confirm all transitions work, no console errors in DevTools, no missing images for boxart (Steam CDN serves all 12 fixtures).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/README.md
git commit -m "docs(desktop): document what's mocked in Phase 3"
```

---

## Self-Review

**Spec coverage check (against design spec §3.6 UI + §6 Cross-Platform):**

| Spec construct | Task |
|---|---|
| Five top-level routes (Home/Library/Browse/Search/Active Trainer) | Tasks 7, 8, 10 |
| Sidebar nav with brand + nav items | Task 3 |
| Top status bar with latch pill | Task 3 + Task 4 |
| Boxart tile grid for games | Task 6 |
| Cheat card variants (toggle, value/stepper, unsupported) | Task 9 |
| Neon Arcade visual style (dark bg, grid pattern, neon accents) | Task 2 |
| Latch state machine (Waiting / Detected / Latched) | Task 4 + Task 10 |
| Categories sidebar in Active Trainer | Task 10 |
| Per-cheat hotkey display (toggle + inc + dec) | Task 9 |
| Stepper with +/− buttons inline with the value | Task 9 |
| Unsupported entries dimmed with amber tag | Task 9 |
| HashRouter (Electron file:// safe) | Task 1 |
| Sandboxed renderer with no nodeIntegration, contextIsolation on, preload bridge ready for Phase 4 | Task 1 |
| Build & dev tooling (electron-vite) | Task 1 |
| Component tests in jsdom (Vitest + RTL) | Tasks 4, 6, 9, 10 |
| CI build step caches Electron binary | Task 11 |

**Placeholder scan:** none. All step code blocks are complete and runnable.

**Type consistency:** `LatchState` type defined in `latch-store.ts` and re-exported from `LatchPill.tsx`. `CatalogGame` defined in `data/catalog.ts` and consumed by `GameTile`, `BoxartGrid`, and the four routes. The `MockTrainer` shape in `data/elden-ring-trainer.ts` is intentionally a manual replica of `StarlightTrainer` from Phase 2; this is called out in the plan and is the deliberate v3 deferral until Phase 4 wires IPC.

**Scope check:** This plan stays in Phase 3's lane (UI shell with mocks). It does NOT:
- Spawn or attach to processes (Phase 4)
- Call `frida-node` or any engine API (Phase 4)
- Parse `.CT` files or fetch a catalog over the network (Phase 4 / 5)
- Register `globalShortcut` hotkeys (Phase 4)
- Configure code-signing or app packaging (Phase 6)

**Known gaps to document for Phase 4 author:**
- `MockTrainer` shape duplicates `StarlightTrainer`; Phase 4 should remove the duplication by importing the type from `@starlight/ct-importer`.
- `latch-store` exposes synchronous `latch()`/`detach()` calls; Phase 4 will replace these with async functions that talk to main via IPC.
- Cheat toggles and value changes update local component state; Phase 4 will route them through IPC to the engine's `freeze`/`write` calls.
- Hotkey strings are static labels; Phase 4 will register them with Electron's `globalShortcut` and dispatch toggle/inc/dec actions.
