import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEngine, type EngineClient } from '../../src/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DAEMON_BINARY = resolve(HERE, '../../../starlightd/target/debug/starlightd');

export async function startTestEngine(): Promise<{ client: EngineClient; stop(): Promise<void> }> {
  if (!existsSync(DAEMON_BINARY)) {
    throw new Error(`starlightd binary not found at ${DAEMON_BINARY} - run \`cargo build\` in packages/starlightd`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'starlight-engine-test-'));
  const engine = await startEngine({ binary: DAEMON_BINARY, socketPath: join(dir, 'sock') });
  return {
    client: engine.client,
    stop: async () => {
      await engine.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
