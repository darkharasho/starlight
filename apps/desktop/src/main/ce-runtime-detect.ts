import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

export interface DetectOpts {
  runtimeRoot: string;
  /** Subdir inside runtimeRoot where the runtime is extracted. */
  extractedDir?: string;
  /** Path of the binary relative to extractedDir. */
  binaryRelative?: string;
}

export type DetectResult =
  | { status: 'ready'; installDir: string; binary: string }
  | { status: 'not-installed' };

const DEFAULT_EXTRACTED = 'CheatEngineLinux766-4';
const DEFAULT_BIN = 'cheatengine-x86_64';

export async function detectCeRuntime(opts: DetectOpts): Promise<DetectResult> {
  const installDir = join(opts.runtimeRoot, opts.extractedDir ?? DEFAULT_EXTRACTED);
  const binary = join(installDir, opts.binaryRelative ?? DEFAULT_BIN);
  try {
    await access(binary, constants.X_OK);
    return { status: 'ready', installDir, binary };
  } catch {
    return { status: 'not-installed' };
  }
}
