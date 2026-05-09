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
  if (!child.stdout) throw new Error('failed to spawn target: no stdout stream');

  const addresses: Record<string, string> = {};
  const offsets: Record<string, number> = {};

  await new Promise<void>((resolveReady, rejectReady) => {
    let buf = '';

    const timer = setTimeout(() => {
      child.stdout!.off('data', onData);
      child.off('error', onErr);
      rejectReady(new Error('spawnTarget: timed out after 5 s waiting for hp_in_stats from target binary'));
    }, 5000);

    const onErr = (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      child.stdout!.off('data', onData);
      if (e.code === 'ENOENT') {
        rejectReady(new Error(
          `spawnTarget: binary not found at ${TARGET_BINARY} — rebuild with: make -C packages/engine/test-target`,
        ));
      } else {
        rejectReady(e);
      }
    };

    const onData = (chunk: string) => {
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
            clearTimeout(timer);
            child.stdout!.off('data', onData);
            child.off('error', onErr);
            resolveReady();
            return;
          }
        }
      }
    };

    child.once('error', onErr);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', onData);
  });

  if (!child.pid) throw new Error('failed to spawn target');

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
