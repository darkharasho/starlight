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
  // Spawn the target as a grandchild via shell backgrounding so that libuv's
  // child-process watcher does not race with frida's ptrace SIGSTOP injection.
  // The shell is the direct child; the actual target binary is the grandchild.
  const shell: ChildProcess = spawn(
    '/bin/sh',
    ['-c', `${TARGET_BINARY} & PID=$!; echo "TARGET_PID:$PID"; wait`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (!shell.stdout) throw new Error('failed to spawn shell wrapper: no stdout stream');

  const addresses: Record<string, string> = {};
  const offsets: Record<string, number> = {};
  let targetPid = 0;

  await new Promise<void>((resolveReady, rejectReady) => {
    let buf = '';
    let gotStats = false;

    // Ready only once we have BOTH the pid (from the shell wrapper) and the
    // target's stats. Their stdout lines interleave, and on a fast machine the
    // target can print its stats before the shell echoes TARGET_PID.
    const finishIfReady = (): void => {
      if (!targetPid || !gotStats) return;
      clearTimeout(timer);
      shell.stdout!.off('data', onData);
      shell.off('error', onErr);
      resolveReady();
    };

    const timer = setTimeout(() => {
      shell.stdout!.off('data', onData);
      shell.off('error', onErr);
      rejectReady(new Error('spawnTarget: timed out after 5 s waiting for pid + hp_in_stats from target binary'));
    }, 5000);

    const onErr = (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      shell.stdout!.off('data', onData);
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
        const pidMatch = line.match(/^TARGET_PID:(\d+)$/);
        if (pidMatch) { targetPid = parseInt(pidMatch[1]!); finishIfReady(); continue; }
        const a = line.match(/^addr (\w+)=(0x[0-9a-fA-F]+)$/);
        if (a) { addresses[a[1]!] = a[2]!.toLowerCase(); continue; }
        const o = line.match(/^offset (\w+)=(\d+)$/);
        if (o) {
          offsets[o[1]!] = Number(o[2]);
          if (o[1] === 'hp_in_stats') { gotStats = true; finishIfReady(); }
        }
      }
    };

    shell.once('error', onErr);
    shell.stdout!.setEncoding('utf8');
    shell.stdout!.on('data', onData);
  });

  if (!targetPid) throw new Error('failed to get target pid from shell wrapper');

  return {
    pid: targetPid,
    addresses,
    offsets,
    kill: () => new Promise((r) => {
      try { process.kill(targetPid, 'SIGTERM'); } catch (_) { /* already gone */ }
      if (shell.exitCode !== null) return r();
      shell.once('exit', () => r());
      shell.kill('SIGTERM');
    }),
  };
}
