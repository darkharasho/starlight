import { app } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { UserConfig } from '../shared/ipc.js';

const RecentTrainerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  openedAt: z.string(),
  source: z.enum(['catalog', 'file']),
});

const AppPreferencesSchema = z.object({
  theme: z.enum(['dark']).default('dark'),
  pollIntervalMs: z.number().int().min(500).max(30000).default(2000),
  catalogRefreshOnLaunch: z.boolean().default(true),
}).default({
  theme: 'dark',
  pollIntervalMs: 2000,
  catalogRefreshOnLaunch: true,
});

const ManualGameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  exePath: z.string().min(1),
  addedAt: z.string(),
});

const CheatHotkeyOverrideSchema = z.object({
  toggle: z.string().nullable().optional(),
  inc: z.string().nullable().optional(),
  dec: z.string().nullable().optional(),
});

export const UserConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  processNameOverrides: z.record(z.string(), z.array(z.string())).default({}),
  recents: z.array(RecentTrainerSchema).max(20).default([]),
  preferences: AppPreferencesSchema,
  manualGames: z.array(ManualGameSchema).default([]),
  hotkeyOverrides: z.record(
    z.string(),
    z.record(z.string(), CheatHotkeyOverrideSchema),
  ).default({}),
}).default({
  schemaVersion: 1,
  processNameOverrides: {},
  recents: [],
  preferences: { theme: 'dark', pollIntervalMs: 2000, catalogRefreshOnLaunch: true },
  manualGames: [],
  hotkeyOverrides: {},
});

export type UserConfigInferred = z.infer<typeof UserConfigSchema>;

export interface GetConfigOpts {
  /** Called when the existing file is corrupt or schema-mismatched; receives the backup path. */
  onCorrupt?: (backupPath: string) => void;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function defaultsConfig(): UserConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return UserConfigSchema.parse({}) as any as UserConfig;
}

export async function getConfigFrom(path: string, opts: GetConfigOpts = {}): Promise<UserConfig> {
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path);
  } catch {
    // Read or parse failure: backup and reset.
    const backup = `${path}.corrupt-${Date.now()}`;
    try { await rename(path, backup); } catch { /* ignore */ }
    opts.onCorrupt?.(backup);
    return defaultsConfig();
  }
  if (raw === null) return defaultsConfig();

  const parsed = UserConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { await rename(path, backup); } catch { /* ignore */ }
    opts.onCorrupt?.(backup);
    return defaultsConfig();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parsed.data as any as UserConfig;
}

export async function updateConfigFrom(
  path: string,
  patch: import('../shared/ipc.js').DeepPartial<UserConfig>,
): Promise<UserConfig> {
  const current = await getConfigFrom(path);
  const merged = deepMerge(current, patch) as unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const validated = UserConfigSchema.parse(merged) as any as UserConfig;
  await atomicWrite(path, JSON.stringify(validated, null, 2));
  return validated;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (Array.isArray(patch)) return patch as unknown as T;          // arrays replace
  if (patch === null || typeof patch !== 'object') return patch === undefined ? base : (patch as T);
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

// --- Production singleton wrappers ---

let cached: UserConfig | null = null;
let onCorruptListener: ((backupPath: string) => void) | null = null;
export function setOnCorrupt(fn: (backupPath: string) => void): void { onCorruptListener = fn; }

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

export async function getConfig(): Promise<UserConfig> {
  if (cached) return cached;
  const opts: GetConfigOpts = {};
  if (onCorruptListener) opts.onCorrupt = onCorruptListener;
  cached = await getConfigFrom(configPath(), opts);
  return cached;
}

export async function updateConfig(
  patch: import('../shared/ipc.js').DeepPartial<UserConfig>,
): Promise<UserConfig> {
  const next = await updateConfigFrom(configPath(), patch);
  cached = next;
  return next;
}

export function clearConfigCache(): void { cached = null; }
