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

export class ProcessHost {
  private timer: ReturnType<typeof setInterval> | null = null;
  private trainerNames: string[] = [];
  private lastMatchedPid: number | null = null;

  constructor(private readonly opts: ProcessHostOptions) {}

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
    return procs.map(p => ({ pid: p.pid, name: p.name }));
  }

  private async tick(): Promise<void> {
    if (this.opts.isAttached()) return;
    let procs: { pid: number; name: string }[];
    try { procs = await this.opts.psList(); }
    catch { return; }
    this.opts.emit({
      type: 'process:list',
      processes: procs.map(p => ({ pid: p.pid, name: p.name })),
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
