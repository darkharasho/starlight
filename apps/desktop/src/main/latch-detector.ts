// apps/desktop/src/main/latch-detector.ts
import type { DetectedProcess, DetectedGame } from '../shared/ipc.js';
import { identifyProcess, normalizeName, type CatalogEntry } from './game-matcher.js';
import { filterCandidates } from './process-host.js';

export interface LatchDetectorOpts {
  catalogIndex: () => Map<string, CatalogEntry>;
  detectedGames: () => DetectedGame[];
  isSessionActive: () => boolean;
  identify?: typeof identifyProcess;
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
    const candidates = filterCandidates(processes).filter((p) => /\.exe$/i.test(p.name));
    for (const p of candidates) {
      if (this.reported.has(p.pid)) continue;
      const game = await identify(p, {
        catalogIndex: this.opts.catalogIndex(),
        detectedGames: this.opts.detectedGames(),
      });
      if (game) {
        this.reported.add(p.pid);
        // Use normalizeName from game-matcher (DRY) to determine confidence.
        // Name equality after normalization => 'name'; otherwise the match came
        // from a non-name signal (steam id, window title, etc.) => 'exact'.
        const confidence = normalizeName(p.name) === normalizeName(game.name) ? 'name' : 'exact';
        return { game, pid: p.pid, name: p.name, confidence };
      }
    }
    return null;
  }

  /** Drop pids that are no longer running so relaunches re-detect. */
  prune(livePids: Set<number>): void {
    for (const pid of this.reported) if (!livePids.has(pid)) this.reported.delete(pid);
  }
}
