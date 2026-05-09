// Requires the C test target to be built at: packages/engine/test-target/build/target
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_BINARY = resolve(HERE, '../../test-target/build/target');

export interface SpawnedTarget {
  pid: number;
  addresses: Record<string, string>;  // name -> "0x..."
  offsets: Record<string, number>;
  kill(): Promise<void>;
}

export async function spawnTarget(): Promise<SpawnedTarget> {
  const child: ChildProcess = spawn(TARGET_BINARY, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  if (!child.pid || !child.stdout) throw new Error('failed to spawn target');

  const addresses: Record<string, string> = {};
  const offsets: Record<string, number> = {};

  await new Promise<void>((resolveReady, rejectReady) => {
    let buf = '';
    const onErr = (e: Error) => rejectReady(e);
    child.once('error', onErr);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === 'READY') continue;
        const a = line.match(/^addr (\w+)=(0x[0-9a-fA-F]+)$/);
        if (a) { addresses[a[1]!] = a[2]!.toLowerCase(); continue; }
        const o = line.match(/^offset (\w+)=(\d+)$/);
        if (o) {
          offsets[o[1]!] = Number(o[2]);
          if (o[1] === 'hp_in_stats') {
            child.off('error', onErr);
            resolveReady();
            return;
          }
        }
      }
    });
  });

  return {
    pid: child.pid,
    addresses,
    offsets,
    kill: () => new Promise((r) => {
      if (child.exitCode !== null) return r();
      child.once('exit', () => r());
      child.kill('SIGTERM');
    }),
  };
}
