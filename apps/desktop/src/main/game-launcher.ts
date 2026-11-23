import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import type { DetectedGame } from '../shared/ipc.js';

/**
 * The launcher URL that starts an installed game through its own store client
 * (so Proton, cloud saves and the overlay all behave as usual). Null when the
 * game has to be started as a plain executable.
 */
export function launchUrl(game: Pick<DetectedGame, 'source' | 'appId'>): string | null {
  const id = encodeURIComponent(game.appId);
  switch (game.source) {
    case 'steam':  return /^\d+$/.test(game.appId) ? `steam://rungameid/${game.appId}` : null;
    case 'heroic': return `heroic://launch/${id}`;
    case 'lutris': return `lutris:rungame/${id}`;
    case 'epic':   return `com.epicgames.launcher://apps/${id}?action=launch&silent=true`;
    default:       return null;
  }
}

export interface LaunchDeps {
  openExternal: (url: string) => Promise<void>;
  /** Path of a manually added game's executable, by its library id. */
  manualExePath: (appId: string) => Promise<string | null>;
  spawnDetached?: (exe: string, cwd: string) => void;
  platform?: NodeJS.Platform;
}

function defaultSpawnDetached(exe: string, cwd: string): void {
  const child = spawn(exe, [], { cwd, detached: true, stdio: 'ignore' });
  child.on('error', () => { /* reported by the caller's wait-for-process timeout */ });
  child.unref();
}

export async function launchGame(
  game: Pick<DetectedGame, 'source' | 'appId' | 'name'>,
  deps: LaunchDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const url = launchUrl(game);
    if (url) { await deps.openExternal(url); return { ok: true }; }
    if (game.source === 'manual') {
      const exe = await deps.manualExePath(game.appId);
      if (!exe) return { ok: false, error: `Starlight has no executable on record for ${game.name}.` };
      if (/\.exe$/i.test(exe) && (deps.platform ?? process.platform) !== 'win32') {
        return { ok: false, error: `${game.name} is a Windows executable added by hand — start it from your launcher, then attach.` };
      }
      (deps.spawnDetached ?? defaultSpawnDetached)(exe, dirname(exe));
      return { ok: true };
    }
    return { ok: false, error: `Starlight doesn't know how to start ${game.name} — start it yourself, then attach.` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
