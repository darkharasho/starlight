import type { DetectedProcess, StarlightEvent } from '../shared/ipc.js';

export interface ProcessHostOptions {
  intervalMs: number;
  emit: (e: StarlightEvent) => void;
  isAttached: () => boolean;
  psList: () => Promise<{ pid: number; name: string }[]>;
}

function strip(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, '');
}

/**
 * Wine/Proton/Steam infrastructure and Windows system processes that show up
 * as ".exe" but are never the game the user wants to latch. Hiding these keeps
 * the attach picker to a short list of real candidates.
 */
const NOISE_PROCESSES = new Set([
  // Wine / Windows system
  'services', 'winedevice', 'plugplay', 'rpcss', 'svchost', 'conhost', 'explorer',
  'wineboot', 'winemenubuilder', 'start', 'rundll32', 'dllhost', 'csrss', 'wininit',
  'winlogon', 'lsass', 'spoolsv', 'cmd', 'iexplore', 'tabtip', 'wine', 'wineserver',
  // Steam / Proton overlay + helpers
  'steam', 'steamwebhelper', 'gameoverlayui', 'steamerrorreporter', 'xalia', 'crashpad_handler',
]);

/** True for processes that are clearly not a game the user would latch. */
export function isNoiseProcess(name: string): boolean {
  return NOISE_PROCESSES.has(strip(name));
}

/** Filters out infrastructure noise so the picker shows real game candidates. */
export function filterCandidates(procs: DetectedProcess[]): DetectedProcess[] {
  return procs.filter((p) => !isNoiseProcess(p.name));
}

export class ProcessHost {
  private timer: ReturnType<typeof setInterval> | null = null;
  private trainerNames: string[] = [];
  private lastMatchedPid: number | null = null;

  constructor(private opts: ProcessHostOptions) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs);
  }

  pause(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  resume(): void { this.start(); }

  setIntervalMs(ms: number): void {
    if (ms === this.opts.intervalMs) return;
    this.opts.intervalMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs);
    }
  }

  setTrainerProcessNames(names: string[]): void {
    this.trainerNames = names.map(strip);
    this.lastMatchedPid = null;
  }

  clearTrainer(): void {
    this.trainerNames = [];
    this.lastMatchedPid = null;
  }

  async listOnce(): Promise<DetectedProcess[]> {
    const procs = await this.opts.psList();
    return filterCandidates(procs.map(p => ({ pid: p.pid, name: p.name })));
  }

  private async tick(): Promise<void> {
    if (this.opts.isAttached()) return;
    let procs: { pid: number; name: string }[];
    try { procs = await this.opts.psList(); }
    catch { return; }
    this.opts.emit({
      type: 'process:list',
      processes: filterCandidates(procs.map(p => ({ pid: p.pid, name: p.name }))),
    });
    if (this.trainerNames.length === 0) return;
    const match = procs.find(p => {
      const ns = strip(p.name);
      return this.trainerNames.some(t => t === ns);
    });
    if (match && match.pid !== this.lastMatchedPid) {
      this.lastMatchedPid = match.pid;
      this.opts.emit({ type: 'process:matched', pid: match.pid, name: match.name });
    } else if (!match) {
      this.lastMatchedPid = null;
    }
  }
}
