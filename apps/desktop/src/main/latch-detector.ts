// apps/desktop/src/main/latch-detector.ts
import type { DetectedProcess, DetectedGame } from '../shared/ipc.js';
import { identifyProcess, normalizeName, type CatalogEntry } from './game-matcher.js';
import { filterCandidates } from './process-host.js';
import { readExeName, EXE_SUFFIX } from './proc-exe-name.js';

export interface LatchDetectorOpts {
  catalogIndex: () => Map<string, CatalogEntry>;
  detectedGames: () => DetectedGame[];
  isSessionActive: () => boolean;
  identify?: typeof identifyProcess;
  /** Recover the full (untruncated) exe name for a pid. Injectable for tests. */
  resolveExeName?: (pid: number, comm: string) => Promise<string | undefined>;
}

export interface Detection {
  game: CatalogEntry;
  pid: number;
  name: string;
  confidence: 'exact' | 'name';
}

export class LatchDetector {
  private reported = new Set<number>();
  constructor(private opts: LatchDetectorOpts) {}

  async detect(processes: DetectedProcess[]): Promise<Detection | null> {
    if (this.opts.isSessionActive()) return null;
    const identify = this.opts.identify ?? identifyProcess;
    const resolveName = this.opts.resolveExeName ?? readExeName;
    const candidates = filterCandidates(processes).filter((p) => EXE_SUFFIX.test(p.name));
    for (const p of candidates) {
      if (this.reported.has(p.pid)) continue;
      // Recover the untruncated exe name so name-matching and the reported name
      // (which Windows CE later uses for openProcess) are correct.
      const name = (await resolveName(p.pid, p.name)) ?? p.name;
      const proc = { ...p, name };
      const game = await identify(proc, {
        catalogIndex: this.opts.catalogIndex(),
        detectedGames: this.opts.detectedGames(),
      });
      if (game) {
        this.reported.add(p.pid);
        // Use normalizeName from game-matcher (DRY) to determine confidence.
        // Name equality after normalization => 'name'; otherwise the match came
        // from a non-name signal (steam id, window title, etc.) => 'exact'.
        const confidence = normalizeName(name) === normalizeName(game.name) ? 'name' : 'exact';
        return { game, pid: p.pid, name, confidence };
      }
    }
    return null;
  }

  /** Drop pids that are no longer running so relaunches re-detect. */
  prune(livePids: Set<number>): void {
    for (const pid of this.reported) if (!livePids.has(pid)) this.reported.delete(pid);
  }
}
